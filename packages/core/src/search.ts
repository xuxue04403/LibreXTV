/**
 * 客户端聚合搜索。
 *
 * 对应上游 src/app/api/search/route.ts 的服务端聚合逻辑：
 * 并行请求所有选中源 → 每个源分页抓取 → 过滤无关/成人结果 → 逐源回调。
 * 差异：这里是给客户端用的纯函数，HTTP 由调用方注入，且不再做服务端缓存。
 */

import { cmsRequestHeaders, cmsUrl, filterAdultResults, filterRelevantResults, parseSearchList } from './cms';
import { dedupeResults } from './group';
import { HttpError, type HttpClient } from './http';
import type { SearchResultItem, SourceConfig, SourceSearchOutcome } from './types';

export interface SearchOptions {
  /** 关键词 */
  wd: string;
  sources: SourceConfig[];
  http: HttpClient;
  /** 成人内容过滤（默认开启，与上游一致） */
  filterAdult?: boolean;
  /** 每个源最多抓取的页数（1-20，默认 3） */
  maxPages?: number;
  /** 单源总死线（毫秒，默认 10000） */
  timeoutMs?: number;
  /** 单源最多保留的结果数（默认 80；采集站一页常给 20-50 条，多页叠加后要设上限） */
  maxResultsPerSource?: number;
  signal?: AbortSignal;
  /** 每个源结算时回调（健康源结果不必等坏源超时） */
  onSource?: (outcome: SourceSearchOutcome) => void;
}

export interface SearchResult {
  list: SearchResultItem[];
  failures: { sourceKey: string; error: string; timedOut?: boolean }[];
  outcomes: SourceSearchOutcome[];
}

export const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
export const DEFAULT_SEARCH_MAX_PAGES = 3;
export const DEFAULT_SEARCH_MAX_RESULTS_PER_SOURCE = 80;

interface CmsSearchPage {
  list?: unknown;
  pagecount?: unknown;
}

async function searchOne(
  source: SourceConfig,
  wd: string,
  http: HttpClient,
  opts: SearchOptions
): Promise<SourceSearchOutcome> {
  const started = Date.now();
  const finish = (outcome: Omit<SourceSearchOutcome, 'ms' | 'sourceName'>): SourceSearchOutcome => ({
    ...outcome,
    sourceName: source.name,
    ms: Date.now() - started,
  });

  if (!/^https?:\/\//i.test(source.url || '')) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: '无效的源地址' });
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const maxPages = Math.min(20, Math.max(1, opts.maxPages ?? DEFAULT_SEARCH_MAX_PAGES));
  const base = source.url.replace(/\/+$/, '');
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  // 已经取消的 signal 不会补发 abort 事件：不在这里先判一次，取消就形同虚设，
  // 下面照样会把每个源都打满（改关键词/关页面的竞态很常见）。
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', abortOuter, { once: true });

  const pageUrl = (page: number) => cmsUrl(base, { ac: 'videolist', wd, pg: page });

  const fetchPage = async (page: number): Promise<CmsSearchPage> => {
    const res = await http.request(pageUrl(page), {
      headers: cmsRequestHeaders(),
      timeoutMs: Math.min(8000, timeoutMs),
      signal: controller.signal,
    });
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
    try {
      return JSON.parse(res.text) as CmsSearchPage;
    } catch {
      throw new HttpError('返回内容不是合法 JSON', res.status);
    }
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SourceSearchOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve(
        finish({
          sourceKey: source.key,
          ok: false,
          list: [],
          error: `请求超时（>${Math.round(timeoutMs / 1000)}s）`,
          timedOut: true,
        })
      );
    }, timeoutMs);
  });

  const run = async (): Promise<SourceSearchOutcome> => {
    let first: CmsSearchPage;
    try {
      first = await fetchPage(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : '失败';
      const timedOut = err instanceof HttpError && err.status === 408;
      return finish({ sourceKey: source.key, ok: false, list: [], error: message, timedOut });
    }
    let list: SearchResultItem[];
    try {
      list = parseSearchList(first, source);
    } catch (err) {
      return finish({
        sourceKey: source.key,
        ok: false,
        list: [],
        error: err instanceof Error ? err.message : '解析失败',
      });
    }

    const rawPageCount = parseInt(String(first.pagecount ?? '1'), 10);
    const pageCount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, maxPages);
    if (pageCount > 1) {
      const extra = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) => i + 2).map(async (page) => {
          try {
            return parseSearchList(await fetchPage(page), source);
          } catch {
            return [] as SearchResultItem[];
          }
        })
      );
      for (const part of extra) list.push(...part);
    }

    list = dedupeResults(list);
    list = filterRelevantResults(list, wd);
    list = filterAdultResults(list, opts.filterAdult ?? true);
    // 上限放在过滤之后：先砍数量会把可能相关的条目砍掉，留下的是无关条目
    list = list.slice(0, Math.max(1, opts.maxResultsPerSource ?? DEFAULT_SEARCH_MAX_RESULTS_PER_SOURCE));
    return finish({ sourceKey: source.key, ok: true, list });
  };

  return Promise.race([run(), deadline]).finally(() => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    opts.signal?.removeEventListener('abort', abortOuter);
  });
}

/** 聚合搜索：任一源失败不影响整体，逐源回调便于边搜边渲染 */
export async function searchSources(opts: SearchOptions): Promise<SearchResult> {
  const wd = opts.wd.trim();
  const outcomes = await Promise.all(
    opts.sources.map(async (source) => {
      const outcome = await searchOne(source, wd, opts.http, opts);
      try {
        opts.onSource?.(outcome);
      } catch {
        /* 回调异常不影响搜索 */
      }
      return outcome;
    })
  );

  const list: SearchResultItem[] = [];
  const failures: SearchResult['failures'] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) list.push(...outcome.list);
    else failures.push({ sourceKey: outcome.sourceKey, error: outcome.error || '失败', timedOut: outcome.timedOut });
  }
  return { list: dedupeResults(list), failures, outcomes };
}
