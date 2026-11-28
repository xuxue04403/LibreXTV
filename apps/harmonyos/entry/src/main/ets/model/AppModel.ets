/**
 * 全局状态与业务动作。
 *
 * 与 Android 端 AppViewModel 的分工一致：页面只负责画，所有状态变更与网络请求
 * 都在这里。刷新机制用 AppStorage 里的版本号：字段改动后 bump()，页面通过
 * @StorageLink('vmVersion') 被动重绘（鸿蒙没有 Compose 那种细粒度快照，
 * 单一版本号最省事也不会漏刷新）。
 */
import { common } from '@kit.AbilityKit';
import { bundleManager } from '@kit.AbilityKit';
import {
  AppData,
  AppSettings,
  FavoriteEntry,
  HistoryEntry,
  LiveChannel,
  LiveFavoriteEntry,
  LiveSource,
  LiveStatus,
  PageId,
  PlaybackCandidate,
  SearchGroup,
  SearchItem,
  VodDetail,
  VodSource,
  emptyData,
} from '../model/Types';
import { DefaultsParsed, mergeDefaults, parseDefaults, readDefaultsText } from '../data/Defaults';
import { Storage } from '../data/Storage';
import { fetchDetail, loadLiveAll, loadLiveOne, searchAll, SearchStatus } from '../data/Repository';
import { groupSearchResults, rankGroups } from '../data/Relevance';
import { dedupeChannels } from '../data/M3u';
import { describeError } from '../data/Errors';

const HISTORY_LIMIT = 200;
const FAVORITE_LIMIT = 500;
const HOME_ROW_SIZE = 14;

/** 搜索页的三段状态 */
export class SearchState {
  keyword: string = '';
  loading: boolean = false;
  groups: SearchGroup[] = [];
  statuses: SearchStatus[] = [];
  searched: boolean = false;
}

/** 详情页状态 */
export class DetailState {
  loading: boolean = false;
  detail: VodDetail | null = null;
  error: string = '';
}

/** 直播页状态 */
export class LiveState {
  loading: boolean = false;
  channels: LiveChannel[] = [];
  statuses: LiveStatus[] = [];
  groups: string[] = [];
  selectedGroup: string = '全部';
  keyword: string = '';
  bytes: number = 0;
  loadedOnce: boolean = false;
}

/** 播放页参数 */
export class PlayerTarget {
  source: VodSource;
  vodId: string;
  title: string;
  cover: string;
  episodes: string[];
  startIndex: number;
  sourceName: string;
  candidates: PlaybackCandidate[];
  group: SearchItem[];

  constructor(source: VodSource, vodId: string, title: string, cover: string, episodes: string[],
    startIndex: number, sourceName: string, candidates: PlaybackCandidate[], group: SearchItem[]) {
    this.source = source;
    this.vodId = vodId;
    this.title = title;
    this.cover = cover;
    this.episodes = episodes;
    this.startIndex = startIndex;
    this.sourceName = sourceName;
    this.candidates = candidates;
    this.group = group;
  }
}

/** 详情页参数 */
export class DetailTarget {
  item: SearchItem;
  group: SearchItem[];

  constructor(item: SearchItem, group: SearchItem[]) {
    this.item = item;
    this.group = group;
  }
}

/**
 * 落进度时用的「当前播放对象」。
 *
 * 不能只看 `playerTarget`：换源之后播放页的源与分集已经变了，而 `playerTarget`
 * 还是最初那一份，于是进度被写进旧源/旧集数的历史条目里（再点「继续观看」就跳错）。
 */
export class ProgressTarget {
  sourceKey: string;
  vodId: string;
  title: string;
  cover: string;
  sourceName: string;
  episodeCount: number;

  constructor(sourceKey: string, vodId: string, title: string, cover: string, sourceName: string,
    episodeCount: number) {
    this.sourceKey = sourceKey;
    this.vodId = vodId;
    this.title = title;
    this.cover = cover;
    this.sourceName = sourceName;
    this.episodeCount = episodeCount;
  }
}

