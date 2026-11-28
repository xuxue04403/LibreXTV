import { contextBridge, ipcRenderer } from 'electron';

/**
 * 缺省流 id：从一个随机起点递增。
 *
 * 主进程的 `streamSeq` 也是递增的，两条序列必须不撞车，否则会互相 cancel 掉对方的流。
 * 起点取随机数，撞上的概率可以忽略。
 */
let streamIdSeq = Math.floor(Math.random() * 1_000_000_000);

function nextStreamId(): number {
  streamIdSeq += 1;
  return streamIdSeq;
}

export interface BridgeHttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: string;
}

export interface BridgeHttpResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
  bytes: Uint8Array;
  ms: number;
  error?: string;
}

export interface DlnaDeviceInfo {
  name: string;
  location: string;
  controlUrl: string;
}

export interface BridgeStreamResponse {
  ok: boolean;
  status: number;
  url: string;
  headers?: Record<string, string>;
  bytes?: number;
  ms: number;
  error?: string;
}

export type BridgeRecommendQuery =
  | { kind: 'bangumi' }
  | { kind: 'hot-list'; id: string }
  | { kind: 'douban'; type: 'movie' | 'tv'; tag: string };

export interface BridgeRecommendItem {
  id: string;
  title: string;
  cover: string;
  rating?: string;
  year?: string;
  isTv: boolean;
  source: 'bangumi' | 'hot-list' | 'douban';
  weekday?: number;
  listId?: string;
}

const bridge = {
  info: (): Promise<{ version: string; platform: string; proxyBase: string; isDev: boolean }> =>
    ipcRenderer.invoke('app:info'),
  http: (url: string, options?: BridgeHttpOptions): Promise<BridgeHttpResponse> =>
    ipcRenderer.invoke('http:fetch', url, options),
  /**
   * 流式抓取：分块通过 `http:stream:chunk` 事件回推。
   *
   * 只暴露「订阅 + 取消」，不把 ipcRenderer 本身交给渲染层，
   * 避免页面能监听任意 IPC 通道。
   */
  stream: (
    url: string,
    options: { headers?: Record<string, string>; idleTimeoutMs?: number; streamId: number },
    onChunk: (chunk: Uint8Array) => void
  ): Promise<BridgeStreamResponse> => {
    const channel = 'http:stream:chunk';
    // 流的 id 必须由调用方（或这里）**在开流前**定下来。
    //
    // 曾经靠主进程的 `http:stream:started` 回推分配：那是 webContents 级广播，
    // 而 `ipcRenderer.on` 是进程级监听，并发抓多个直播源时每个 invoke 都会错过
    // 其他流的 started 事件，于是 `assignedId` 拿到的是「第一个收到的 id」并永不重设，
    // 第 2..N 个流把自己的分片写进 1 号流的结果里（直播页除第一个源外内容全错）。
    // 现在缺省也在这里分配，见 `nextStreamId()`。
    const streamId = options.streamId ?? nextStreamId();
    const listener = (_event: unknown, id: number, chunk: Uint8Array): void => {
      if (id === streamId) onChunk(chunk);
    };
    ipcRenderer.on(channel, listener);
    return ipcRenderer
      .invoke('http:stream', url, { ...options, streamId })
      .finally(() => {
        ipcRenderer.removeListener(channel, listener);
      }) as Promise<BridgeStreamResponse>;
  },
  streamCancel: (streamId: number): Promise<void> => ipcRenderer.invoke('http:stream:cancel', streamId),
  /** 首页推荐：主进程固定第三方地址并做缓存，页面只传枚举参数 */
  recommend: (
    query: BridgeRecommendQuery
  ): Promise<{ ok: boolean; items: BridgeRecommendItem[]; error?: string; fetchedAt?: number }> =>
    ipcRenderer.invoke('recommend:fetch', query),
  /** 画质探测：主进程抓 m3u8 / 分片前缀并解析，渲染层只拿结论 */
  qualityProbe: (input: {    source: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
    vodId: string;
  }): Promise<{
    ok: boolean;
    height?: number;
    label?: string;
    error?: string;
    reason?: string;
    retryable: boolean;
    cached: boolean;
  }> => ipcRenderer.invoke('quality:probe', input),
  /**
   * 内置片库（拼音首字母 → 中文片名）。
   *
   * 渲染层 `sandbox: true` + `nodeIntegration: false`，读不了磁盘也解不了 gzip，
   * 所以表在主进程；这里只拿片名数组。
   */
  seedLookup: (needle: string, limit?: number): Promise<{ ok: boolean; names: string[] }> =>
    ipcRenderer.invoke('seed:lookup', needle, limit),
  seedInfo: (): Promise<{ ready: boolean; size: number; origin: string; version: number }> =>
    ipcRenderer.invoke('seed:info'),
  /** 上报当前启用的点播源，让主进程拉一次每日增量 */
  seedPullDelta: (urls: string[]): Promise<{ ok: boolean; added: number }> =>
    ipcRenderer.invoke('seed:pull-delta', urls.map((url) => ({ url }))),
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-fullscreen'),
  setFullscreen: (value: boolean): Promise<boolean> => ipcRenderer.invoke('window:set-fullscreen', value),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
  /**
   * 订阅窗口全屏状态变化。
   *
   * 用户按 F11 / 走菜单栏的全屏不经过应用内的按钮，渲染层的图标会失真，
   * 所以由主进程在 enter/leave-full-screen 时回推，返回取消订阅函数。
   */
  onFullscreenChange: (callback: (value: boolean) => void): (() => void) => {
    const channel = 'window:fullscreen-changed';
    const listener = (_event: unknown, value: boolean): void => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  saveText: (name: string, content: string): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:save-text', name, content),
  openText: (): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:open-text'),
  dlnaDiscover: (): Promise<{ ok: boolean; devices: DlnaDeviceInfo[]; error?: string }> =>
    ipcRenderer.invoke('dlna:discover'),
  dlnaCast: (device: DlnaDeviceInfo, url: string, title: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dlna:cast', device, url, title),
  dlnaStop: (device: DlnaDeviceInfo): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dlna:stop', device),
};

export type LibreXTVBridge = typeof bridge;

contextBridge.exposeInMainWorld('librextv', bridge);
