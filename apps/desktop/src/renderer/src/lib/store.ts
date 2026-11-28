import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  DEFAULTS_VERSION,
  DEFAULT_DISABLED_KEYS,
  DEFAULT_LIVE_DISABLED_KEYS,
  DEFAULT_LIVE_SELECTED_KEYS,
  DEFAULT_LIVE_SOURCES,
  DEFAULT_SELECTED_KEYS,
  DEFAULT_SOURCES,
  LIVE_SELECTION_VERSION,
  VOD_SELECTION_VERSION,
} from './defaults';
import {
  DEFAULT_SETTINGS,
  clearSourceHealth,
  dedupeHistory as dedupeHistoryList,
  normalizeSettings,
  normalizeSkipMarks,
  normalizeSubscriptions,
  pruneSourceHealth,
  recordSourceFailure,
  recordSourceSuccess,
  stableKey,
  SUBSCRIPTION_FAIL_THRESHOLD,
  toggleFavorite as toggleFavoriteList,
  toggleLiveFavorite as toggleLiveFavoriteList,
  upsertHistory,
  type AppSettings,
  type FavoriteEntry,
  type HistoryEntry,
  type LiveFavoriteEntry,
  type LiveSourceConfig,
  type SkipMarks,
  type SkipMarkMap,
  type SourceConfig,
  type SourceDisableEvent,
  type SourceHealthMap,
  type SubscriptionEntry,
} from '@librextv/core';
import { liveCacheKey, readLiveCache } from './live-cache';

/** 取 URL 的 host；解析不了就返回空串（用于删直播源时按域名兜底清收藏） */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export interface AppState {
  settings: AppSettings;
  sources: SourceConfig[];
  selectedKeys: string[];
  liveSources: LiveSourceConfig[];
  liveSelectedKeys: string[];
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  liveFavorites: LiveFavoriteEntry[];
  recentSearches: string[];
  /** 是否已完成首次启动的内置默认源导入 */
  defaultsSeeded: boolean;
  /**
   * 已经同步过的内置源清单版本（见 `defaults/sources.json` 的 `version`）。
   *
   * 光有 `defaultsSeeded` 布尔量不够：老用户早就 seeded 过，新增的内置源
   * 永远进不来。这个数字让「内置源升级」只在版本前进时补一次。
   */
  defaultsVersion: number;
  /** 用户主动删掉的内置源地址：升级补源时不要把它们又塞回来 */
  removedDefaultUrls: string[];
  /** 源健康度（连续失败自动暂停），只影响搜索是否发起请求，不改勾选 */
  sourceHealth: SourceHealthMap;
  /** 跳过标记：按 skipMarkKey(剧名, 年份) 聚合，跨集/跨同名源共享 */
  skipMarks: SkipMarkMap;
  /** 导入过的订阅地址与刷新状态（同一 URL 只保留一条） */
  subscriptions: SubscriptionEntry[];

  /** 首次导入 + 版本升级时补齐新增的内置源（幂等） */
  seedDefaults: () => void;
  /** 合并重复配置的源（同一地址只留一条），修老版本重复注入留下的数据 */
  dedupeSources: () => void;
  restoreDefaults: () => void;

  updateSettings: (patch: Partial<AppSettings>) => void;
  addSource: (source: Omit<SourceConfig, 'key'>) => void;
  updateSource: (key: string, patch: Partial<SourceConfig>) => void;
  removeSource: (key: string) => void;
  toggleSource: (key: string) => void;
  addLiveSource: (source: Omit<LiveSourceConfig, 'key'>) => void;
  removeLiveSource: (key: string) => void;
  toggleLiveSource: (key: string) => void;
  recordHistory: (entry: Omit<HistoryEntry, 'updatedAt'>) => void;
  /** 清掉老版本按 id 去重留下的同名重复记录（启动时跑一次即可） */
  dedupeHistory: () => void;
  toggleFavorite: (entry: Omit<FavoriteEntry, 'createdAt'>) => void;
  toggleLiveFavorite: (entry: Omit<LiveFavoriteEntry, 'createdAt'>) => void;
  addRecentSearch: (keyword: string) => void;
  /** 记录一次源搜索成败；本次失败导致暂停时返回事件供 UI 提示 */
  recordSourceOutcome: (key: string, ok: boolean) => SourceDisableEvent | null;
  /** 用户手动恢复被暂停的源 */
  restoreSourceHealth: (key: string) => void;
  /** 合并写入一部剧的跳过标记；传 null 清空该剧 */
  updateSkipMarks: (key: string, patch: Partial<SkipMarks> | null) => void;
  /** 记录/更新一个订阅（按 URL 去重，保留已有刷新设置） */
  upsertSubscription: (url: string, name?: string) => string;
  updateSubscription: (key: string, patch: Partial<Pick<SubscriptionEntry, 'refreshDays' | 'paused' | 'name'>>) => void;
  removeSubscription: (key: string) => void;
  /** 一次后台同步的结果：成功清零失败计数，失败累计到阈值自动暂停 */
  recordSubscriptionSync: (key: string, ok: boolean) => void;
  importSources: (sources: SourceConfig[], liveSources: LiveSourceConfig[]) => { addedVod: number; addedLive: number };
  clearHistory: () => void;
  removeHistory: (id: string) => void;
  replaceAll: (data: Partial<Pick<AppState, 'sources' | 'selectedKeys' | 'liveSources' | 'liveSelectedKeys' | 'history' | 'favorites' | 'liveFavorites' | 'settings'>>) => void;
}

