/**
 * 可注入的 HTTP 客户端。
 *
 * 上游把抓取放在 Next.js 服务端（/api/*），因此不存在跨域问题；
 * 客户端直连采集站时浏览器有 CORS 限制、桌面端有 Electron 主进程代理、
 * Android 端有 OkHttp。这里只定义最小接口，由各宿主注入实现。
 */

/** 单次流式响应默认最多收 64MB，见 HttpStreamOptions.maxBytes */
export const DEFAULT_STREAM_MAX_BYTES = 64 * 1024 * 1024;

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  /** 最终地址（跟随重定向后） */
  url: string;
  headers: Record<string, string>;
  /** 原始字节（gzip/二进制内容需要） */
  bytes: Uint8Array;
  /** UTF-8 解码后的文本 */
  text: string;
}

export interface HttpStreamOptions extends HttpRequestOptions {
  /** 每收到一块就回调（可能是任意切分位置，含半个 UTF-8 字符） */
  onChunk: (chunk: Uint8Array) => void;
  /** 多久没收到任何数据就判定卡死（默认 20 秒），与总时长无关 */
  idleTimeoutMs?: number;
  /**
   * 最多收多少字节（默认 64MB）。
   *
   * 直播源列表是用户随手填的地址，指向一个「无限输出」的端点（错配成视频流、
   * 或者服务端一直吐数据）时，原来的实现会一直收下去并把每一块留一份，
   * 几百 MB 直接把主进程堆撑爆。超过就断流并抛错。
   */
  maxBytes?: number;
}

export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  /**
   * 可选能力：边下边回调。
   *
   * 直播源（iptv-org 的 index.m3u 有 2.5MB）实测服务器限速到 ~35KB/s，
   * 整串下载要 70 秒以上，而解析只要十几毫秒。有了流式通道，第一个频道
   * 约 1 秒就能上屏，用户不必盯着空列表等一分多钟。
   *
   * 没实现的宿主会走 request() 的回退路径（行为不变，只是不渐进）。
   */
  stream?(url: string, options: HttpStreamOptions): Promise<HttpResponse>;
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 合并外部 signal 与超时 signal（AbortSignal.any 不可用时退化为先到先中断） */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  // 入口先看已经被取消的情况：`addEventListener` 不会补发过去的 abort，
  // 已经 aborted 的 signal 合进来只会得到一个「永远不 abort」的 controller，
  // 调用方以为取消生效了、请求照常打满整个超时。
  if (signal?.aborted) return signal;
  const timeout = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (!timeout) return signal;
  if (!signal) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([signal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanup = () => {
    signal.removeEventListener('abort', abort);
    timeout.removeEventListener('abort', abort);
  };
  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  // 任一先到就摘掉另一个：同一外部 signal 会被一个页面的多次请求复用，
  // 不摘除的话监听器随请求数累积，闭包一直持有 controller。
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller.signal;
}

/**
 * 把 body 阶段的 AbortError 映射成 408，否则超时会被当成普通网络错误。
 * 但**用户主动取消不算超时**：两者都是 AbortError，靠 external.signal 区分，
 * 否则上层会把「切搜索词/关页面」显示成超时，quality 还会当成可重试。
 */
async function readAll(res: Response, external?: AbortSignal): Promise<Uint8Array> {
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (external?.aborted) throw new HttpError('已取消', 0);
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new HttpError('请求超时', 408);
    }
    throw new HttpError(err instanceof Error ? err.message : '读取响应失败', 0);
  }
}

