/**
 * 多播放源自动切换（失败转移）。
 *
 * 一部影片在聚合搜索里通常对应多个采集站，它们的播放地址互不相同。
 * 上游 LibreTV 只让用户手动换源；实际使用中更常见的是「这个源的分片挂了」，
 * 用户想要的是一路播下去。这里提供与平台无关的纯逻辑：
 * - 把搜索结果里的同片源候选整理成有序候选链（当前源优先）；
 * - 某一集失败时按顺序挑下一个没试过的候选；
 * - 换源时尽量停在同一集（集数下标对齐，越界则夹紧）。
 *
 * 平台侧（Electron 渲染层 / Android TV）只负责「什么时候判定失败」，
 * 候选链的构造与前进顺序都由这里决定，保证两端行为一致。
 */

import { fetchDetail } from './detail';
import { clampEpisodeIndex } from './format';
import type { HttpClient } from './http';
import { isSameShow, normalizeTitle } from './cms';
import { searchSources } from './search';
import type { SearchResultItem, SearchResultItem as SearchItem, SourceConfig, VideoDetail } from './types';

/** 一个可尝试的播放源：源配置 + 该源自己的影片 id */
export interface PlaybackCandidate {
  sourceKey: string;
  sourceName: string;
  vodId: string;
  source: SourceConfig;
}

/** 候选的唯一标识（同一源下的同一影片） */
export function candidateKey(candidate: { sourceKey: string; vodId: string }): string {
  return `${candidate.sourceKey}:${candidate.vodId}`;
}

/**
 * 搜索结果项 → 源配置。
 *
 * 用户删掉某个源之后历史/收藏里仍可能残留条目，此时用条目自带的
 * `sourceUrl` 兜底；连它也没有就返回 null，交给调用方跳过。
 */
export function resolveCandidateSource(item: SearchItem, sources: SourceConfig[]): SourceConfig | null {
  const found = sources.find((source) => source.key === item.sourceKey);
  if (found) return found;
  if (!item.sourceUrl) return null;
  return {
    key: item.sourceKey,
    name: item.sourceName,
    url: item.sourceUrl,
    isAdult: item.isAdult,
  };
}

export interface BuildCandidatesOptions {
  /** 置顶的候选（当前正在播放的源），会被移到第一位 */
  active?: { sourceKey: string; vodId: string } | null;
  /** 最多保留多少个候选，默认 8（够覆盖常见聚合结果，又不会把失败检测拖太久） */
  limit?: number;
}

/** 单条候选链的最大长度 */
export const MAX_PLAYBACK_CANDIDATES = 8;

/**
 * 把同片源搜索结果整理成候选链。
 *
 * 规则：
 * - 去重（同一源 + 同一 vodId 只留一条）；
 * - 能解析出源配置的才保留（没有接口地址的源拿不到详情，留着只会白等一次超时）；
 * - **按源轮转排序**：先每个源各取一条，再回头取第二条……
 *   同一部片子在一个采集站里常有多个版本（「沙丘」「沙丘2」「沙丘 国语」），
 *   若按搜索结果原顺序取满 8 条，整条链可能全来自同一个站，
 *   而换源要解决的恰恰是「这个站整体挂了」，那样一条都换不出去；
 * - 当前正在播放的候选排在最前。
 */
export function buildPlaybackCandidates(
  items: readonly SearchItem[],
  sources: SourceConfig[],
  opts: BuildCandidatesOptions = {}
): PlaybackCandidate[] {
  const limit = Math.max(1, opts.limit ?? MAX_PLAYBACK_CANDIDATES);
  const seen = new Set<string>();
  /** 源 key → 该源下的候选，保持首次出现顺序 */
  const bySource = new Map<string, PlaybackCandidate[]>();

  for (const item of items) {
    const key = candidateKey(item);
    if (seen.has(key)) continue;
    const source = resolveCandidateSource(item, sources);
    if (!source || !/^https?:\/\//i.test(source.url || '')) continue;
    seen.add(key);
    const candidate: PlaybackCandidate = {
      sourceKey: item.sourceKey,
      sourceName: item.sourceName || source.name,
      vodId: item.vodId,
      source,
    };
    const bucket = bySource.get(item.sourceKey);
    if (bucket) bucket.push(candidate);
    else bySource.set(item.sourceKey, [candidate]);
  }

  const buckets = [...bySource.values()];
  const out: PlaybackCandidate[] = [];
  const deepest = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0);
  for (let round = 0; round < deepest && out.length < limit; round += 1) {
    for (const bucket of buckets) {
      if (out.length >= limit) break;
      const candidate = bucket[round];
      if (candidate) out.push(candidate);
    }
  }

  const active = opts.active;
  if (!active) return out;

  const activeKey = candidateKey(active);
  const index = out.findIndex((candidate) => candidateKey(candidate) === activeKey);
  if (index <= 0) return out;
  const [first] = out.splice(index, 1);
  out.unshift(first);
  return out;
}

/**
 * 下一集/换源时的集数对齐。
 *
 * 各采集站的分集编号不一定一一对应（有的把预告算一集），所以换源时
 * 尽量停在同一集；越界就夹到最后一集 —— 比直接回到第一集友好得多。
 */
