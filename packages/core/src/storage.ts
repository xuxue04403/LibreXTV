/**
 * 本地状态模型与纯函数（历史 / 收藏 / 设置导入导出）。
 *
 * 上游把观看进度放在浏览器 IndexedDB（src/lib/db.ts），
 * 客户端这边由宿主注入持久化（桌面 localStorage、TV DataStore），
 * 这里只提供与存储无关的数据结构与变更函数，便于双端共享语义与单测。
 */

import type {
  AppSettings,
  FavoriteEntry,
  HistoryEntry,
  LiveFavoriteEntry,
  LiveSourceConfig,
  SourceConfig,
} from './types';
import { normalizeTitle } from './cms';
import { clampEpisodeIndex, hostnameOf } from './format';

export const DEFAULT_SETTINGS: AppSettings = {
  adultFilter: true,
  adFilter: true,
  autoplayNext: true,
  theme: 'dark',
  resumePlayback: true,
  // 与上游一致：默认关闭，用户明确开启才放大
  volumeBoost: false,
  autoSkip: true,
  homeRecommend: true,
  // 默认影视榜单：豆瓣接口偶发限流、封面防盗链也最重；榜单数据最完整
  recommendSource: 'hot-list',
};

export const HISTORY_LIMIT = 200;
export const FAVORITE_LIMIT = 500;

/** 设置快照（导入/导出用） */
export interface AppSnapshot {
  version: 1;
  settings: AppSettings;
  sources: SourceConfig[];
  selectedKeys: string[];
  liveSources: LiveSourceConfig[];
  liveSelectedKeys: string[];
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  liveFavorites: LiveFavoriteEntry[];
}

export function historyId(sourceKey: string, vodId: string): string {
  return `${sourceKey}:${vodId}`;
}

/**
 * 观看记录的分组键：同一部影片只留一条记录。
 *
 * 记录本身的 `id` 是 `${sourceKey}:${vodId}`（续播要靠它定位到具体哪个源），
 * 但「继续观看」是按影片排的：同一部片子先从非凡资源播、后从量子资源播，
 * 按 id 去重就会留下两张一模一样的卡片。所以去重改按归一化片名 + 年份做。
 *
 * 为什么必须带年份：`西游记`、`射雕英雄传`、`红楼梦` 这类片名在采集站有多个年份的
 * 版本互不相同的片子，只按片名合并会把用户另一部剧的记录**直接删掉**。
 * 老记录没有 year 字段，这时退回「只按片名」，保证升级前的数据仍然能合并。
 */
export function historyGroupKey(title: string, year?: string): string {
  const normalized = normalizeTitle(title);
  const y = (year ?? '').trim();
  return y ? `${normalized}|${y}` : normalized;
}

/**
 * 两条记录是否指同一部片子：片名归一化后相同，且年份不冲突。
 *
 * 任一方缺年份就按片名算同一部——旧数据没存年份，如果严格要求年份相等，
 * 升级后同一次播放会产生「带年份」和「不带年份」两条记录。
 */
export function isSameWork(
  a: Pick<HistoryEntry, 'title' | 'year'>,
  b: Pick<HistoryEntry, 'title' | 'year'>
): boolean {
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  const ay = (a.year ?? '').trim();
  const by = (b.year ?? '').trim();
  if (!ay || !by) return true;
  return ay === by;
}

/** 写入/更新观看进度：按「影片」去重（跨源）、移到最前、裁剪上限 */
export function upsertHistory(
  list: HistoryEntry[],
  entry: Omit<HistoryEntry, 'updatedAt'> & { updatedAt?: number },
  limit = HISTORY_LIMIT
): HistoryEntry[] {
  const item: HistoryEntry = { ...entry, updatedAt: entry.updatedAt ?? Date.now() };
  const rest = list.filter((h) => h.id !== item.id && !isSameWork(h, item));
  return [item, ...rest].slice(0, limit);
}

/**
 * 把记录里的集数夹进 `[0, episodeCount-1]`。
 *
 * 「看完一集」原本会把 `episodeIndex` 推到 `episodeCount`（见播放页的 finished 分支），
 * 于是首页卡片出现「第 17 / 16 集」这种自相矛盾的数字，而且各处 `Math.min`
 * 兜的边界不同，很容易演成「显示第 15 集、实际播第 2 集」。
 * 读取时统一走这里，历史数据即使已经越界也能正确显示。
 */
