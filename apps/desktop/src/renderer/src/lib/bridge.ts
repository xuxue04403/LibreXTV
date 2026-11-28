import {
  createFetchHttp,
  type HotListId,
  type HttpClient,
  type RecommendItem,
  type HttpResponse,
  type SourceConfig,
} from '@librextv/core';

export interface AppInfo {
  version: string;
  platform: string;
  /** 回环媒体代理解析出来的前缀（含 token），浏览器预览时为空 */
  proxyBase: string;
  isDev: boolean;
}

const FALLBACK_INFO: AppInfo = { version: 'dev', platform: 'web', proxyBase: '', isDev: true };

let info: AppInfo = FALLBACK_INFO;
let ready: Promise<AppInfo> | null = null;

/** 读取主进程信息（窗口启动时调用一次） */
export function initBridge(): Promise<AppInfo> {
  if (ready) return ready;
  ready = (async () => {
    // 浏览器预览（没有 preload）走回退，这是正常路径
    if (!window.librextv) return info;
    // 有 preload 却问不到信息，说明主进程那边出了问题，不能静默降级：
    // 静默降级的结果是 proxyBase 为空，封面与视频全走直连、逐个 CORS/防盗链失败，
    // 用户看到的是「能打开界面，但所有片子都播不了」，比直接报错更难查。
    const infoTask = window.librextv.info();
    // 主进程无响应时不能无限等：10 秒还没回来就当启动失败，让上层给重试入口
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('主进程 10 秒内没有响应')), 10_000);
    });
    info = await Promise.race([infoTask, timeout]);
    return info;
  })();
  return ready;
}

/** 重试启动：清掉缓存的（可能已失败的）握手结果 */
export function resetBridge(): void {
  ready = null;
  info = FALLBACK_INFO;
}

export function appInfo(): AppInfo {
  return info;
}

/**
 * 内置片库（拼音首字母 → 中文片名）查询。
 *
 * 走主进程而不是渲染层直接读：渲染层是 `sandbox: true` + `nodeIntegration: false`，
 * 拿不到 `fs` 也解不了 gzip。浏览器预览（没有 preload）时退回空表，搜索行为退化成
 * 只用本地索引——与加片库之前完全一致，不会崩。
 */
export async function seedLookup(needle: string, limit = 200): Promise<string[]> {
  if (!window.librextv) return [];
  try {
    const res = await window.librextv.seedLookup(needle, limit);
    return res.ok ? res.names : [];
  } catch {
    return [];
  }
}

/** 内置片库是否已就绪（诊断用） */
export async function seedInfo(): Promise<{
  ready: boolean;
  size: number;
  origin: string;
  version: number;
}> {
  if (!window.librextv) return { ready: false, size: 0, origin: '', version: 0 };
  try {
    return await window.librextv.seedInfo();
  } catch {
    return { ready: false, size: 0, origin: '', version: 0 };
  }
}

/**
 * 让主进程拉一次「每日增量」：各启用源的第 1 页就是当天新片。
 *
 * 只上报 URL，不上报源名——主进程只拿它拼 `?ac=list&pg=1`，不需要别的字段。
 * 失败不影响任何界面，返回新增条数（多数时候是 0，因为当天本来就没几部新片）。
 */
export async function seedPullDelta(urls: string[]): Promise<number> {
  if (!window.librextv || urls.length === 0) return 0;
  try {
    const res = await window.librextv.seedPullDelta(urls);
    return res.ok ? res.added : 0;
  } catch {
    return 0;
  }
}

const fetchHttp = createFetchHttp();

let streamSeq = 0;

/**
 * 渲染层 HTTP 适配器：
 * 桌面端走主进程（无 CORS、可注入 UA），浏览器预览回退到 fetch。
 */
export const http: HttpClient = {
  async request(url, options = {}): Promise<HttpResponse> {
    if (!window.librextv) return fetchHttp.request(url, options);
    if (options.signal?.aborted) throw new Error('请求已取消');
    const pending = window.librextv.http(url, {
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      method: options.method,
      body: options.body,
    });
    // 主进程的 http:fetch 没有取消通道，但渲染层不该陪着等：
    // 搜索/分类切走之后旧请求要立刻放掉，否则「点了就走」的体验会被一条慢源拖住。
    const { signal } = options;
    let onAbort: (() => void) | undefined;
    try {
      const res = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              onAbort = () => reject(new Error('请求已取消'));
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ])
        : await pending;
      if (res.status === 0) throw new Error(res.error || '网络请求失败');
      return {
        ok: res.ok,
        status: res.status,
        url: res.url,
        headers: res.headers,
        bytes: res.bytes,
        text: res.text,
      };
    } finally {
      // 同一个 controller 会被整页的多次请求复用：不摘监听器的话，
      // 监听器（及其闭包）随请求数线性累积，长会话里泄漏。
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  },

  /**
   * 流式抓取：直播源（2.5MB / 近万频道）整串下载要一分钟以上，
   * 这里让分块边到边解析，第一批频道几百毫秒就能显示。
   * 没有主进程（浏览器预览）时退回 fetch 的流式实现。
   */
  async stream(url, options): Promise<HttpResponse> {
    if (!window.librextv) {
      if (!fetchHttp.stream) return fetchHttp.request(url, options);
      return fetchHttp.stream(url, options);
    }
    const streamId = ++streamSeq;
    // 开流前就已经取消了：不走 IPC，否则会开一条没人收的流，
    // 主进程那边只能等 idleTimeout（默认 30 秒）自己断掉。
    if (options.signal?.aborted) throw new Error('请求已取消');
    const parts: Uint8Array[] = [];
    let total = 0;
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      void window.librextv?.streamCancel(streamId);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await window.librextv.stream(
        url,
        { headers: options.headers, idleTimeoutMs: options.idleTimeoutMs, streamId },
        (chunk) => {
          if (cancelled) return;
          total += chunk.byteLength;
          parts.push(chunk);
          options.onChunk(chunk);
        }
      );
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        bytes.set(p, offset);
        offset += p.byteLength;
      }
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
      return {
        ok: res.ok,
        status: res.status,
        url: res.url,
        headers: res.headers ?? {},
        bytes,
        text: new TextDecoder('utf-8').decode(bytes),
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  },
};

