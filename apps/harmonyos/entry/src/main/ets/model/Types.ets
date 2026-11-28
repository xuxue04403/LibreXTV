/**
 * 鸿蒙版的数据模型。
 *
 * 与 Android 版 org.librextv.tv.data.Models 保持同构，便于两端对照维护：
 * 字段含义、key 生成规则（builtin_N / builtin_live_N）完全一致。
 */

/** 点播源（Apple CMS 采集接口） */
export interface VodSource {
  key: string;
  name: string;
  url: string;
  detail?: string;
  isAdult: boolean;
  builtin: boolean;
  /** 内置源「默认不启用」的原因（如「大陆直连不通」），设置页解释给用户看 */
  note?: string;
}

/** 直播源（M3U 播放列表） */
export interface LiveSource {
  key: string;
  name: string;
  url: string;
  epg?: string;
  builtin: boolean;
  note?: string;
}

/** 一条搜索结果 */
export interface SearchItem {
  sourceKey: string;
  sourceName: string;
  vodId: string;
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  sourceUrl?: string;
  isAdult?: boolean;
}

/** 按片名聚合后的一组结果（同名不同源） */
export interface SearchGroup {
  name: string;
  items: SearchItem[];
}

/** 单个源的搜索结算情况，用于给用户解释「为什么少了一个源」 */
export interface SearchOutcome {
  sourceKey: string;
  sourceName: string;
  ok: boolean;
  count: number;
  error?: string;
  ms: number;
}

/** 一部影片的详情 */
export interface VodDetail {
  episodes: string[];
  title?: string;
  cover?: string;
  desc?: string;
  typeName?: string;
  year?: string;
  area?: string;
  actor?: string;
  remarks?: string;
}

/** 一个直播频道 */
export interface LiveChannel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  sourceKey: string;
  sourceName: string;
}

/** 单个直播源的加载情况 */
export interface LiveStatus {
  sourceKey: string;
  sourceName: string;
  ok: boolean;
  count: number;
  error?: string;
}

/** 观看记录 */
export interface HistoryEntry {
  id: string;
  sourceKey: string;
  vodId: string;
  title: string;
  cover?: string;
  sourceName: string;
  episodeIndex: number;
  episodeCount: number;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
}

/** 点播收藏 */
export interface FavoriteEntry {
  id: string;
  sourceKey: string;
  vodId: string;
  title: string;
  cover?: string;
  createdAt: number;
}

/** 直播收藏 */
export interface LiveFavoriteEntry {
  url: string;
  name: string;
  logo?: string;
  createdAt: number;
}

/** 播放开关 */
export interface AppSettings {
  adultFilter: boolean;
  autoplayNext: boolean;
  resumePlayback: boolean;
}

/** 全部持久化数据 */
export interface AppData {
  sources: VodSource[];
  selected: string[];
  liveSources: LiveSource[];
  liveSelected: string[];
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  liveFavorites: LiveFavoriteEntry[];
  settings: AppSettings;
  seeded: boolean;
  defaultsVersion: number;
  removedDefaultUrls: string[];
}

/** 清单文件的形状（defaults/sources.json） */
export interface DefaultsEntryVod {
  name: string;
  url: string;
  detail?: string;
  isAdult?: boolean;
  selected?: boolean;
  note?: string;
}

export interface DefaultsEntryLive {
  name: string;
  url: string;
  epg?: string;
  selected?: boolean;
  note?: string;
}

export interface DefaultsFile {
  name?: string;
  version?: number;
  notice?: string;
  sources: DefaultsEntryVod[];
  liveSources: DefaultsEntryLive[];
}

/** 页面路由 */
export enum PageId {
  Home = 0,
  Search = 1,
  Live = 2,
  Settings = 3,
  Detail = 4,
  Player = 5,
  LivePlayer = 6,
}

/** 默认设置 */
export function defaultSettings(): AppSettings {
  return { adultFilter: true, autoplayNext: true, resumePlayback: true };
}

/** 空数据（首次启动、读取失败时的兜底） */
export function emptyData(): AppData {
  return {
    sources: [],
    selected: [],
    liveSources: [],
    liveSelected: [],
    history: [],
    favorites: [],
    liveFavorites: [],
    settings: defaultSettings(),
    seeded: false,
    defaultsVersion: 0,
    removedDefaultUrls: [],
  };
}

/** 播放候选：换源时按这个顺序逐个试 */
export interface PlaybackCandidate {
  sourceKey: string;
  sourceName: string;
  vodId: string;
}