export function normalizeHistoryEntry(entry: HistoryEntry): HistoryEntry {
  if (!Number.isFinite(entry.episodeCount) || entry.episodeCount <= 0) return entry;
  const index = clampEpisodeIndex(entry.episodeIndex, entry.episodeCount);
  return index === entry.episodeIndex ? entry : { ...entry, episodeIndex: index };
}

/**
 * 清理历史里已有的重复记录（老版本按 id 去重留下的）。
 *
 * 列表按时间倒序，同一部片子只保留最靠前的那条（也就是最近播放的），
 * 幂等，可以在每次启动时跑一遍。
 */
export function dedupeHistory(list: HistoryEntry[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const h of list) {
    if (out.some((kept) => isSameWork(kept, h))) continue;
    out.push(h);
  }
  return out;
}

/** 取续播信息：同一影片返回上次的集数与位置 */
export function findResumePoint(
  list: HistoryEntry[],
  sourceKey: string,
  vodId: string
): HistoryEntry | undefined {
  const id = historyId(sourceKey, vodId);
  return list.find((h) => h.id === id);
}

/**
 * 按片名查续播（跨源）。
 *
 * 详情页一次只能选中一个源，而上次可能是在另一个源上播的；
 * 按 id 查不到时用它兜底，否则「继续播放」按钮不会出现。
 */
export function findResumeByTitle(
  list: HistoryEntry[],
  title: string,
  year?: string
): HistoryEntry | undefined {
  return list.find((h) => isSameWork(h, { title, year }));
}

/** 收藏开关：已存在则移除，否则置顶插入 */
export function toggleFavorite(list: FavoriteEntry[], entry: Omit<FavoriteEntry, 'createdAt'>, limit = FAVORITE_LIMIT): FavoriteEntry[] {
  const exists = list.some((f) => f.id === entry.id);
  if (exists) return list.filter((f) => f.id !== entry.id);
  return [{ ...entry, createdAt: Date.now() }, ...list].slice(0, limit);
}

/**
 * 直播收藏开关。
 *
 * 之前没有条数上限：一个带两万频道的源，用户逐个收藏就能把整份快照撑到
 * localStorage 配额之外，落盘失败后连观看记录一起丢。这里与点播收藏共用
 * `FAVORITE_LIMIT`。
 */
export function toggleLiveFavorite(
  list: LiveFavoriteEntry[],
  entry: Omit<LiveFavoriteEntry, 'createdAt'>,
  limit = FAVORITE_LIMIT
): LiveFavoriteEntry[] {
  const exists = list.some((f) => f.url === entry.url);
  if (exists) return list.filter((f) => f.url !== entry.url);
  return [{ ...entry, createdAt: Date.now() }, ...list].slice(0, limit);
}

export function isFavorite(list: FavoriteEntry[], id: string): boolean {
  return list.some((f) => f.id === id);
}

export function isLiveFavorite(list: LiveFavoriteEntry[], url: string): boolean {
  return list.some((f) => f.url === url);
}

/** 合并设置（缺字段用默认值补齐，兼容旧快照） */
export function normalizeSettings(raw: unknown): AppSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>;
  return {
    adultFilter: typeof obj.adultFilter === 'boolean' ? obj.adultFilter : DEFAULT_SETTINGS.adultFilter,
    adFilter: typeof obj.adFilter === 'boolean' ? obj.adFilter : DEFAULT_SETTINGS.adFilter,
    autoplayNext: typeof obj.autoplayNext === 'boolean' ? obj.autoplayNext : DEFAULT_SETTINGS.autoplayNext,
    theme: obj.theme === 'light' || obj.theme === 'system' || obj.theme === 'dark' ? obj.theme : DEFAULT_SETTINGS.theme,
    resumePlayback:
      typeof obj.resumePlayback === 'boolean' ? obj.resumePlayback : DEFAULT_SETTINGS.resumePlayback,
    volumeBoost: typeof obj.volumeBoost === 'boolean' ? obj.volumeBoost : DEFAULT_SETTINGS.volumeBoost,
    autoSkip: typeof obj.autoSkip === 'boolean' ? obj.autoSkip : DEFAULT_SETTINGS.autoSkip,
    homeRecommend: typeof obj.homeRecommend === 'boolean' ? obj.homeRecommend : DEFAULT_SETTINGS.homeRecommend,
    recommendSource:
      obj.recommendSource === 'bangumi' || obj.recommendSource === 'hot-list' || obj.recommendSource === 'douban'
        ? obj.recommendSource
        : DEFAULT_SETTINGS.recommendSource,
  };
}