/** 视频流/分片地址改写成回环代理地址（自动补 UA/Referer、绕 CORS、可选广告过滤） */
export function proxify(url: string, opts: { ad?: boolean; image?: boolean } = {}): string {
  if (!info.proxyBase) return url;
  const route = opts.image ? 'i' : 'p';
  const ad = opts.ad ? '&ad=1' : '';
  return `${info.proxyBase}/${route}?url=${encodeURIComponent(url)}${ad}`;
}

/** 封面图地址：优先本地代理（防采集站/豆瓣防盗链），无代理时直连 */
export function posterUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return proxify(url, { image: true });
}

// —— 首页推荐 ——

export type RecommendQuery =
  | { kind: 'bangumi' }
  | { kind: 'hot-list'; id: HotListId }
  | { kind: 'douban'; type: 'movie' | 'tv'; tag: string };

/**
 * 拉取首页推荐。
 *
 * 没有主进程（浏览器预览）时直接报错而不是降级成直连：
 * 豆瓣/60s 都不给跨域，静默失败只会让首页出现一块「加载失败」，
 * 不如明确告诉用户这是桌面端能力。
 */
export async function fetchRecommend(query: RecommendQuery): Promise<RecommendItem[]> {
  if (!window.librextv) throw new Error('推荐内容仅在桌面端可用');
  const result = await window.librextv.recommend(query);
  if (!result.ok) throw new Error(result.error || '推荐内容加载失败');
  return result.items.map((item) => ({
    ...item,
    listId: item.listId as HotListId | undefined,
  }));
}

export interface QualityProbeResult {
  ok: boolean;
  height?: number;
  label?: string;
  error?: string;
  reason?: string;
  retryable: boolean;
  cached: boolean;
}

/**
 * 画质探测：主进程抓 m3u8 / 分片前缀并解析。
 * 浏览器预览没有该能力，明确报错而不是静默返回「未知」。
 */
export async function qualityProbe(source: SourceConfig, vodId: string): Promise<QualityProbeResult> {
  if (!window.librextv) throw new Error('画质探测仅在桌面端可用');
  return window.librextv.qualityProbe({ source, vodId });
}

/**
 * 让主进程在后台预取接下来几个分片。
 *
 * 点击播放的那一刻就把前 8 个分片抓进代理进程的内存缓存，
 * 播放器真正开始拉流时这些分片已经是本地内存命中——这是「点开就播」的关键。
 * 故意不 await：预取是锦上添花，失败了播放也照常进行。
 */
export function prefetchSegments(url: string, opts: { ad?: boolean; count?: number } = {}): void {
  if (!info.proxyBase || !/^https?:\/\//i.test(url)) return;
  const count = opts.count ?? 8;
  const ad = opts.ad ? '&ad=1' : '';
  const target = `${info.proxyBase}/prefetch?url=${encodeURIComponent(url)}&count=${count}${ad}`;
  // 用 setTimeout 让出一帧：调用点在播放按钮里，别让网络动作压在点击处理上
  setTimeout(() => {
    void fetch(target).catch(() => {
      /* 预取失败不影响播放 */
    });
  }, 0);
}

// —— 投屏（DLNA 发送端） ——

export interface DlnaDeviceInfo {
  name: string;
  location: string;
  controlUrl: string;
}

/** 搜索局域网内可投屏设备（SSDP），约 2 秒 */
export async function discoverDlnaDevices(): Promise<{ devices: DlnaDeviceInfo[]; error?: string }> {
  if (!window.librextv) return { devices: [], error: '投屏仅在桌面端可用' };
  const result = await window.librextv.dlnaDiscover();
  return { devices: result.devices ?? [], error: result.ok ? undefined : result.error };
}

/** 把影片地址推送到指定设备并开始播放 */
export async function castToDlna(
  device: DlnaDeviceInfo,
  url: string,
  title: string
): Promise<{ ok: boolean; error?: string }> {
  if (!window.librextv) return { ok: false, error: '投屏仅在桌面端可用' };
  return window.librextv.dlnaCast(device, url, title);
}
