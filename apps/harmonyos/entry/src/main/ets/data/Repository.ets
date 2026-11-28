/**
 * 采集站访问层：搜索、详情、直播列表。
 *
 * 与 packages/core 的 search.ts / detail.ts / live.ts 对齐。
 * 差异：鸿蒙端一次性拿完整 m3u（不做增量流式解析），几百 KB 的列表
 * 读取本身只要 1~2 秒；但保留「逐源回调、失败源不阻塞其它源」的行为。
 */
import { CmsListResponse, parseDetail, parseDetailPageHtml, parseSearchList } from './Cms';
import { getText, NetError } from './Net';
import { describeError, UserFacingError } from './Errors';
import {
  LiveChannel,
  LiveSource,
  LiveStatus,
  SearchItem,
  VodDetail,
  VodSource,
} from '../model/Types';
import { parseM3u } from './M3u';
import { dedupeItems, filterRelevantItems } from './Relevance';
import { filterAdultItems, isAdultChannelName } from './AdultFilter';
import { originOf } from './UrlUtil';

/** 单源搜索死线：超过就放弃这个源，不能让一个死源拖住整个搜索 */
export const SEARCH_TIMEOUT_MS: number = 10_000;
/** 每源最多抓几页 */
const MAX_PAGES: number = 3;
/** 每源最多保留多少条 */
const MAX_RESULTS_PER_SOURCE: number = 80;
/** 搜索接口单次请求超时（比总死线短，给后续页留时间） */
const PAGE_TIMEOUT_MS: number = 8_000;
/** 详情接口超时 */
const DETAIL_TIMEOUT_MS: number = 9_000;
/** 单份直播列表下载超时（iptv-org 全球榜 2.5MB，限速下要慢一些） */
const LIVE_TIMEOUT_MS: number = 40_000;

export interface SearchStatus {
  sourceKey: string;
  sourceName: string;
  ok: boolean;
  count: number;
  error?: string;
  ms: number;
}

export interface SearchOneResult {
  ok: boolean;
  items: SearchItem[];
  error?: string;
  ms: number;
}

/** 搜一个源：分页 → 去重 → 相关性过滤 → 成人过滤 → 截断 */
export async function searchOne(source: VodSource, wd: string, adultFilter: boolean): Promise<SearchOneResult> {
  const started = Date.now();
  let first: CmsListResponse;
  try {
    const text = await getText(pageUrlOf(source, wd, 1), { timeoutMs: PAGE_TIMEOUT_MS });
    first = JSON.parse(text) as CmsListResponse;
  } catch (err) {
    const msg = err instanceof NetError ? err.message : describeError(err as Object);
    return { ok: false, items: [], error: msg, ms: Date.now() - started };
  }
  let items: SearchItem[];
  try {
    items = parseSearchList(first, source.key, source.name, source.url, source.isAdult);
  } catch (err) {
    return { ok: false, items: [], error: describeError(err as Object), ms: Date.now() - started };
  }
  const rawPages = first.pagecount === undefined || first.pagecount === null ? 1 : Number(first.pagecount);
  const pageCount = Math.min(Number.isFinite(rawPages) ? Math.max(1, rawPages) : 1, MAX_PAGES);
  if (pageCount > 1) {
    const tasks: Promise<SearchItem[]>[] = [];
    for (let p = 2; p <= pageCount; p++) {
      tasks.push(fetchPageItems(source, wd, p));
    }
    const parts = await Promise.all(tasks);
    for (let i = 0; i < parts.length; i++) {
      for (let j = 0; j < parts[i].length; j++) {
        items.push(parts[i][j]);
      }
    }
  }
  let list = dedupeItems(items);
  list = filterRelevantItems(list, wd);
  list = filterAdultItems(list, adultFilter);
  if (list.length > MAX_RESULTS_PER_SOURCE) {
    list = list.slice(0, MAX_RESULTS_PER_SOURCE);
  }
  return { ok: true, items: list, ms: Date.now() - started };
}

function pageUrlOf(source: VodSource, wd: string, page: number): string {
  const base = source.url.replace(/\/+$/, '');
  return `${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=${page}`;
}

async function fetchPageItems(source: VodSource, wd: string, page: number): Promise<SearchItem[]> {
  try {
    const text = await getText(pageUrlOf(source, wd, page), { timeoutMs: PAGE_TIMEOUT_MS });
    const data = JSON.parse(text) as CmsListResponse;
    return parseSearchList(data, source.key, source.name, source.url, source.isAdult);
  } catch (err) {
    // 后续页失败不影响第一页结果
    return [];
  }
}

export interface SearchAllResult {
  items: SearchItem[];
  statuses: SearchStatus[];
}

/**
 * 聚合搜索：并行打所有启用的源，任一源失败不影响整体。
 * onSource 在每个源结算时回调，界面可以边搜边渲染。
 */
export async function searchAll(
  sources: VodSource[],
  wd: string,
  adultFilter: boolean,
  onSource?: (items: SearchItem[], status: SearchStatus) => void
): Promise<SearchAllResult> {
  const keyword = wd.trim();
  const tasks: Promise<SearchOneResult>[] = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const task = withSearchDeadline(searchOne(src, keyword, adultFilter));
    if (onSource !== undefined) {
      // 每个源一结算就回调，而不是等 Promise.all 全部返回：
      // 慢源（或卡住的源）不再拖住其它源的结果，界面才能「边搜边出」。
      task.then((r: SearchOneResult): void => {
        onSource(r.items, toStatus(src, r));
      }).catch((): void => undefined);
    }
    tasks.push(task);
  }
  const results = await Promise.all(tasks);
  const all: SearchItem[] = [];
  const statuses: SearchStatus[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const src = sources[i];
    if (r.ok) {
      for (let j = 0; j < r.items.length; j++) {
        all.push(r.items[j]);
      }
    }
    statuses.push(toStatus(src, r));
  }
  return { items: dedupeItems(all), statuses: statuses };
}