/** 生成导出快照 */
export function buildSnapshot(state: Omit<AppSnapshot, 'version'>): AppSnapshot {
  return { version: 1, ...state };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim());
}

/**
 * 把任意对象收敛成一条观看记录；不合法返回 null。
 *
 * 这里必须逐字段校验：旧实现直接 `as HistoryEntry[]`，于是 `{"title":null}`
 * 这类手改/损坏的备份会在 `normalizeTitle(title)` 处抛
 * `TypeError: s.toLowerCase is not a function`，而它发生在事件回调里，
 * ErrorBoundary 接不住，只能白屏。
 */
function toHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const sourceKey = isNonEmptyString(obj.sourceKey) ? obj.sourceKey : '';
  const vodId = isNonEmptyString(obj.vodId) ? String(obj.vodId) : '';
  const title = isNonEmptyString(obj.title) ? obj.title : '';
  // 缺 sourceKey/vodId/title 的记录既不能续播也不能展示，直接丢弃
  if (!sourceKey || !vodId || !title) return null;
  const episodeIndex = Number.isFinite(Number(obj.episodeIndex)) ? Math.max(0, Math.trunc(Number(obj.episodeIndex))) : 0;
  const episodeCount = Number.isFinite(Number(obj.episodeCount)) ? Math.max(0, Math.trunc(Number(obj.episodeCount))) : 0;
  return normalizeHistoryEntry({
    id: `${sourceKey}:${vodId}`,
    sourceKey,
    vodId,
    title,
    year: isNonEmptyString(obj.year) ? obj.year : undefined,
    cover: isNonEmptyString(obj.cover) ? obj.cover : undefined,
    sourceName: isNonEmptyString(obj.sourceName) ? obj.sourceName : sourceKey,
    episodeIndex,
    episodeCount,
    episodeUrl: isNonEmptyString(obj.episodeUrl) ? obj.episodeUrl : undefined,
    position: Number.isFinite(Number(obj.position)) ? Math.max(0, Number(obj.position)) : 0,
    duration: Number.isFinite(Number(obj.duration)) ? Math.max(0, Number(obj.duration)) : 0,
    updatedAt: Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : Date.now(),
  });
}

function toFavoriteEntry(raw: unknown): FavoriteEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const sourceKey = isNonEmptyString(obj.sourceKey) ? obj.sourceKey : '';
  const vodId = isNonEmptyString(obj.vodId) ? String(obj.vodId) : '';
  const title = isNonEmptyString(obj.title) ? obj.title : '';
  if (!sourceKey || !vodId || !title) return null;
  return {
    id: `${sourceKey}:${vodId}`,
    sourceKey,
    vodId,
    title,
    year: isNonEmptyString(obj.year) ? obj.year : undefined,
    cover: isNonEmptyString(obj.cover) ? obj.cover : undefined,
    createdAt: Number.isFinite(Number(obj.createdAt)) ? Number(obj.createdAt) : Date.now(),
  };
}

function toLiveFavoriteEntry(raw: unknown): LiveFavoriteEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.url) || !isNonEmptyString(obj.name)) return null;
  return {
    url: obj.url,
    name: obj.name,
    logo: isNonEmptyString(obj.logo) ? obj.logo : undefined,
    group: isNonEmptyString(obj.group) ? obj.group : undefined,
    createdAt: Number.isFinite(Number(obj.createdAt)) ? Number(obj.createdAt) : Date.now(),
  };
}