export function pickEpisodeIndex(preferred: number, length: number): number {
  // 与 format.ts 的 clampEpisodeIndex 是同一件事，直接复用那一个：
  // 两份实现迟早会漂移（这里原来漏了 `Number.isFinite(length)`，
  // length 为 NaN 时返回 NaN，下游 `episodes[NaN]` 就是 undefined）。
  return clampEpisodeIndex(preferred, length);
}

/** 按顺序找出第一个还没试过的候选；全部试过返回 undefined */
export function nextUntriedCandidate(
  candidates: readonly PlaybackCandidate[],
  tried: ReadonlySet<string>
): PlaybackCandidate | undefined {
  return candidates.find((candidate) => !tried.has(candidateKey(candidate)));
}

export interface CandidatePlayback {
  candidate: PlaybackCandidate;
  detail: VideoDetail;
  /** 对齐后的集数下标 */
  index: number;
}

export interface ResolveCandidateOptions {
  /** 期望停在第几集（会按目标源的集数夹紧） */
  episodeIndex?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 拉取候选源的详情并对齐集数；拿不到可播地址时抛错，由调用方继续下一个候选。
 */
export async function resolveCandidatePlayback(
  candidate: PlaybackCandidate,
  http: HttpClient,
  opts: ResolveCandidateOptions = {}
): Promise<CandidatePlayback> {
  const detail = await fetchDetail(candidate.source, candidate.vodId, http, {
    timeoutMs: opts.timeoutMs ?? 8_000,
    signal: opts.signal,
  });
  if (detail.episodes.length === 0) throw new Error('该片源暂无可用播放地址');
  return {
    candidate,
    detail,
    index: pickEpisodeIndex(opts.episodeIndex ?? 0, detail.episodes.length),
  };
}

/**
 * 依次尝试候选链，返回第一个能拿到播放地址的结果。
 *
 * `onSkip` 用于把「某个源失败」反馈到界面（自动换源时给个提示），
 * 回调异常不影响整体流程。
 */
export async function firstPlayableCandidate(
  candidates: readonly PlaybackCandidate[],
  http: HttpClient,
  opts: ResolveCandidateOptions & { onSkip?: (candidate: PlaybackCandidate, error: Error) => void } = {}
): Promise<CandidatePlayback> {
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return await resolveCandidatePlayback(candidate, http, opts);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('获取播放地址失败');
      try {
        opts.onSkip?.(candidate, lastError);
      } catch {
        /* 回调异常不影响换源 */
      }
    }
  }
  throw lastError ?? new Error('没有可用的播放源');
}

/** 供 UI 展示的简短源名（避免徽章被超长源名撑破） */
export function candidateLabel(candidate: { sourceName: string }, maxLength = 12): string {
  const name = (candidate.sourceName || '').trim();
  if (name.length <= maxLength) return name || '未知来源';
  return `${name.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * 按片名反查其它可用源。
 *
 * 从「观看记录」「收藏」进入播放时手里只有一个源，没有聚合结果，
 * 一旦这个源挂了就无路可走。这里用片名再搜一轮，把其它源的同名影片
 * 补进候选链 —— 只在候选全部失败后才调用，不影响正常起播速度。
 */
export async function discoverCandidates(
  title: string,
  sources: SourceConfig[],
  http: HttpClient,
  opts: {
    /** 已经试过的键，结果里会被剔除 */
    exclude?: ReadonlySet<string>;
    maxPages?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<PlaybackCandidate[]> {
  // 搜索词用**原片名**：采集站的接口是 `LIKE '%wd%'`，
  // 归一化后的 `thematrix`（去空格去标点）几乎匹配不到 `The Matrix`。
  // 归一化只用于比对结果，不能用来查询。
  const keyword = title.trim();
  if (!keyword || sources.length === 0) return [];

  const result = await searchSources({
    wd: keyword,
    sources,
    http,
    maxPages: opts.maxPages ?? 1,
    timeoutMs: opts.timeoutMs ?? 8_000,
    signal: opts.signal,
    filterAdult: false,
  });

  // 同一部片子在不同采集站的命名常带「国语」「高清」等前缀后缀，
  // 用归一化标题做包含判断比完全相等更实用。
  // 但**必须**过季数：换源是自动的，把「庆余年2」当成「庆余年」等于静默播错内容。
  const exclude = opts.exclude ?? new Set<string>();
  const wanted = normalizeTitle(keyword).toLowerCase();
  const items = result.outcomes
    .flatMap((outcome) => outcome.list)
    .filter((item) => {
      if (exclude.has(candidateKey(item))) return false;
      return isSameShow(item.name, keyword);
    })
    // 完全相同排前面：候选链按源轮转，弱匹配抢在正片前就会被优先切过去
    .sort((a, b) => rankMatch(a.name, wanted) - rankMatch(b.name, wanted));

  return buildPlaybackCandidates(items, sources, { limit: MAX_PLAYBACK_CANDIDATES });
}

/** 0 = 完全同名，1 = 同片但带前缀/后缀季数差异 */
function rankMatch(name: string, wanted: string): number {
  return normalizeTitle(name).toLowerCase() === wanted ? 0 : 1;
}

export type { SearchResultItem };