export class AppModel {
  page: PageId = PageId.Home;
  data: AppData = emptyData();
  search: SearchState = new SearchState();
  detail: DetailState = new DetailState();
  live: LiveState = new LiveState();
  toast: string = '';
  importing: boolean = false;
  detailTarget: DetailTarget | null = null;
  playerTarget: PlayerTarget | null = null;
  liveTarget: LiveChannel | null = null;
  livePlaylist: LiveChannel[] = [];
  /** 详情页的返回目标 */
  private backStack: PageId[] = [];
  /**
   * 搜索请求序号：连打两次搜索时，先发起的那一轮可能后返回，
   * 无条件写回就会把新词的结果覆盖成旧词的（状态行与分组都会错）。
   */
  private searchSeq: number = 0;
  /**
   * 详情请求序号：同一部片子点「其它源」时，先发的请求可能后返回。
   * 详情对象每轮都是新的，迟到的旧响应会写进新源的对象里 → 换源播出错片。
   */
  private detailSeq: number = 0;
  /**
   * 直播加载序号：加载途中改/删直播源时，旧轮次的结果不能算数，
   * 否则被停用的源里的频道会带着 loadedOnce=true 留在列表里。
   */
  private liveSeq: number = 0;
  private storage: Storage = new Storage();
  private started: boolean = false;
  version: number = 0;
  /**
   * 安装包的版本号（如 `1.3.15`）。
   *
   * 从 bundleManager 读而不是写死在设置页里：写死会随发版漂移
   * （实测设置页曾长期停在 `1.3.11`，比安装包落后三个版本）。
   * 读不到时留空串，界面上就只显示应用名。
   */
  appVersion: string = '';

  /** 应用启动时调用一次 */
  async start(context: common.UIAbilityContext): Promise<void> {
    if (this.started) {
      return;
    }
    // started 必须最后置位：中途 any await 抛错时如果已经标了「已启动」，
    // 界面再调 start() 会直接 return，源表永远是空的且无法恢复。
    this.appVersion = await readAppVersion(context);
    await this.storage.init(context);
    const stored = this.storage.loadSync();
    const text = await readDefaultsText(context);
    const parsed: DefaultsParsed = parseDefaults(text);
    this.data = mergeDefaults(stored, parsed);
    // 清单读不到时 mergeDefaults 原样返回，这里也就别覆盖磁盘上的备份数据；
    // 只有真的合并成功（或本来就已 seeded）才落盘。
    if (this.data.seeded) {
      this.persist();
    }
    this.started = true;
    this.bump();
  }

  /** 通知页面重绘 */
  bump(): void {
    this.version += 1;
    AppStorage.setOrCreate('vmVersion', this.version);
  }

  private persist(): void {
    this.storage.saveSoon(this.data);
  }

  /**
   * 立即把待写数据落盘。
   *
   * Storage 的写入有 400ms 防抖，用来避免播放进度每秒一次回调打满 IO；
   * 但应用退到后台/被划掉时不会有人再等这 400ms，必须由 EntryAbility 主动冲一次，
   * 否则最后一次进度、刚点的收藏/设置项会丢。
   */
  flushStore(): void {
    this.storage.flush();
  }

  /** 切页（记录返回栈） */
  go(page: PageId): void {
    if (page !== this.page) {
      this.backStack.push(this.page);
      if (this.backStack.length > 16) {
        this.backStack.shift();
      }
    }
    this.page = page;
    this.bump();
  }

  /** 返回上一页；栈空时回到首页 */
  back(): void {
    const prev = this.backStack.pop();
    this.page = prev === undefined ? PageId.Home : prev;
    this.bump();
  }

  show(text: string): void {
    this.toast = text;
    this.bump();
  }

  clearToast(): void {
    if (this.toast.length > 0) {
      this.toast = '';
      this.bump();
    }
  }

  activeSources(): VodSource[] {
    const out: VodSource[] = [];
    for (let i = 0; i < this.data.sources.length; i++) {
      const s = this.data.sources[i];
      if (this.data.selected.indexOf(s.key) >= 0) {
        out.push(s);
      }
    }
    return out;
  }