/** 逐条规范化 + 去掉重复 id（保留靠前的那条）+ 套上限 */
function normalizeList<T>(raw: unknown, convert: (item: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of raw) {
    const entry = convert(item);
    if (!entry) continue;
    const key = (entry as { id?: string; url?: string }).id ?? (entry as { url?: string }).url ?? '';
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 源列表去重（按 url）+ 只保留 http(s) 地址。
 *
 * **必须逐字段重建，不能 `{ ...obj, url }` 透传**：快照是用户手改/跨版本导入的
 * 外部输入，`name` 缺失或不是字符串（`{"key":"a","url":"http://x","name":123}`）
 * 会一路进入 `SourceConfig.name: string`。之后任何一次搜索结果渲染走
 * `group.ts` 的 `a.sourceName.localeCompare(...)` 就抛 TypeError，聚合列表白屏，
 * 而且状态已经落盘，重启后依旧白屏——用户只能清数据。同文件的
 * `toHistoryEntry`/`toFavoriteEntry`/`toLiveFavoriteEntry` 都是逐字段重建的，
 * 唯独这里漏了，属于同一条约定没贯彻到底。
 */
function normalizeSources<T extends SourceConfig | LiveSourceConfig>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (!isNonEmptyString(obj.key) || !isHttpUrl(obj.url)) continue;
    const url = obj.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    const name = isNonEmptyString(obj.name) ? obj.name.trim() : hostnameOf(url);
    const entry: Record<string, unknown> = { key: obj.key, name, url };
    // 可选字段只在类型正确时带上；类型不对就当成没有，交给下游默认值
    if (isHttpUrl(obj.detail)) entry.detail = obj.detail.trim();
    if (obj.isAdult === true) entry.isAdult = true;
    if (isNonEmptyString(obj.note)) entry.note = obj.note;
    if (isNonEmptyString(obj.epg)) entry.epg = obj.epg.trim();
    out.push(entry as unknown as T);
  }
  return out;
}

/**
 * 校验并规范化导入快照；返回 null 表示不是可识别的快照。
 *
 * 与旧实现的关键差别：**不能什么 JSON 都当合法快照**。
 * 旧逻辑对 `{}`、`{"foo":1}`、被截断的备份都返回「合法但全空」的快照，
 * 调用方随即 `replaceAll` 覆盖本地状态，且不重置 `defaultsSeeded`，
 * 于是「导入」变成一键清空全部源/历史/收藏的唯一路径。
 * 现在要求至少包含一项可用内容，且所有条目逐字段校验、去重、裁剪上限。
 */
export function parseSnapshot(text: string): AppSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Partial<AppSnapshot> & { customAPIs?: SourceConfig[] };

  const sources = normalizeSources<SourceConfig>(Array.isArray(obj.sources) ? obj.sources : obj.customAPIs);
  const liveSources = normalizeSources<LiveSourceConfig>(obj.liveSources);
  const history = normalizeList(obj.history, toHistoryEntry, HISTORY_LIMIT);
  const favorites = normalizeList(obj.favorites, toFavoriteEntry, FAVORITE_LIMIT);
  const liveFavorites = normalizeList(obj.liveFavorites, toLiveFavoriteEntry, FAVORITE_LIMIT);

  // 一项可用内容都没有：这不是 LibreXTV 快照（或已被截断），调用方不能拿它覆盖本地数据
  if (sources.length + liveSources.length + history.length + favorites.length + liveFavorites.length === 0) {
    return null;
  }

  // 选中项必须和真实存在的源求交：导入一份删过源的旧快照时，残留的 key
  // 会永远停留在「已选中」却对应不到任何源，设置页显示的启用数对不上、
  // 搜索也不发请求，用户只会看到「明明勾着却搜不到」。
  const vodKeys = new Set(sources.map((s) => s.key));
  const liveKeys = new Set(liveSources.map((s) => s.key));

  return {
    version: 1,
    settings: normalizeSettings(obj.settings),
    sources,
    selectedKeys: Array.isArray(obj.selectedKeys)
      ? obj.selectedKeys.filter((k): k is string => typeof k === 'string' && vodKeys.has(k))
      : sources.map((s) => s.key),
    liveSources,
    liveSelectedKeys: Array.isArray(obj.liveSelectedKeys)
      ? obj.liveSelectedKeys.filter((k): k is string => typeof k === 'string' && liveKeys.has(k))
      : [],
    history,
    favorites,
    liveFavorites,
  };
}

export function serializeSnapshot(snapshot: AppSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