function toStatus(src: VodSource, r: SearchOneResult): SearchStatus {
  return {
    sourceKey: src.key,
    sourceName: src.name,
    ok: r.ok,
    count: r.items.length,
    error: r.error,
    ms: r.ms,
  };
}

/** 单源死线：`SEARCH_TIMEOUT_MS` 之前没返回就按「失败」结算，别让一个源挂住整页 */
async function withSearchDeadline(task: Promise<SearchOneResult>): Promise<SearchOneResult> {
  let timer = -1;
  const deadline: Promise<SearchOneResult> = new Promise<SearchOneResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        items: [],
        error: `超过 ${Math.floor(SEARCH_TIMEOUT_MS / 1000)} 秒未返回`,
        ms: SEARCH_TIMEOUT_MS,
      });
    }, SEARCH_TIMEOUT_MS) as number;
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer >= 0) {
      clearTimeout(timer);
    }
  }
}

/** 拉一部影片的详情；接口拿不到分集时降级爬详情页 */
export async function fetchDetail(
  source: VodSource,
  vodId: string,
  timeoutMs: number = DETAIL_TIMEOUT_MS
): Promise<VodDetail> {
  if (!/^[\w-]+$/.test(vodId)) {
    throw new UserFacingError('无效的视频ID', 400);
  }
  const base = source.url.replace(/\/+$/, '');
  const api = `${base}?ac=videolist&ids=${encodeURIComponent(vodId)}`;
  let firstError: Object | null = null;
  let resolved: VodDetail | null = null;
  try {
    const text = await getText(api, { timeoutMs: timeoutMs });
    try {
      const detail = parseDetail(JSON.parse(text) as CmsListResponse);
      if (detail.episodes.length > 0) {
        resolved = detail;
      }
    } catch (err) {
      firstError = err as Object;
    }
  } catch (err) {
    firstError = err as Object;
  }

  if (resolved === null) {
    let detailRoot: string = source.detail ?? '';
    if (detailRoot.length === 0) {
      try {
        detailRoot = originOf(source.url);
      } catch (err) {
        detailRoot = '';
      }
    }
    detailRoot = detailRoot.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(detailRoot)) {
      const detailUrl = `${detailRoot}/index.php/vod/detail/id/${vodId}.html`;
      try {
        const html = await getText(detailUrl, { timeoutMs: timeoutMs });
        const parsed = parseDetailPageHtml(html);
        if (parsed.episodes.length > 0) {
          resolved = parsed;
        }
      } catch (err) {
        if (firstError === null) {
          firstError = err as Object;
        }
      }
    }
  }

  if (resolved === null || resolved.episodes.length === 0) {
    if (firstError !== null) {
      throw new UserFacingError(describeError(firstError), 502);
    }
    throw new UserFacingError('未找到播放资源', 404);
  }
  return resolved;
}

export interface LiveLoadResult {
  channels: LiveChannel[];
  statuses: LiveStatus[];
  bytes: number;
}

/** 拉一个直播源并解析成频道列表 */
export async function loadLiveOne(source: LiveSource, timeoutMs: number = LIVE_TIMEOUT_MS): Promise<LiveLoadResult> {
  try {
    const text = await getText(source.url, { timeoutMs: timeoutMs });
    const channels = parseM3u(text, source.url, source.key, source.name);
    // 直播链路也要过成人过滤：m3u 清单里混进的成人台此前会直接出现在网格里。
    const kept = channels.filter((c: LiveChannel) => !isAdultChannelName(c.name, c.group));
    return {
      channels: kept,
      statuses: [{ sourceKey: source.key, sourceName: source.name, ok: true, count: kept.length }],
      bytes: text.length,
    };
  } catch (err) {
    const msg = err instanceof NetError ? err.message : describeError(err as Object);
    return {
      channels: [],
      statuses: [{ sourceKey: source.key, sourceName: source.name, ok: false, count: 0, error: msg }],
      bytes: 0,
    };
  }
}

/**
 * 拉多个直播源：清单顺序即优先级，前面的源先到先占，
 * 跨源同名台只留排在前面的那条（与 Android 端 dedupeChannels 一致）。
 */
export async function loadLiveAll(
  sources: LiveSource[],
  onProgress?: (status: LiveStatus, totalBytes: number) => void
): Promise<LiveLoadResult> {
  const results: LiveLoadResult[] = [];
  for (let i = 0; i < sources.length; i++) {
    const r = await loadLiveOne(sources[i]);
    results.push(r);
    if (onProgress !== undefined && r.statuses.length > 0) {
      onProgress(r.statuses[0], totalBytesOf(results));
    }
  }
  const channels: LiveChannel[] = [];
  const statuses: LiveStatus[] = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = 0; j < results[i].channels.length; j++) {
      channels.push(results[i].channels[j]);
    }
    for (let j = 0; j < results[i].statuses.length; j++) {
      statuses.push(results[i].statuses[j]);
    }
  }
  return { channels: channels, statuses: statuses, bytes: totalBytesOf(results) };
}

function totalBytesOf(results: LiveLoadResult[]): number {
  let n = 0;
  for (let i = 0; i < results.length; i++) {
    n += results[i].bytes;
  }
  return n;
}