function uniqueKey(prefix: string, existing: string[]): string {
  let key = `${prefix}_${stableKey(`${Date.now()}_${Math.random()}`)}`;
  while (existing.includes(key)) key = `${prefix}_${stableKey(`${key}_${Math.random()}`)}`;
  return key;
}

/**
 * 包装过的 localStorage：写失败时不再向调用方抛异常。
 *
 * zustand 的 `persist` 在 `setItem` 上没有 try/catch，而 `setState` 是同步
 * `return setItem(...)`——所以一旦配额写满，**每次 `recordHistory` 都会抛**，
 * 后面那句 `savedRef.current = …` 就被跳过，播放进度链路直接断掉，
 * 而且异常发生在事件处理器里，ErrorBoundary 也捕获不到。
 *
 * 这里退一步：写不下就先把「可有可无」的缓存键清掉再试一次，仍失败就只打日志。
 * 进度存不下来是遗憾，比整个历史记录写不进去、还连带抛异常好得多。
 */
/**
 * localStorage 写盘节流。
 *
 * zustand persist 在**每次 set 之后**都对 partialize 的整份状态做
 * `JSON.stringify` 并 `setItem`。播放页每 5 秒写一次进度，一集 45 分钟就是
 * ~540 次全量序列化 + 同步写（history 上限 200 条、每条带标题与封面 URL），
 * 全在渲染主线程上，表现为播放器周期性卡顿。
 *
 * 这里把同一时刻的连续写入合并成一次（尾部触发），并在页面隐藏/卸载前强制
 * flush，保证关窗口不丢最后一次进度。
 */
let pendingWrite: { name: string; value: string } | null = null;
let writeTimer: number | undefined;

function flushPendingWrite(): void {
  if (writeTimer !== undefined) {
    window.clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  const job = pendingWrite;
  if (!job) return;
  pendingWrite = null;
  writeNow(job.name, job.value);
}

function writeNow(name: string, value: string): void {
  try {
    localStorage.setItem(name, value);
  } catch {
    // 配额满了：先释放纯缓存（分类目录 / 检索 / 直播频道），它们下次能重新抓
    for (const key of ['librextv-live-cache-v1', 'librextv-search-cache-v1', 'librextv-catalog-v1']) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    try {
      localStorage.setItem(name, value);
    } catch (err) {
      console.warn('[librextv] 本地存储写入失败，本次状态未持久化', err);
    }
  }
}

if (typeof window !== 'undefined') {
  // 页面隐藏/卸载前把未落盘的写刷掉（Electron 关窗口也会走 pagehide）
  window.addEventListener('pagehide', flushPendingWrite);
  window.addEventListener('beforeunload', flushPendingWrite);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingWrite();
  });
}