  activeLiveSources(): LiveSource[] {
    const out: LiveSource[] = [];
    for (let i = 0; i < this.data.liveSources.length; i++) {
      const s = this.data.liveSources[i];
      if (this.data.liveSelected.indexOf(s.key) >= 0) {
        out.push(s);
      }
    }
    return out;
  }

  // ---------------- 搜索 ----------------

  async startSearch(keyword: string): Promise<void> {
    const wd = keyword.trim();
    if (wd.length === 0) {
      return;
    }
    const mySeq = ++this.searchSeq;
    this.search.keyword = wd;
    this.search.loading = true;
    this.search.searched = true;
    this.search.groups = [];
    this.search.statuses = [];
    this.bump();
    const sources = this.activeSources();
    const collected: SearchItem[] = [];
    const statuses: SearchStatus[] = [];
    try {
      const result = await searchAll(sources, wd, this.data.settings.adultFilter,
        (items: SearchItem[], st: SearchStatus) => {
          if (mySeq !== this.searchSeq) {
            return;
          }
          for (let i = 0; i < items.length; i++) {
            collected.push(items[i]);
          }
          statuses.push(st);
          this.search.statuses = statuses.slice();
          this.search.groups = rankGroups(groupSearchResults(collected), wd);
          this.bump();
        });
      if (mySeq !== this.searchSeq) {
        return;
      }
      this.search.groups = rankGroups(groupSearchResults(result.items), wd);
      this.search.statuses = result.statuses;
    } catch (err) {
      if (mySeq === this.searchSeq) {
        this.show(describeError(err as Object));
      }
    } finally {
      // 只有最新一轮才有资格把 loading 关掉：旧轮次结束就关会闪掉新轮次的转圈
      if (mySeq === this.searchSeq) {
        this.search.loading = false;
      }
      this.bump();
    }
  }

  // ---------------- 详情 ----------------

  async openDetail(item: SearchItem, group: SearchItem[]): Promise<void> {
    // 每次开详情都换一个新的 detail 对象，迟到的旧响应必须被丢弃：
    // 否则「点同片其它源」连点两次时，旧源的 episodes 会写进新源的详情里，
    // 点播放就拿 B 源的 id 播 A 源的地址，进度和收藏全记到 B 上。
    const mySeq = ++this.detailSeq;
    const state = new DetailState();
    this.detailTarget = new DetailTarget(item, group);
    this.detail = state;
    state.loading = true;
    this.go(PageId.Detail);
    const source = this.findSource(item.sourceKey);
    if (source === undefined) {
      state.loading = false;
      state.error = '这个源已被停用或删除';
      this.bump();
      return;
    }
    try {
      const vod = await fetchDetail(source, item.vodId);
      if (mySeq !== this.detailSeq) {
        return;
      }
      state.detail = vod;
      this.bump();
    } catch (err) {
      if (mySeq !== this.detailSeq) {
        return;
      }
      state.error = describeError(err as Object);
      this.bump();
    } finally {
      if (mySeq === this.detailSeq) {
        state.loading = false;
        this.bump();
      }
    }
  }

  private findSource(key: string): VodSource | undefined {
    for (let i = 0; i < this.data.sources.length; i++) {
      if (this.data.sources[i].key === key) {
        return this.data.sources[i];
      }
    }
    return undefined;
  }

  /** 从详情页开播 */
  playFromDetail(index: number): void {
    const t = this.detailTarget;
    const d = this.detail.detail;
    if (t === null || d === null || d.episodes.length === 0) {
      return;
    }
    const source = this.findSource(t.item.sourceKey);
    if (source === undefined) {
      this.show('这个源已被停用或删除');
      return;
    }
    const candidates: PlaybackCandidate[] = [];
    for (let i = 0; i < t.group.length; i++) {
      const g = t.group[i];
      if (g.sourceKey === t.item.sourceKey) {
        continue;
      }
      candidates.push({ sourceKey: g.sourceKey, sourceName: g.sourceName, vodId: g.vodId });
    }
    const idx = Math.max(0, Math.min(index, d.episodes.length - 1));
    this.playerTarget = new PlayerTarget(source, t.item.vodId, d.title ?? t.item.name, d.cover ?? t.item.pic ?? '',
      d.episodes, idx, t.item.sourceName, candidates, t.group);
    this.go(PageId.Player);
  }

