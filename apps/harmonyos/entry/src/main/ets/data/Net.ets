/**
 * HTTP 客户端。
 *
 * 与 packages/core/src/http.ts 对齐的关键行为：
 * - 统一桌面 UA（采集站大多校验 UA，不带会被 403）；
 * - 区分「连不上」「超时」「HTTP 4xx/5xx」，界面才能说清是源站挂了还是本地网络问题；
 * - 响应体限长，避免个别源返回几百兆把内存打爆。
 */
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';

/** 与桌面端/Android 端一致的桌面 UA */
export const USER_AGENT: string =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 单次响应最多读这么多字符（4MB 足够放下一整页 JSON 或一份 m3u） */
const MAX_BODY_CHARS: number = 4 * 1024 * 1024;

/** 默认超时 */
export const DEFAULT_TIMEOUT_MS: number = 12_000;

export class NetError extends Error {
  status: number;

  constructor(message: string, status: number = 0) {
    super(message);
    this.name = 'NetError';
    this.status = status;
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * GET 一个文本资源。
 *
 * 鸿蒙的 http 模块必须读完响应再 destroy，否则会泄漏 native 句柄，
 * 所以这里用 try/finally 保证一定 destroy。
 */
export async function getText(url: string, opts?: RequestOptions): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new NetError('源地址不是合法的 http(s) 地址', 400);
  }
  const timeout: number = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const req = http.createHttp();
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    };
    const extra: Record<string, string> | undefined = opts?.headers;
    if (extra) {
      const keys: string[] = Object.keys(extra);
      for (let i = 0; i < keys.length; i++) {
        headers[keys[i]] = extra[keys[i]];
      }
    }
    const resp = await req.request(url, {
      method: http.RequestMethod.GET,
      header: headers,
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: Math.min(timeout, 15_000),
      readTimeout: timeout,
      usingCache: false,
      usingProxy: false,
    });
    const code: number = resp.responseCode;
    if (code < 200 || code >= 300) {
      throw new NetError(`HTTP ${code}`, code);
    }
    let body: string;
    if (typeof resp.result === 'string') {
      body = resp.result as string;
    } else {
      // 少数源忽略 expectDataType，仍回 ArrayBuffer
      const decoder = util.TextDecoder.create('utf-8');
      body = decoder.decodeToString(new Uint8Array(resp.result as ArrayBuffer));
    }
    // 超过上限直接报错，不要静默截断：
    // 截断的 JSON 会解析失败并报成「返回内容不是合法 JSON」（把人引向错的方向），
    // 截断的 m3u 会变成「只解析到一部分频道」却仍然报成功 —— 两种都比失败更难查。
    if (body.length > MAX_BODY_CHARS) {
      throw new NetError(`响应超过 ${Math.round(MAX_BODY_CHARS / 1024 / 1024)}MB，已放弃（地址可能不是清单或接口）`, 502);
    }
    return body;
  } catch (err) {
    if (err instanceof NetError) {
      throw err;
    }
    const e = err as BusinessError;
    const code: number = e && typeof e.code === 'number' ? e.code : 0;
    if (code === 2300028) {
      throw new NetError('连接超时', 408);
    }
    if (code === 2300007 || code === 2300006) {
      throw new NetError('域名解析失败', 502);
    }
    throw new NetError((e && e.message) ? e.message : '网络请求失败', 502);
  } finally {
    req.destroy();
  }
}

/** 读一个 JSON 接口；解析失败给统一文案，方便界面直接展示 */
export function parseJsonObject(text: string): Object {
  try {
    return JSON.parse(text) as Object;
  } catch (err) {
    throw new NetError('返回内容不是合法 JSON', 0);
  }
}