const quotaSafeStorage = {
  getItem(name: string): string | null {
    try {
      // 有未落盘的写入时以内存里的为准，避免读到旧快照
      if (pendingWrite && pendingWrite.name === name) return pendingWrite.value;
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    pendingWrite = { name, value };
    if (writeTimer !== undefined) return;
    writeTimer = window.setTimeout(() => {
      writeTimer = undefined;
      flushPendingWrite();
    }, 400);
  },
  removeItem(name: string): void {
    if (pendingWrite && pendingWrite.name === name) pendingWrite = null;
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      sources: [],
      selectedKeys: [],
      liveSources: [],
      liveSelectedKeys: [],
      history: [],
      favorites: [],
      liveFavorites: [],
      recentSearches: [],
      defaultsSeeded: false,
      defaultsVersion: 0,
      removedDefaultUrls: [],
      sourceHealth: {},
      skipMarks: {},
      subscriptions: [],

      seedDefaults: () =>
        set((s) => {
          const version = DEFAULTS_VERSION;
          const upgraded = s.defaultsVersion < version;
          // 首次启动与「内置源清单升级」走同一条路径：两边都只补「本地没有的 url」，
          // 因此重复执行是安全的。老用户升级时不能只靠 defaultsSeeded 布尔量，
          // 否则新增的内置源永远进不来（这正是加 defaultsVersion 的原因）。
          if (s.defaultsSeeded && !upgraded) return s;
          // 老版本可能会把内置源重复写进存储（同一 url 出现多次），
          // 这里补一次合并：先按 url 去重，再补齐 selectedKeys。
          const existingUrls = new Set(s.sources.map((x) => x.url));
          const merged: typeof s.sources = [];
          const seen = new Set<string>();
          for (const source of s.sources) {
            if (seen.has(source.url)) continue;
            seen.add(source.url);
            merged.push(source);
          }
          // 用户删掉过的内置源不要再塞回来：升级补源不能把「我不想要这个站」
          // 变成「每次升级都复活一次」。
          const removed = new Set(s.removedDefaultUrls);
          // 内置源**换了地址**（同 key、不同 url）时要用新地址替换旧条目：key 是按下标
          // 生成的，光按 url 判重会留下一条旧地址的 `builtin_N`，再追加一条同 key 的
          // 新条目——列表里出现两条同名同 key 的源，React key 与勾选状态都会打架。
          // 直播源一直有这一步（下面的 freshByKey），点播源以前漏了。
          const srcFresh = new Map<string, (typeof DEFAULT_SOURCES)[number]>();
          for (const d of DEFAULT_SOURCES) {
            const local = merged.find((x) => x.key === d.key);
            if (local && local.url !== d.url && !removed.has(local.url)) srcFresh.set(d.key, d);
          }
          const added = DEFAULT_SOURCES.filter(
            (d) => !existingUrls.has(d.url) && !removed.has(d.url) && !merged.some((x) => x.key === d.key)
          );
          const sources = [
            ...merged.map((x) => {
              const fresh = srcFresh.get(x.key);
              if (fresh) return fresh;
              // 老用户升级：条目是 v9 及以前建的，那时还没有 `note` 字段。清单里同一 key
              // 现在带了「为什么默认不启用」的说明，补进去——否则设置页对老用户永远不解释
              // 那些源为什么是关着的（新装用户能看到，老用户看不到）。
              const note = DEFAULT_SOURCES.find((d) => d.key === x.key)?.note;
              return x.note === undefined && note !== undefined ? { ...x, note } : x;
            }),
            ...added,
          ];
          const liveRemoved = removed;
          const addedLive = DEFAULT_LIVE_SOURCES.filter(
            (d) => !s.liveSources.some((x) => x.url === d.url) && !liveRemoved.has(d.url)
          );
          // 内置源**换了地址**（同 key、不同 url）时要用新地址替换旧条目：
          // key 是按下标生成的，光按 url 判重会让列表里出现两条同 key 的同名源
          // （一条旧镜像、一条新镜像），勾选状态和 React key 都会打架。
          const freshByKey = new Map(addedLive.map((d) => [d.key, d] as const));
          const liveSources = [
            ...s.liveSources.map((x) => freshByKey.get(x.key) ?? x),
            ...addedLive.filter((d) => !s.liveSources.some((x) => x.key === d.key)),
          ];
          const defaultLiveSelected = new Set(DEFAULT_LIVE_SELECTED_KEYS);
          // v4 之前老用户是三个直播源全开的。清单把两个 iptv-org 源改成默认关闭后，
          // 光改 `selected` 对他们没用（勾选状态早就存下来了），所以升级到
          // LIVE_SELECTION_VERSION 时取消一次；之后用户自己再打开就不会被关掉。
          const liveBase =
            s.defaultsVersion < LIVE_SELECTION_VERSION
              ? s.liveSelectedKeys.filter((key) => !DEFAULT_LIVE_DISABLED_KEYS.includes(key))
              : s.liveSelectedKeys;
          // 点播源同理：v10 起把大陆直连不通的 8 个源默认关掉（5 个连不上、3 个搜索
          // 被 Cloudflare 挡）。新装用户只勾清单里没标 selected:false 的；老用户升级到
          // v10 时一次性取消勾选，之后用户自己再打开不会被关掉。
          const defaultVodSelected = new Set(DEFAULT_SELECTED_KEYS);
          const vodBase =
            s.defaultsVersion < VOD_SELECTION_VERSION
              ? s.selectedKeys.filter((key) => !DEFAULT_DISABLED_KEYS.includes(key))
              : s.selectedKeys;
          return {
            sources,
            // 新增的内置源里既有健康源也有被墙源，只有清单标了默认启用的才勾上。
            selectedKeys: [
              ...new Set([...vodBase, ...added.filter((x) => defaultVodSelected.has(x.key)).map((x) => x.key)]),
            ].filter((key) => sources.some((x) => x.key === key)),
            liveSources,
            // 只勾选清单里「默认启用」的内置源：iptv-org 两条与 Guovin 这类默认关掉的
            // 源虽然进列表，但不参与加载，否则新用户开箱就是一屏死台。
            liveSelectedKeys: [
              ...new Set([
                ...liveBase,
                ...addedLive.filter((x) => defaultLiveSelected.has(x.key)).map((x) => x.key),
              ]),
            ].filter((key) => liveSources.some((x) => x.key === key)),
            defaultsSeeded: true,
            defaultsVersion: version,
          };
        }),

      dedupeSources: () =>
        set((s) => {
          // 记下「被删掉的 key → 保留的 key」：同地址的两条源里，用户启用的可能
          // 正好是后一条。只按 key 过滤会把这种源静默停用，用户会以为「我明明
          // 开着这个源，怎么没内容了」——把启用状态搬到留下来的那条上。
          const keepByUrl = new Map<string, string>();
          const sources = s.sources.filter((source) => {
            if (!keepByUrl.has(source.url)) keepByUrl.set(source.url, source.key);
            return keepByUrl.get(source.url) === source.key;
          });
          const liveKeepByUrl = new Map<string, string>();
          const liveSources = s.liveSources.filter((source) => {
            if (!liveKeepByUrl.has(source.url)) liveKeepByUrl.set(source.url, source.key);
            return liveKeepByUrl.get(source.url) === source.key;
          });
          const keys = new Set(sources.map((x) => x.key));
          const liveKeys = new Set(liveSources.map((x) => x.key));
          const remap = (list: string[], kept: Set<string>, pool: { key: string; url: string }[], byUrl: Map<string, string>) =>
            [
              ...new Set(
                list
                  .map((key) =>
                    kept.has(key) ? key : byUrl.get(pool.find((x) => x.key === key)?.url ?? ''),
                  )
                  .filter((key): key is string => Boolean(key)),
              ),
            ];
          const selectedKeys = remap(s.selectedKeys, keys, s.sources, keepByUrl);
          const liveSelectedKeys = remap(s.liveSelectedKeys, liveKeys, s.liveSources, liveKeepByUrl);
          const changed =
            sources.length !== s.sources.length ||
            liveSources.length !== s.liveSources.length ||
            selectedKeys.length !== s.selectedKeys.length ||
            liveSelectedKeys.length !== s.liveSelectedKeys.length;
          if (!changed) return s;
          return { sources, liveSources, selectedKeys, liveSelectedKeys };
        }),

      restoreDefaults: () =>
        set((s) => {
          const vod = DEFAULT_SOURCES.filter((d) => !s.sources.some((x) => x.url === d.url));
          const live = DEFAULT_LIVE_SOURCES.filter((d) => !s.liveSources.some((x) => x.url === d.url));
          // 用户明确点了「恢复」：把「不再自动补回」的名单一并清掉，
          // 否则下次内置源清单升级时这些刚恢复的地址又会被当成「用户删掉的」。
          const restored = new Set([...vod.map((x) => x.url), ...live.map((x) => x.url)]);
          // 恢复默认同样只勾选「默认启用」的那几个，「恢复默认源」不该顺手把
          // 一万多个境外台打开（那是打开后立刻卡死）
          const defaultLiveSelected = new Set(DEFAULT_LIVE_SELECTED_KEYS);
          return {
            sources: [...s.sources, ...vod],
            selectedKeys: [...new Set([...s.selectedKeys, ...vod.map((x) => x.key)])],
            liveSources: [...s.liveSources, ...live],
            liveSelectedKeys: [
              ...new Set([
                ...s.liveSelectedKeys,
                ...live.filter((x) => defaultLiveSelected.has(x.key)).map((x) => x.key),
              ]),
            ],
            removedDefaultUrls: s.removedDefaultUrls.filter((url) => !restored.has(url)),
            defaultsSeeded: true,
            defaultsVersion: DEFAULTS_VERSION,
          };
        }),

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      addSource: (source) =>
        set((s) => {
          const key = uniqueKey('custom', s.sources.map((x) => x.key));
          return {
            sources: [...s.sources, { ...source, key }],
            selectedKeys: [...s.selectedKeys, key],
          };
        }),

      updateSource: (key, patch) =>
        set((s) => ({
          sources: s.sources.map((x) => (x.key === key ? { ...x, ...patch } : x)),
        })),

      removeSource: (key) =>
        set((s) => {
          const target = s.sources.find((x) => x.key === key);
          // 记下被删掉的内置源地址：内置源清单升级时不能再把它塞回来
          const isBuiltin = Boolean(target && DEFAULT_SOURCES.some((d) => d.url === target.url));
          return {
            sources: s.sources.filter((x) => x.key !== key),
            selectedKeys: s.selectedKeys.filter((k) => k !== key),
            history: s.history.filter((h) => h.sourceKey !== key),
            favorites: s.favorites.filter((f) => f.sourceKey !== key),
            removedDefaultUrls:
              isBuiltin && target ? [...new Set([...s.removedDefaultUrls, target.url])] : s.removedDefaultUrls,
          };
        }),

      toggleSource: (key) =>
        set((s) => ({
          selectedKeys: s.selectedKeys.includes(key)
            ? s.selectedKeys.filter((k) => k !== key)
            : [...s.selectedKeys, key],
        })),

      addLiveSource: (source) =>
        set((s) => {
          const key = uniqueKey('live', s.liveSources.map((x) => x.key));
          return {
            liveSources: [...s.liveSources, { ...source, key }],
            liveSelectedKeys: [...s.liveSelectedKeys, key],
          };
        }),

      removeLiveSource: (key) =>
        set((s) => {
          const target = s.liveSources.find((x) => x.key === key);
          const isBuiltin = Boolean(target && DEFAULT_LIVE_SOURCES.some((d) => d.url === target.url));
          // 直播收藏是按频道 url 存的，源删了收藏却留着：设置页的「收藏 N」虚高，
          // 重新加回同一个源时那些早已消失的频道又会「复活」成收藏。
          // 点播侧 removeSource 一直会连带清 history/favorites，这里对齐。
          //
          // 判断「这条频道属于这个源」只能靠 url：LiveFavoriteEntry 里没有 sourceKey。
          // 已知频道按「删除前缓存的频道列表」匹配；缓存里没有的（用户只收藏过、
          // 之后再没加载过那个源）就退一步把同 host 的都算进去。
          const cached = readLiveCache(liveCacheKey(s.liveSources.map((x) => x.url), s.settings.adultFilter));
          const owned = new Set(
            (cached ?? []).filter((ch) => ch.sourceKey === key).map((ch) => ch.url)
          );
          const host = target ? safeHost(target.url) : '';
          return {
            liveSources: s.liveSources.filter((x) => x.key !== key),
            liveSelectedKeys: s.liveSelectedKeys.filter((k) => k !== key),
            liveFavorites: s.liveFavorites.filter((f) => {
              if (owned.has(f.url)) return false;
              // 缓存没命中时按域名兜底：同一个源下的频道几乎都在同一个域上
              return host ? safeHost(f.url) !== host : true;
            }),
            removedDefaultUrls:
              isBuiltin && target ? [...new Set([...s.removedDefaultUrls, target.url])] : s.removedDefaultUrls,
          };
        }),

      toggleLiveSource: (key) =>
        set((s) => ({
          liveSelectedKeys: s.liveSelectedKeys.includes(key)
            ? s.liveSelectedKeys.filter((k) => k !== key)
            : [...s.liveSelectedKeys, key],
        })),

      recordHistory: (entry) =>
        set((s) => ({ history: upsertHistory(s.history, entry) })),

      dedupeHistory: () =>
        set((s) => {
          const next = dedupeHistoryList(s.history);
          // 没有变化就不要触发重渲染
          return next.length === s.history.length ? s : { history: next };
        }),

      toggleFavorite: (entry) =>
        set((s) => ({ favorites: toggleFavoriteList(s.favorites, entry) })),

      toggleLiveFavorite: (entry) =>
        set((s) => ({ liveFavorites: toggleLiveFavoriteList(s.liveFavorites, entry) })),

      addRecentSearch: (keyword) =>
        set((s) => {
          const kw = keyword.trim();
          if (!kw) return s;
          return { recentSearches: [kw, ...s.recentSearches.filter((x) => x !== kw)].slice(0, 12) };
        }),

      recordSourceOutcome: (key, ok) => {
        let event: SourceDisableEvent | null = null;
        set((s) => {
          const now = Date.now();
          const current = s.sourceHealth[key];
          if (ok) {
            return { sourceHealth: { ...s.sourceHealth, [key]: recordSourceSuccess(current, now) } };
          }
          const result = recordSourceFailure(current, now);
          if (result.event) event = { ...result.event, key };
          return { sourceHealth: { ...s.sourceHealth, [key]: result.entry } };
        });
        return event;
      },

      restoreSourceHealth: (key) =>
        set((s) => {
          const next = clearSourceHealth(s.sourceHealth, key);
          return next === s.sourceHealth ? s : { sourceHealth: next };
        }),

      updateSkipMarks: (key, patch) =>
        set((s) => {
          if (!key) return s;
          if (patch === null) {
            if (!s.skipMarks[key]) return s;
            const next = { ...s.skipMarks };
            delete next[key];
            return { skipMarks: next };
          }
          const prev = s.skipMarks[key];
          const merged: SkipMarks = {
            // 显式传 undefined 表示清除该字段（面板里删单个标记要用）
            introEnd: 'introEnd' in patch ? patch.introEnd : prev?.introEnd,
            outroStart: 'outroStart' in patch ? patch.outroStart : prev?.outroStart,
            segments: 'segments' in patch ? patch.segments ?? [] : prev?.segments ?? [],
            enabled: 'enabled' in patch ? patch.enabled : prev?.enabled,
          };
          const next = normalizeSkipMarks({ ...s.skipMarks, [key]: merged });
          return { skipMarks: next };
        }),

      upsertSubscription: (url, name) => {
        const trimmed = url.trim();
        const key = `sub_${stableKey(trimmed)}`;
        let host = trimmed;
        try {
          host = new URL(trimmed).host;
        } catch {
          return '';
        }
        set((s) => {
          if (s.subscriptions.some((x) => x.key === key)) return s;
          const entry: SubscriptionEntry = {
            key,
            url: trimmed,
            name: name?.trim() || host,
            refreshDays: 0,
            lastSyncedAt: 0,
            failStreak: 0,
            paused: false,
            addedAt: Date.now(),
          };
          return { subscriptions: [...s.subscriptions, entry] };
        });
        return key;
      },

      updateSubscription: (key, patch) =>
        set((s) => ({
          subscriptions: s.subscriptions.map((x) => {
            if (x.key !== key) return x;
            const refreshDays =
              patch.refreshDays === undefined
                ? x.refreshDays
                : Math.max(0, Math.min(365, Math.round(patch.refreshDays)));
            return {
              ...x,
              ...(patch.name === undefined ? {} : { name: patch.name }),
              refreshDays,
              // 用户手动改周期视为一次「我还在意它」的信号：解除暂停
              paused: patch.refreshDays === undefined ? (patch.paused ?? x.paused) : false,
            };
          }),
        })),

      removeSubscription: (key) =>
        set((s) => ({ subscriptions: s.subscriptions.filter((x) => x.key !== key) })),

      recordSubscriptionSync: (key, ok) =>
        set((s) => ({
          subscriptions: s.subscriptions.map((x) => {
            if (x.key !== key) return x;
            if (ok) return { ...x, lastSyncedAt: Date.now(), failStreak: 0, paused: false };
            const failStreak = x.failStreak + 1;
            return { ...x, failStreak, paused: failStreak >= SUBSCRIPTION_FAIL_THRESHOLD };
          }),
        })),

      importSources: (incomingVod, incomingLive) => {
        // 注意必须用**函数式** `set`：订阅同步是并行跑的（`subscription-sync.ts` 起 2 个
        // worker），若先 `get()` 快照再写回，后完成的那一方会用旧快照覆盖，
        // 先完成那个订阅新增的源就被静默丢掉了——用户看到「同步成功」但源没进来。
        let addedVod = 0;
        let addedLive = 0;
        set((s) => {
          const existingVodUrls = new Set(s.sources.map((x) => x.url));
          const existingLiveUrls = new Set(s.liveSources.map((x) => x.url));
          const vod = incomingVod.filter((x) => !existingVodUrls.has(x.url));
          const live = incomingLive.filter((x) => !existingLiveUrls.has(x.url));
          addedVod = vod.length;
          addedLive = live.length;
          if (vod.length === 0 && live.length === 0) return {};
          return {
            sources: [...s.sources, ...vod],
            selectedKeys: [...new Set([...s.selectedKeys, ...vod.map((x) => x.key)])],
            liveSources: [...s.liveSources, ...live],
            liveSelectedKeys: [...new Set([...s.liveSelectedKeys, ...live.map((x) => x.key)])],
          };
        });
        return { addedVod, addedLive };
      },

      clearHistory: () => set({ history: [] }),

      removeHistory: (id) => set((s) => ({ history: s.history.filter((h) => h.id !== id) })),

      replaceAll: (data) =>
        set((s) => ({
          sources: data.sources ?? s.sources,
          selectedKeys: data.selectedKeys ?? s.selectedKeys,
          liveSources: data.liveSources ?? s.liveSources,
          liveSelectedKeys: data.liveSelectedKeys ?? s.liveSelectedKeys,
          history: data.history ?? s.history,
          favorites: data.favorites ?? s.favorites,
          liveFavorites: data.liveFavorites ?? s.liveFavorites,
          settings: data.settings ?? s.settings,
        })),
    }),
    {
      name: 'librextv-desktop-v1',
      version: 1,
      storage: createJSONStorage(() => quotaSafeStorage),
      /**
       * 老版本持久化的 settings 没有 homeRecommend / recommendSource；
       * zustand 默认的浅合并会留下 undefined，开关与下拉都显示成空值。
       * 这里统一过一遍 normalizeSettings：缺字段补默认值，非法值回退。
       */
      merge: (persisted, current) => {
        const saved = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<AppState>;
        // 老存档没有 sourceHealth；顺手清掉 7 天没参与搜索的条目，
        // 否则「已经不用的源」会一直留在暂停列表里。
        const sourceHealth =
          saved.sourceHealth && typeof saved.sourceHealth === 'object'
            ? pruneSourceHealth(saved.sourceHealth, Date.now())
            : {};
        return {
          ...current,
          ...saved,
          settings: normalizeSettings(saved.settings),
          sourceHealth,
          skipMarks: normalizeSkipMarks(saved.skipMarks),
          subscriptions: normalizeSubscriptions(saved.subscriptions),
        };
      },
      partialize: (s) => ({
        settings: s.settings,
        sources: s.sources,
        selectedKeys: s.selectedKeys,
        liveSources: s.liveSources,
        liveSelectedKeys: s.liveSelectedKeys,
        history: s.history,
        favorites: s.favorites,
        liveFavorites: s.liveFavorites,
        recentSearches: s.recentSearches,
        defaultsSeeded: s.defaultsSeeded,
        // 这两个字段决定「内置源清单升级时补哪些源」，必须持久化：
        // 只存 defaultsSeeded 的话，老用户永远停在旧的内置源列表上。
        defaultsVersion: s.defaultsVersion,
        removedDefaultUrls: s.removedDefaultUrls,
        sourceHealth: s.sourceHealth,
        skipMarks: s.skipMarks,
        subscriptions: s.subscriptions,
      }),
    }
  )
);

/** 当前参与搜索的源 */
export function activeSources(state: AppState): SourceConfig[] {
  return state.sources.filter((s) => state.selectedKeys.includes(s.key));
}

/** 当前已启用的直播源 */
export function activeLiveSources(state: AppState): LiveSourceConfig[] {
  return state.liveSources.filter((s) => state.liveSelectedKeys.includes(s.key));
}

export function getState(): AppState {
  return useAppStore.getState();
}