  // ---------------- 直播 ----------------

  async loadLive(force: boolean): Promise<void> {
    // force（用户点了重试/切了源）要能打断在途那一轮：只看 loading 的话，
    // 改完源点刷新会被直接吞掉，用户以为按钮坏了。序号会作废旧轮次。
    if (this.live.loading && !force) {
      return;
    }
    if (this.live.loadedOnce && !force) {
      return;
    }
    // 序号守卫：加载途中用户可能删/改直播源再触发一轮。旧轮次回来时
    // 不能写 channels、更不能把 loadedOnce 置 true —— 否则被停用的源里
    // 的频道会带着「已加载」状态留在列表里，而且再也不会重新拉。
    const mySeq = ++this.liveSeq;
    this.live.loading = true;
    this.live.statuses = [];
    this.live.bytes = 0;
    this.bump();
    const sources = this.activeLiveSources();
    try {
      const result = await loadLiveAll(sources, (st: LiveStatus, bytes: number) => {
        if (mySeq !== this.liveSeq) {
          return;
        }
        this.live.statuses = this.live.statuses.concat([st]);
        this.live.bytes = bytes;
        this.bump();
      });
      if (mySeq !== this.liveSeq) {
        return;
      }
      this.live.channels = dedupeChannels(result.channels);
      this.live.statuses = result.statuses;
      this.live.bytes = result.bytes;
      this.live.groups = collectLiveGroups(this.live.channels);
      // 分组可能整组消失（源被删/被停用）：留着一个不存在的分组名会让列表恒空，
      // 而分组芯片上也点不到它，用户只能猜着去点「全部」。
      // 注意哨兵值是 '全部' 而不是空串 —— visible() 用 `group !== '全部'` 判断不筛选，
      // 写成空串会变成「按空分组名过滤」，同样恒空。
      if (this.live.groups.indexOf(this.live.selectedGroup) < 0) {
        this.live.selectedGroup = '全部';
      }
      this.live.loadedOnce = true;
    } catch (err) {
      if (mySeq !== this.liveSeq) {
        return;
      }
      this.show(describeError(err as Object));
    } finally {
      if (mySeq === this.liveSeq) {
        this.live.loading = false;
        this.bump();
      }
    }
  }

  setLiveGroup(group: string): void {
    this.live.selectedGroup = group;
    this.bump();
  }

  setLiveKeyword(kw: string): void {
    this.live.keyword = kw;
    this.bump();
  }

  /** 当前筛选后的频道 */
  visibleChannels(): LiveChannel[] {
    const out: LiveChannel[] = [];
    const group = this.live.selectedGroup;
    const kw = this.live.keyword.trim().toLowerCase();
    for (let i = 0; i < this.live.channels.length; i++) {
      const c = this.live.channels[i];
      const g = c.group ?? '未分组';
      if (group !== '全部' && g !== group) {
        continue;
      }
      if (kw.length > 0 && c.name.toLowerCase().indexOf(kw) < 0) {
        continue;
      }
      out.push(c);
    }
    return out;
  }

  openLivePlayer(channel: LiveChannel, playlist: LiveChannel[]): void {
    this.liveTarget = channel;
    this.livePlaylist = playlist;
    this.go(PageId.LivePlayer);
  }

  // ---------------- 历史与收藏 ----------------