/** 基于全局 fetch 的实现（Electron 渲染层 / 浏览器 / Node 18+ 可用） */
export function createFetchHttp(fetchImpl?: typeof fetch): HttpClient {
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function send(url: string, options: HttpRequestOptions = {}): Promise<Response> {
    if (typeof doFetch !== 'function') throw new HttpError('当前环境没有 fetch 实现', 0);
    const { method = 'GET', headers = {}, body, timeoutMs, signal } = options;
    // 已经取消的请求不再发出去：上层（切搜索词、关页面）发起的请求可能排在
    // 限流队列里等着，等它拿到令牌时用户早就走了，白打一次上游
    if (signal?.aborted) throw new HttpError('已取消', 0);
    try {
      return await doFetch(url, {
        method,
        headers,
        body,
        redirect: 'follow',
        signal: withTimeout(signal, timeoutMs),
      });
    } catch (err) {
      if (signal?.aborted) throw new HttpError('已取消', 0);
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new HttpError('请求超时', 408);
      }
      throw new HttpError(err instanceof Error ? err.message : '网络请求失败', 0);
    }
  }

  function headersOf(res: Response): Record<string, string> {
    const headerMap: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headerMap[k.toLowerCase()] = v;
    });
    return headerMap;
  }

  return {
    async request(url, options = {}) {
      const res = await send(url, options);
      const buf = await readAll(res, options.signal);
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        headers: headersOf(res),
        bytes: buf,
        text: new TextDecoder('utf-8').decode(buf),
      };
    },

    async stream(url, options) {
      const { onChunk, idleTimeoutMs = 20_000, maxBytes = DEFAULT_STREAM_MAX_BYTES, ...rest } = options;
      // 总时长不设死线（大列表可能合法地下一分钟），只设「多久没数据」的空闲死线。
      // 但连接阶段必须有人管：上游接受连接后一直不响应时，下面那句 read() 会永久挂住。
      //
      // 关键：**不能把 idleTimeoutMs 当 timeoutMs 传给 send()**。那个 signal 在整个
      // body 生命周期内有效，会把「空闲死线」变成「总时长死线」——实测 iptv-org 的
      // 2.5MB M3U 要下 70 秒，20 秒就掐断，直播列表被静默截断且没有任何报错。
      // 所以这里只给连接阶段一个短死线：拿到响应头之后立刻解除。
      const conn = new AbortController();
      const connTimer = setTimeout(() => conn.abort(), idleTimeoutMs);
      const external = rest.signal;
      const connSignal = external ? AbortSignal.any([external, conn.signal]) : conn.signal;
      let res: Response;
      try {
        res = await send(url, { ...rest, signal: connSignal, timeoutMs: undefined });
      } catch (err) {
        clearTimeout(connTimer);
        if (err instanceof HttpError && external?.aborted) throw new HttpError('已取消', 0);
        if (conn.signal.aborted) throw new HttpError('连接超时', 408);
        throw err;
      }
      clearTimeout(connTimer);
      const chunks: Uint8Array[] = [];
      let total = 0;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timedOut = false;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          // 只有 reader.cancel() 才能真正打断在途的 read()；
          // 直接 cancel(body) 会因为流已被锁定而抛出，然后被吞掉，等于什么都没做
          void reader?.cancel().catch(() => undefined);
        }, idleTimeoutMs);
      };

      if (res.body) {
        reader = res.body.getReader();
        armIdle();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            total += value.byteLength;
            if (total > maxBytes) {
              // 先停读取再抛：不止抛出去，还要把上游连接断掉，
              // 否则服务端会继续把剩下的内容推过来
              void reader?.cancel().catch(() => undefined);
              throw new HttpError(`响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, 0);
            }
            onChunk(value);
            // 同时留一份：调用方要 text 时不必重下
            chunks.push(value);
          }
        } catch (err) {
          if (timedOut) throw new HttpError('请求超时', 408);
          if (external?.aborted) throw new HttpError('已取消', 0);
          if (err instanceof Error && err.name === 'AbortError') throw new HttpError('请求超时', 408);
          // onChunk 抛错时不能只把异常往上扔：不取消的话上游会继续把剩下的内容推完，
          // 连接一直挂到空闲死线（与上面 maxBytes 分支同样的道理）
          void reader?.cancel().catch(() => undefined);
          throw new HttpError(err instanceof Error ? err.message : '网络请求失败', 0);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      }
      if (timedOut) throw new HttpError('请求超时', 408);

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }

      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        headers: headersOf(res),
        bytes,
        text: new TextDecoder('utf-8').decode(bytes),
      };
    },
  };
}

/** 字节流是否为 gzip（1f 8b 魔数） */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** 解 gzip：优先 DecompressionStream（浏览器 / Node 18+）；不可用时原样返回 */
export async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) return bytes;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return bytes;
  }
}

/** 便捷方法：请求并解析 JSON，失败时抛出带上下文的错误 */
export async function fetchJson<T>(http: HttpClient, url: string, options?: HttpRequestOptions): Promise<T> {
  const res = await http.request(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options?.headers ?? {}) },
  });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new HttpError('返回内容不是合法 JSON', res.status);
  }
}