  /**
   * 落播放进度。
   *
   * `explicit` 由播放页传入「当前真正在播的源与集数」：换源之后 `playerTarget`
   * 仍指向最初那一份，只读它会把进度写到旧条目上。
   */
  saveProgress(index: number, positionMs: number, durationMs: number, finished: boolean,
    explicit?: ProgressTarget): void {
    const t = explicit !== undefined ? explicit : this.readProgressTarget();
    if (t === null || !this.data.settings.resumePlayback) {
      return;
    }
    if (!finished && positionMs <= 0) {
      return;
    }
    const id = `${t.sourceKey}:${t.vodId}`;
    const effectivePos = finished ? 0 : positionMs;
    const epIndex = finished ? Math.min(index + 1, Math.max(0, t.episodeCount - 1)) : index;
    const entry: HistoryEntry = {
      id: id,
      sourceKey: t.sourceKey,
      vodId: t.vodId,
      title: t.title,
      cover: t.cover.length > 0 ? t.cover : undefined,
      sourceName: t.sourceName,
      episodeIndex: epIndex,
      episodeCount: t.episodeCount,
      positionMs: effectivePos,
      durationMs: durationMs,
      updatedAt: Date.now(),
    };
    const list: HistoryEntry[] = [entry];
    for (let i = 0; i < this.data.history.length; i++) {
      if (this.data.history[i].id !== id && list.length < HISTORY_LIMIT) {
        list.push(this.data.history[i]);
      }
    }
    this.data.history = list;
    this.persist();
  }

  /** 没有显式目标时退回 `playerTarget`（首播路径就是这样） */
  private readProgressTarget(): ProgressTarget | null {
    const t = this.playerTarget;
    if (t === null) {
      return null;
    }
    return new ProgressTarget(t.source.key, t.vodId, t.title, t.cover, t.sourceName, t.episodes.length);
  }

  resumeFromHistory(entry: HistoryEntry): void {
    const source = this.findSource(entry.sourceKey);
    if (source === undefined) {
      this.show('这个源已被停用或删除');
      return;
    }
    const item: SearchItem = {
      sourceKey: entry.sourceKey,
      sourceName: entry.sourceName,
      vodId: entry.vodId,
      name: entry.title,
      pic: entry.cover,
    };
    this.openDetail(item, [item]);
  }

  removeHistory(id: string): void {
    const out: HistoryEntry[] = [];
    for (let i = 0; i < this.data.history.length; i++) {
      if (this.data.history[i].id !== id) {
        out.push(this.data.history[i]);
      }
    }
    this.data.history = out;
    this.persist();
    this.bump();
  }

  clearHistory(): void {
    this.data.history = [];
    this.persist();
    this.bump();
  }

  isFavorite(item: SearchItem): boolean {
    const id = `${item.sourceKey}:${item.vodId}`;
    for (let i = 0; i < this.data.favorites.length; i++) {
      if (this.data.favorites[i].id === id) {
        return true;
      }
    }
    return false;
  }

  toggleFavorite(item: SearchItem, title: string, cover: string): void {
    const id = `${item.sourceKey}:${item.vodId}`;
    const out: FavoriteEntry[] = [];
    let removed = false;
    for (let i = 0; i < this.data.favorites.length; i++) {
      const f = this.data.favorites[i];
      if (f.id === id) {
        removed = true;
        continue;
      }
      out.push(f);
    }
    if (!removed) {
      out.unshift({
        id: id,
        sourceKey: item.sourceKey,
        vodId: item.vodId,
        title: title.length > 0 ? title : item.name,
        cover: cover.length > 0 ? cover : item.pic,
        createdAt: Date.now(),
      });
      while (out.length > FAVORITE_LIMIT) {
        out.pop();
      }
    }
    this.data.favorites = out;
    this.persist();
    this.show(removed ? '已取消收藏' : '已加入收藏');
  }

  isLiveFavorite(url: string): boolean {
    for (let i = 0; i < this.data.liveFavorites.length; i++) {
      if (this.data.liveFavorites[i].url === url) {
        return true;
      }
    }
    return false;
  }

  toggleLiveFavorite(channel: LiveChannel): void {
    const out: LiveFavoriteEntry[] = [];
    let removed = false;
    for (let i = 0; i < this.data.liveFavorites.length; i++) {
      const f = this.data.liveFavorites[i];
      if (f.url === channel.url) {
        removed = true;
        continue;
      }
      out.push(f);
    }
    if (!removed) {
      out.unshift({ url: channel.url, name: channel.name, logo: channel.logo, createdAt: Date.now() });
    }
    this.data.liveFavorites = out;
    this.persist();
    this.show(removed ? '已取消收藏' : '已收藏频道');
  }

  // ---------------- 设置 ----------------

  updateSettings(transform: (s: AppSettings) => AppSettings): void {
    this.data.settings = transform(this.data.settings);
    this.persist();
    this.bump();
  }

  /** 添加自定义点播源；返回空串表示成功，否则是失败原因 */
  addSource(name: string, url: string, detail: string): string {
    const n = name.trim();
    const u = url.trim();
    if (n.length === 0 || u.length === 0) {
      return '名称和接口地址都不能为空';
    }
    if (!/^https?:\/\//i.test(u)) {
      return '接口地址必须以 http:// 或 https:// 开头';
    }
    for (let i = 0; i < this.data.sources.length; i++) {
      if (this.data.sources[i].url === u) {
        return '这个源已经在列表里了';
      }
    }
    const key = uniqueKey(this.data.sources.map((s: VodSource) => s.key));
    this.data.sources = this.data.sources.concat([{
      key: key,
      name: n,
      url: u,
      detail: detail.trim().length > 0 ? detail.trim() : undefined,
      isAdult: false,
      builtin: false,
    }]);
    this.data.selected = this.data.selected.concat([key]);
    this.persist();
    this.bump();
    return '';
  }

  removeSource(key: string): void {
    const target = this.findSource(key);
    if (target === undefined) {
      return;
    }
    const removedUrls = this.data.removedDefaultUrls.slice();
    if (target.builtin) {
      removedUrls.push(target.url);
    }
    this.data.sources = this.data.sources.filter((s: VodSource) => s.key !== key);
    this.data.selected = this.data.selected.filter((k: string) => k !== key);
    // 删源必须同时清掉它名下的历史与收藏：设置页的文案承诺了
    // 「历史与收藏会一起清掉」，Android 端也是这么做的。留着的话，
    // 这些条目点开时源已不存在，只会弹「这个源已被停用或删除」。
    this.data.history = this.data.history.filter((h: HistoryEntry) => h.sourceKey !== key);
    this.data.favorites = this.data.favorites.filter((f: FavoriteEntry) => f.sourceKey !== key);
    this.data.removedDefaultUrls = removedUrls;
    this.persist();
    this.bump();
  }

  toggleSource(key: string): void {
    const idx = this.data.selected.indexOf(key);
    if (idx >= 0) {
      this.data.selected = this.data.selected.filter((k: string) => k !== key);
    } else {
      this.data.selected = this.data.selected.concat([key]);
    }
    this.persist();
    this.bump();
  }

  addLiveSource(name: string, url: string, note: string): string {
    const n = name.trim();
    const u = url.trim();
    if (n.length === 0 || u.length === 0) {
      return '名称和订阅地址都不能为空';
    }
    if (!/^https?:\/\//i.test(u)) {
      return '订阅地址必须以 http:// 或 https:// 开头';
    }
    for (let i = 0; i < this.data.liveSources.length; i++) {
      if (this.data.liveSources[i].url === u) {
        return '这个直播源已经在列表里了';
      }
    }
    const key = uniqueLiveKey(this.data.liveSources.map((s: LiveSource) => s.key));
    this.data.liveSources = this.data.liveSources.concat([{
      key: key,
      name: n,
      url: u,
      builtin: false,
      note: note.trim().length > 0 ? note.trim() : undefined,
    }]);
    this.data.liveSelected = this.data.liveSelected.concat([key]);
    this.persist();
    this.bump();
    return '';
  }

  removeLiveSource(key: string): void {
    const target = this.data.liveSources.filter((s: LiveSource) => s.key === key);
    const removedUrls = this.data.removedDefaultUrls.slice();
    if (target.length > 0 && target[0].builtin) {
      removedUrls.push(target[0].url);
    }
    this.data.liveSources = this.data.liveSources.filter((s: LiveSource) => s.key !== key);
    this.data.liveSelected = this.data.liveSelected.filter((k: string) => k !== key);
    this.data.removedDefaultUrls = removedUrls;
    this.live.loadedOnce = false;
    this.persist();
    this.bump();
  }

  toggleLiveSource(key: string): void {
    const idx = this.data.liveSelected.indexOf(key);
    if (idx >= 0) {
      this.data.liveSelected = this.data.liveSelected.filter((k: string) => k !== key);
    } else {
      this.data.liveSelected = this.data.liveSelected.concat([key]);
    }
    this.live.loadedOnce = false;
    this.persist();
    this.bump();
  }

  /** 订阅导入：拉一个 m3u/json 订阅并合并里面的源 */
  async importSubscription(url: string): Promise<void> {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      this.show('订阅地址必须以 http:// 或 https:// 开头');
      return;
    }
    this.importing = true;
    this.bump();
    try {
      // 重复导入同一个订阅会得到两份一模一样的源：每次都多一轮下载 +
      // 频道去重白跑，设置页也会出现两条同地址。addLiveSource 已有这个校验。
      for (let i = 0; i < this.data.liveSources.length; i++) {
        if (this.data.liveSources[i].url === u) {
          this.show('这个订阅已经在列表里了');
          return;
        }
      }
      const result = await loadLiveOne({ key: 'import', name: '订阅', url: u, builtin: false }, 40_000);
      if (result.channels.length === 0) {
        const err = result.statuses.length > 0 ? (result.statuses[0].error ?? '没有解析到频道') : '没有解析到频道';
        this.show(`导入失败：${err}`);
        return;
      }
      const key = uniqueLiveKey(this.data.liveSources.map((s: LiveSource) => s.key));
      this.data.liveSources = this.data.liveSources.concat([{
        key: key,
        name: `订阅 ${this.data.liveSources.length + 1}`,
        url: u,
        builtin: false,
      }]);
      this.data.liveSelected = this.data.liveSelected.concat([key]);
      this.live.loadedOnce = false;
      this.persist();
      this.show(`已导入 ${result.channels.length} 个频道`);
    } catch (err) {
      this.show(`导入失败：${describeError(err as Object)}`);
    } finally {
      this.importing = false;
      this.bump();
    }
  }

  /** 首页每一排（按分类取前几个） */
  homeRows(): HomeRowData[] {
    const rows: HomeRowData[] = [];
    return rows;
  }
}

/** 首页一排 */
export class HomeRowData {
  title: string = '';
  items: SearchItem[] = [];
}

/**
 * 读安装包版本号。
 *
 * `getBundleInfoForSelf` 是同步 API（鸿蒙 4.0+），拿到的 `versionName` 就是
 * `AppScope/app.json5` 里那个值。任何异常都吞掉返回空串——版本号显示不出来
 * 不该影响启动。
 */
function readAppVersion(context: common.UIAbilityContext): string {
  try {
    const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    return info.versionName ?? '';
  } catch (err) {
    return '';
  }
}

function collectLiveGroups(channels: LiveChannel[]): string[] {
  const out: string[] = ['全部'];
  const seen = new Set<string>();
  seen.add('全部');
  for (let i = 0; i < channels.length; i++) {
    const g = channels[i].group ?? '未分组';
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/**
 * 生成自定义源 key。
 *
 * 不能用「找最小空缺号」：删掉 custom_1 之后再添加一个，号又回到 custom_1，
 * 而历史/收藏里记着 custom_1 的老条目会立刻指到新源上（串台，且用户看到的是
 * 完全不同的一部剧）。改用时间戳，撞了再加随机后缀 —— 删源之后永不复用。
 */
function uniqueKey(existing: string[]): string {
  const taken = new Set<string>(existing);
  let key = `custom_${Date.now().toString(36)}`;
  while (taken.has(key)) {
    key = `custom_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
  }
  return key;
}


/** 同 uniqueKey：直播源的 key 也不能回收，否则直播收藏会指到新源的同名频道上 */
function uniqueLiveKey(existing: string[]): string {
  const taken = new Set<string>(existing);
  let key = `custom_live_${Date.now().toString(36)}`;
  while (taken.has(key)) {
    key = `custom_live_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
  }
  return key;
}

/** 全局单例 */
export const appModel: AppModel = new AppModel();
export { HOME_ROW_SIZE };
