/**
 * 桌面端回环媒体代理（仅监听 127.0.0.1，随机端口 + 随机 token）。
 *
 * 为什么需要它：Chromium 渲染层受 CORS 约束，hls.js 拉取跨域分片、
 * <video> 播放直链、<img> 加载豆瓣/采集站图床都会失败或缺少 Referer。
 * 上游用 Next.js 的 /api/proxy 解决；桌面端把同样的能力收敛为进程内的
 * 一个小型 HTTP 服务，不对外网暴露、不需要部署。
 *
 * 性能约束（v0.3 起）：
 * - 媒体分片必须**流式直通**：老实现把整个分片读进 Buffer 再回写，一个 6MB
 *   的分片要经历「上游→内存→本地 socket」两次全量拷贝，播放起播慢、seek 更慢；
 * - 只有播放列表（m3u8）需要读成文本做改写，且限制在很小的体积内；
 * - 分片允许浏览器缓存（内容按 URL 不变），seek 回来不必重新下。
 *
 * 安全边界：
 * - 只监听回环地址，URL 必须带随机 token（网页无法猜出）；
 * - 拒绝内网/回环/链路本地目标（避免被页面当作内网探测跳板）；
 * - 仅放行 http(s)。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { Agent } from 'undici';
import { stripAdGroups } from '@librextv/core';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 需要整体读入内存的响应体上限（播放列表/图片，通常几十 KB） */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** 流式直通的总量上限：只防失控，正常分片远小于这个值 */
const MAX_STREAM_BYTES = 1024 * 1024 * 1024;
/**
 * 实际生效的流式上限。
 *
 * 走环境变量是为了能被测试覆盖：真实上限 1GB，跑测试不可能真下 1GB 数据，
 * 没有这个开关，「超限必须断流」这条就只能靠读代码相信。
 */
function streamByteLimit(): number {
  const raw = Number(process.env.LTV_MAX_STREAM_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_STREAM_BYTES;
}
/** 重定向跟随上限：每跳都要重新校验，避免无限套娃 */
const MAX_REDIRECTS = 3;
/** 媒体代理只应服务这几类内容，其余一律按二进制处理且不发可执行 MIME */
const SAFE_IMAGE_TYPES = /^image\//i;
/**
 * `/p` 允许原样透传的媒体类型。
 *
 * 上游是第三方采集站/CDN，`Content-Type` 完全由它说了算：直接把 `text/html`
 * 以 `127.0.0.1` 同源的形式回给渲染层，等于给 XSS 留了一扇门
 * （`<video>`/hls.js 不会执行它，但同源下任何 `fetch` + 写 DOM 都会）。
 * 只放行真正会被播放器消费的类型，其余降级为 `application/octet-stream`。
 */
const SAFE_MEDIA_TYPES = /^(video\/|audio\/|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|application\/octet-stream)/i;
/** 分片这类不可变内容，允许浏览器缓存，seek 回来直接命中 */
const CACHE_SEGMENT = 'public, max-age=3600, immutable';
/**
 * 预取缓存上限。
 *
 * 起播时的瓶颈是「等第一个分片从上游下来」。点击播放的同时后台按顺序抓
 * 前若干分片放进这张表，播放器再来要同一个分片时直接从内存回，省掉整个 RTT。
 * 64MB 约合 1~2 分钟的 1080p 内容，足够盖住起播与首次 seek。
 */
const PREFETCH_MAX_BYTES = 64 * 1024 * 1024;
/** 单个分片参与预取的上限：太大的分片占用配额不值得 */
const PREFETCH_MAX_SEGMENT = 8 * 1024 * 1024;
/** 默认预取的分片数：够覆盖起播缓冲（hls.js 默认 30 秒）即可，多了纯浪费带宽 */
const PREFETCH_DEFAULT_COUNT = 8;
/** 预取并发：和播放抢带宽，别开太大 */
const PREFETCH_CONCURRENCY = 3;
/** 单个分片的预取超时：上游半死不活时不能把整条链路挂住 */
const PREFETCH_TIMEOUT_MS = 8_000;
/** 预取时最多往下钻几层播放列表（master → 变体 → 分片） */
const PREFETCH_MAX_DEPTH = 2;
/**
 * 「等到响应头」的死线。
 *
 * 直播最常见的一种「加载不出来」是上游接了连接却永不回响应：没有超时的话这一跳
 * 会一直挂着，播放器既拿不到数据也不报错，界面只能靠 20 秒看门狗兜底 —— 观感就是
 * 「一直转圈」。这里只管**响应头**，body 该怎么慢就怎么慢：分片的传输时长取决于
 * 体积和网速，套一个总时长超时会把正常的大分片砍成半截（半截分片 = 花屏）。
 */
const HEADER_TIMEOUT_MS = 12_000;
/**
 * DNS 结果缓存。
 *
 * 实测单次 `dns.lookup` 只要 0~26ms，本身不是瓶颈；但直播每一路分片、每一次换台
 * 都要重新解析一遍，万级频道列表下毫无意义地累加延迟。这里按 host 缓存一分钟，
 * 并在校验内网地址**之后**才写入 —— 缓存的是已确认安全的解析结果。
 */
const DNS_TTL_MS = 60_000;
/** 缓存条目上限：直播源动辄几百个域名，无上限就是内存泄漏 */
const DNS_CACHE_MAX = 512;

/**
 * 抓上游媒体用的请求头。
 *
 * `Referer` 必须带：采集站/CDN 常见防盗链，少了它分片直接 403。
 * 正常播放路径与预取路径必须用同一份逻辑，否则会出现「能播但预取永远 0 命中」
 * 这种无声失效。
 */
export function mediaRequestHeaders(target: URL): Record<string, string> {
  return {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    Referer: refererFor(target),
  };
}

/**
 * 防盗链的 Referer 不总是「自己的 origin」。
 *
 * 豆瓣图床（img*.doubanio.com）只认 `https://movie.douban.com/`，用图床自身的
 * origin 会被 403；首页推荐里的豆瓣海报就靠这一条。其余图床/采集站仍按 origin 走。
 */
function refererFor(target: URL): string {
  if (/(^|\.)(doubanio|douban)\.com$/i.test(target.hostname)) return 'https://movie.douban.com/';
  return `${target.origin}/`;
}

/**
 * 把 URL 里内嵌的 `user:pass@` 转成 `Authorization: Basic` 头。
 *
 * undici 对含凭据的 URL 直接抛 `TypeError: Request cannot be constructed from
 * a URL that includes credentials`，于是 `http://user:pass@host/...` 这类源
 * （部分采集站的接口地址就是这种）在桌面端 100% 不可播。
 * 转成请求头既让它们能播，又不会把明文密码留在 URL 里。
 */
function splitCredentials(url: URL): { href: string; authorization?: string } {
  if (!url.username && !url.password) return { href: url.href };
  let user = url.username;
  let pass = url.password;
  try {
    user = decodeURIComponent(user);
    pass = decodeURIComponent(pass);
  } catch {
    /* 百分号编码不合法就按原样用 */
  }
  const clean = new URL(url.href);
  clean.username = '';
  clean.password = '';
  return {
    href: clean.href,
    authorization: `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`,
  };
}

/** 错误文案里不能出现明文密码：把 `scheme://user:pass@` 里的凭据抹掉 */
export function redactUrl(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

export interface MediaProxy {
  base: string;
  token: string;
  close: () => Promise<void>;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    // IANA 特殊用途地址：这些既不是公网可路由地址，也是 SSRF 的常见跳板
    // （云元数据、基准测试网段、文档示例网段、保留段与广播）
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24（含 .9/.10 协议分配）
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a >= 240) return true; // 240.0.0.0/4 保留 + 255.255.255.255 广播
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped IPv6：既可能是 ::ffff:127.0.0.1，也可能是 ::ffff:7f00:1（压缩十六进制），
  // 后者 net.isIPv4 不认，必须先把末 32 位按数值还原成点分再判
  const mapped = mappedIPv4(lower);
  if (mapped) return isPrivateAddress(mapped);
  // IPv6 按首字节判段：fe80::/10 是链路本地（含 feb0/fec0…），fc00::/7 是唯一本地
  const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
  if (Number.isFinite(firstHextet)) {
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7
    if (firstHextet === 0x64 && lower.startsWith('64:ff9b')) return true; // NAT64
  }
  return false;
}

/** 把 ::ffff:a.b.c.d / ::ffff:7f00:1 这类 IPv4-mapped 地址还原成点分十进制 */
function mappedIPv4(lower: string): string | null {
  if (!lower.startsWith('::ffff:')) return null;
  const tail = lower.slice('::ffff:'.length);
  if (net.isIPv4(tail)) return tail;
  // 压缩写法：最后两段各是 16 位十六进制
  const groups = tail.split(':');
  if (groups.length !== 2) return null;
  const hi = parseInt(groups[0], 16);
  const lo = parseInt(groups[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

interface DnsEntry {
  expires: number;
  records: { address: string; family: number }[];
}

const dnsCache = new Map<string, DnsEntry>();
const dnsInflight = new Map<string, Promise<{ address: string; family: number }[]>>();

/**
 * 带缓存的域名解析（供内网地址校验使用）。
 *
 * 并发去重很关键：一个播放列表里常有十几个同域分片同时被请求，
 * 没有 in-flight 合并的话缓存只会把「N 次串行解析」变成「N 次并发解析」。
 */
async function lookupCached(host: string): Promise<{ address: string; family: number }[]> {
  const hit = dnsCache.get(host);
  if (hit && hit.expires > Date.now()) return hit.records;

  const pending = dnsInflight.get(host);
  if (pending) return pending;

  const task = dns
    .lookup(host, { all: true })
    .then((records) => {
      if (dnsCache.size >= DNS_CACHE_MAX) dnsCache.clear();
      dnsCache.set(host, { expires: Date.now() + DNS_TTL_MS, records });
      return records;
    })
    .finally(() => dnsInflight.delete(host));
  dnsInflight.set(host, task);
  return task;
}

/**
 * 把已校验过的解析结果钉给 undici 的连接器。
 *
 * 为什么需要：`assertAllowedTarget` 用 `dns.lookup` 校验一次，`fetch` 内部由 undici
 * 再解析一次。两次之间 DNS 可以变脸（rebinding：第一次公网 IP 过校验、第二次内网 IP
 * 建连接），校验就白做了。这里把已校验的 IP 直接交给 `connect.lookup`，undici 不再自己解析。
 *
 * 兜底：连接器只对「本次已解析过的主机名」生效；主机名对不上时回落到系统解析（正常路径
 * 不会走到，因为同一跳的 host 刚在 `assertAllowedTarget` 里解析过）。
 */
const pinnedByHost = new Map<string, { address: string; expires: number }>();
const PINNED_MAX = 256;
const PINNED_TTL_MS = 60_000;

/** 记住「某主机名刚刚校验通过的 IP」，连接时钉死在同一地址 */
function pinResolution(host: string, address: string): void {
  if (pinnedByHost.size >= PINNED_MAX) pinnedByHost.clear();
  pinnedByHost.set(host, { address, expires: Date.now() + PINNED_TTL_MS });
}

function pinnedAddressOf(host: string): string | null {
  const hit = pinnedByHost.get(host);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    pinnedByHost.delete(host);
    return null;
  }
  return hit.address;
}

const pinnedAgents = new Map<string, Agent>();
const PINNED_AGENT_MAX = 64;

function agentPinnedTo(host: string, address: string): Agent {
  const key = `${host}|${address}`;
  const hit = pinnedAgents.get(key);
  if (hit) return hit;
  const agent = new Agent({
    connect: {
      lookup: (hostname: string, options: { all?: boolean }, cb: (...args: never[]) => void): void => {
        const reply = cb as unknown as (
          err: NodeJS.ErrnoException | null,
          address?: string | { address: string; family: number }[],
          family?: number
        ) => void;
        const pinned = hostname === host ? address : null;
        const all = Boolean((options as { all?: boolean }).all);
        if (pinned) {
          if (all) reply(null, [{ address: pinned, family: net.isIPv6(pinned) ? 6 : 4 }]);
          else reply(null, pinned, net.isIPv6(pinned) ? 6 : 4);
          return;
        }
        dns.lookup(hostname, { all: true }).then(
          (res) => {
            if (all) reply(null, res);
            else reply(null, res[0]?.address, res[0]?.family);
          },
          (err: unknown) => reply(err as NodeJS.ErrnoException)
        );
      },
    },
  });
  if (pinnedAgents.size >= PINNED_AGENT_MAX) {
    const oldestKey = pinnedAgents.keys().next();
    if (!oldestKey.done) {
      const oldest = pinnedAgents.get(oldestKey.value);
      pinnedAgents.delete(oldestKey.value);
      void oldest?.close().catch(() => undefined);
    }
  }
  pinnedAgents.set(key, agent);
  return agent;
}

/** 目标地址校验：协议白名单 + 内网地址拒绝（DNS 解析后校验，防域名绕过） */
export async function assertAllowedTarget(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('无效地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http(s) 地址');
  if (allowPrivate) return url;
  // IPv6 字面量在 WHATWG URL 里带方括号（new URL('http://[::1]/').hostname === '[::1]'），
  // 而 net.isIP('[::1]') === 0。不剥括号就会落到 dns.lookup('[::1]') 那一支，
  // 靠「解析失败」被间接拦住——防护只剩副作用，任何解析行为变化都会立刻变成真 SSRF。
  const hostname = url.hostname;
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('拒绝访问本机地址');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('拒绝访问内网地址');
    return url;
  }
  const records = await lookupCached(host).catch(() => []);
  if (records.length === 0) throw new Error('域名解析失败');
  if (records.some((r) => isPrivateAddress(r.address))) throw new Error('拒绝访问内网地址');
  // 把「刚刚校验通过的那个 IP」记下来，让实际连接钉在同一地址上（防 DNS rebinding：
  // 校验用公网 IP、连接时换成内网 IP）。优先 IPv4：部分源站 IPv6 质量差。
  const chosen = records.find((r) => r.family === 4) ?? records[0];
  if (chosen) pinResolution(host, chosen.address);
  return url;
}

/**
 * 带逐跳校验的 fetch。
 *
 * 为什么不能用 `redirect: 'follow'`：校验只发生在入口，一旦上游 302 到内网地址，
 * 后续请求完全脱离控制（实测可借代理读回 127.0.0.1 上的内容）。
 * 这里改为手动跟随，每一跳都重新跑一遍校验。
 *
 * @param validate 每一跳都要通过的地址校验，默认用 assertAllowedTarget
 */
export async function fetchChecked(
  target: URL,
  init: RequestInit & { duplex?: string },
  allowPrivate: boolean,
  validate: (raw: string, allowPrivate: boolean) => Promise<URL> = assertAllowedTarget,
  headerTimeoutMs = HEADER_TIMEOUT_MS
): Promise<Response> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 超时只覆盖「等响应头」这一段：拿到头之后立刻清掉定时器，
    // body 继续按网络速度流式读取（大分片本来就要下好几秒）。
    const gate = new AbortController();
    const timer = setTimeout(() => {
      gate.abort(new Error(`上游 ${headerTimeoutMs / 1000}s 内没有响应`));
    }, headerTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal as AbortSignal, gate.signal]) : gate.signal;
    let res: Response;
    try {
      // 含凭据的 URL 交给 undici 会直接抛错：这里转成 Authorization 头再发，
      // 顺带让 query/metrics 里不再出现明文密码。
      const { href, authorization } = splitCredentials(current);
      const headers = new Headers(init.headers);
      if (authorization) headers.set('Authorization', authorization);
      // 连接钉在「刚校验通过的那个 IP」上：undici 不再自己解析域名，
      // 否则校验与连接之间的 DNS 变脸就能把内网地址塞进来（rebinding）。
      const pinned = pinnedAddressOf(current.hostname);
      const dispatcher = pinned ? agentPinnedTo(current.hostname, pinned) : undefined;
      res = await fetch(href, {
        ...init,
        headers,
        redirect: 'manual',
        method: init.method,
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      // 释放这一跳的连接，避免 keep-alive 池堆积
      await res.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('重定向地址无效');
      }
      current = await validate(next.href, allowPrivate);
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多');
}

/**
 * 把远端播放列表里的相对/绝对地址全部改写成经过本代理的地址。
 *
 * `live` 会作为参数一路传给子请求：直播分片 URL 每次都带新的序号，缓存与预取
 * 对它毫无价值（永远不可能命中），却要为此在内存里复制一遍整片 —— 直播走
 * `live=1` 之后代理只做透传，省掉这层无谓开销。
 */
function rewritePlaylist(
  body: string,
  baseUrl: string,
  proxyBase: string,
  adFilter: boolean,
  live = false
): string {
  const proxify = (target: string): string => {
    try {
      const abs = new URL(target, baseUrl).href;
      const flag = live ? '&live=1' : '';
      return `${proxyBase}/p?ad=${adFilter ? 1 : 0}${flag}&url=${encodeURIComponent(abs)}`;
    } catch {
      return target;
    }
  };

  const text = adFilter ? stripAdGroups(body) : body;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith('#')) return proxify(trimmed);
      // 属性里带 URI 的标签：密钥 / 初始化段 / 备用媒体 / 低延迟分片。
      // 少数打包器写单引号，两种都要处理。
      return trimmed
        .replace(/URI="([^"]+)"/gi, (_m, uri: string) => `URI="${proxify(uri)}"`)
        .replace(/URI='([^']+)'/gi, (_m, uri: string) => `URI="${proxify(uri)}"`);
    })
    .join('\n');
}

function isPlaylist(res: Response, body: string): boolean {
  const type = res.headers.get('content-type') || '';
  if (/mpegurl/i.test(type)) return true;
  // 带 UTF-8 BOM 的 m3u8 也要认：否则会被当二进制透传，播放器直接黑屏
  return body.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

/** 从响应体开头判断是不是 m3u8（只看前 64 字节，避免为了判断而读满整个分片） */
function looksLikePlaylistHead(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  const text = Buffer.from(head.buffer, head.byteOffset, Math.min(head.length, 64)).toString('utf8');
  return text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

/**
 * 有上限地读取响应体（只用于播放列表与图片这类小对象）。
 *
 * 之前的实现在 `arrayBuffer()` 之后才判长度——那时数据已经全量进堆，
 * 判长只能挡「写完才发现超了」，挡不住 OOM。这里改为流式累加，超限立即取消。
 */
/**
 * 流式读取响应体并限长。
 *
 * 关键点：**先看 Content-Length 早退，再边收边累加**。旧写法
 * `new Uint8Array(await res.arrayBuffer())` 会先把整份响应读进堆再判长度，
 * chunked 或没有 Content-Length 的响应根本不受上限约束——一个无限流就能把
 * 主进程打爆。分类/搜索走的就是这条 IPC，触发面很广。
 */
export async function readLimited(res: Response, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('响应体过大');
  }
  if (!res.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      await res.body.cancel().catch(() => undefined);
      throw new Error('响应体过大');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** 把已经读走的第一块拼回去，得到完整响应体 */
async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array | null): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  if (first) {
    chunks.push(Buffer.from(first));
    total += first.byteLength;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('响应体过大');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 供单测直接验证 m3u8 改写（生产路径只经 handle 调用） */
export const rewritePlaylistForTest = rewritePlaylist;
export const isPlaylistForTest = isPlaylist;

/**
 * 预取分片的内存缓存。
 *
 * 键是**原始上游地址**（不含代理 token），这样换 token/换端口都不影响命中。
 * LRU：播放器真去要某个分片时把它挪到队尾，淘汰从队首开始。
 */
interface PrefetchEntry {
  body: Buffer;
  contentType: string;
  status: number;
  /** 上游的 206 相关头（目前只在完整 200 时为空），留着给将来做 Range 切片用 */
  headers: Record<string, string>;
}

class SegmentCache {
  private readonly map = new Map<string, PrefetchEntry>();
  private bytes = 0;

  get(key: string): PrefetchEntry | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // 命中即刷新 LRU 位置
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  put(key: string, entry: PrefetchEntry): void {
    if (entry.body.byteLength > PREFETCH_MAX_SEGMENT) return;
    // 空响应不进缓存：它不贡献配额，却会让 map 无限增长
    if (entry.body.byteLength === 0) return;
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.body.byteLength;
      this.map.delete(key);
    }
    this.map.set(key, entry);
    this.bytes += entry.body.byteLength;
    // 超配额就从最旧的开始丢，直到回到配额内
    for (const [oldKey, oldValue] of this.map) {
      if (this.bytes <= PREFETCH_MAX_BYTES) break;
      if (oldKey === key) break;
      this.bytes -= oldValue.body.byteLength;
      this.map.delete(oldKey);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get bytesCached(): number {
    return this.bytes;
  }
}

export interface PrefetchRequest {
  /** 播放列表地址或单个媒体地址 */
  url: string;
  /** 预取几个分片，默认 8 */
  count?: number;
  /** 是否按记录切广告段（与播放一致） */
  ad?: boolean;
}

export interface PrefetchResult {
  ok: boolean;
  /** 已缓存的分片数 */
  cached: number;
  /** 缓存后的总字节数 */
  bytes: number;
  /** 播放列表是否成功解析 */
  playlist: boolean;
  error?: string;
}

/**
 * master 播放列表（多码率）判定。
 *
 * 它的「分片行」其实是子播放列表地址，不能当分片去预取，也不能进缓存
 * （否则命中时会把未改写的 m3u8 原样回给播放器）。
 */
function isMasterPlaylist(playlistText: string): boolean {
  return /#EXT-X-STREAM-INF/i.test(playlistText);
}

/** 取某个变体在 master 里声明的带宽（找不到就当 0，排序时排最前） */
function bandwidthOf(playlistText: string, variantUrl: string): number {
  const lines = playlistText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^#EXT-X-STREAM-INF/i.test(line)) continue;
    const match = /BANDWIDTH=(\d+)/i.exec(line);
    const bandwidth = match ? Number(match[1]) : 0;
    // 下一行非注释行就是这个变体的地址
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (next === '' || next.startsWith('#')) continue;
      if (next === variantUrl || variantUrl.endsWith(next)) return bandwidth;
      break;
    }
  }
  return 0;
}

/** 从 m3u8 文本里按顺序取出分片绝对地址（跳过广告与加密 key） */
function segmentUrls(playlistText: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const rawLine of playlistText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    try {
      out.push(new URL(line, baseUrl).href);
    } catch {
      /* 非法行直接忽略 */
    }
  }
  return out;
}

export async function startMediaProxy(): Promise<MediaProxy> {
  const token = crypto.randomBytes(16).toString('hex');
  let base = '';
  const cache = new SegmentCache();
  /**
   * 正在下载中的分片。
   *
   * 桌面端有两条预热入口：渲染层点击播放时调 `/prefetch`，代理自己回 m3u8 时
   * 也会后台预热。两条链路几乎同时启动，只在 `cache.get()` 判重是挡不住的——
   * 双方都在对方 `put` 之前看到「没缓存」，同一批分片就被下了两遍。
   */
  const inflight = new Set<string>();
  /** 命中率统计：只看计数，不含任何上游内容 */
  const stats = { hits: 0, misses: 0 };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      // 错误文案会打到界面上：上游地址里可能内嵌 user:pass，必须先抹掉
      const message = redactUrl(err instanceof Error ? err.message : '未知错误');
      if (!res.headersSent) sendText(res, 502, `代理失败：${message}`);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url) {
      sendText(res, 400, '缺少参数');
      return;
    }
    const url = new URL(req.url, base);
    const prefix = `/t/${token}`;
    if (!url.pathname.startsWith(prefix)) {
      sendText(res, 403, 'token 无效');
      return;
    }
    const route = url.pathname.slice(prefix.length);
    if (route !== '/p' && route !== '/i' && route !== '/prefetch' && route !== '/stats') {
      sendText(res, 404, '未知路由');
      return;
    }

    // 缓存状态：给 e2e 与排查用（不含任何上游内容，只报计数）
    if (route === '/stats') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ segments: cache.size, bytes: cache.bytesCached, hits: stats.hits, misses: stats.misses }));
      return;
    }

    const target = url.searchParams.get('url') || '';
    const adFilter = url.searchParams.get('ad') === '1';
    /** 直播分片（播放列表里标了 live=1）：跳过缓存与预热，只做透传 */
    const isLive = url.searchParams.get('live') === '1';
    // 自建/联调场景：允许访问内网媒体源（默认关闭，保持 SSRF 边界）
    const allowPrivate = process.env.LTV_ALLOW_PRIVATE_MEDIA === '1';

    if (route === '/prefetch') {
      // 点击播放的同时后台预热：解析播放列表 → 顺序抓前 N 个分片进内存缓存。
      // 播放器随后真正请求这些分片时直接命中，省掉每个分片一个 RTT。
      const count = Number(url.searchParams.get('count') || PREFETCH_DEFAULT_COUNT);
      try {
        const result = await prefetch(target, count, adFilter, allowPrivate);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            ok: false,
            cached: 0,
            bytes: cache.bytesCached,
            playlist: false,
            error: err instanceof Error ? err.message : '预取失败',
          } satisfies PrefetchResult)
        );
      }
      return;
    }

    let targetUrl: URL;
    try {
      targetUrl = await assertAllowedTarget(target, allowPrivate);
    } catch (err) {
      sendText(res, 400, err instanceof Error ? err.message : '地址不可用');
      return;
    }

    // —— /p 预取命中（必须在回源之前查，否则等于没省）——
    // 点击播放时后台已经把前几个分片抓进内存，播放器来要时直接给，省掉整个上游 RTT。
    //
    // 带 Range 的请求**绝不能**吃缓存：缓存里存的是完整分片（预取用的是没有 Range
    // 的 GET），而命中分支只会按 200 回整段。`#EXT-X-BYTERANGE` 的源（hls.js 会发
    // `Range: bytes=X-Y`）拿到整段却按自己的范围去切片，解出来是错位的字节 —— 花屏，
    // 比慢一点糟糕得多。这类请求一律回源，让上游自己回 206。
    const rangeHeader = req.headers.range;
    const cacheEligible = route === '/p' && !rangeHeader && !isLive;
    if (cacheEligible) {
      const cached = cache.get(targetUrl.href);
      if (cached) {
        stats.hits += 1;
        // 缓存里也可能是播放列表，但它带 token、必须每次重写，不能按 hour 缓存
        const cachedPlaylist = looksLikePlaylistHead(cached.body);
        // 命中分支也要过白名单：cache 里存的是上游原始 Content-Type（写入时不改，
        // 因为 /p 返回 206 时同样要回原值），直接透传就等于给 text/html 开了
        // 一条「以本机同源身份执行」的旁路 —— pipeStream 那边已经降级了，这里不能漏。
        const cachedType = SAFE_MEDIA_TYPES.test(cached.contentType) ? cached.contentType : 'application/octet-stream';
        res.writeHead(cached.status, {
          'Content-Type': cachedType,
          'Content-Length': String(cached.body.byteLength),
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': cachedPlaylist ? 'no-store' : CACHE_SEGMENT,
        });
        res.end(cached.body);
        return;
      }
      stats.misses += 1;
    }

    const headers = mediaRequestHeaders(targetUrl);
    if (rangeHeader) headers.Range = String(rangeHeader);
    const encoding = req.headers['accept-encoding'];
    if (encoding) headers['Accept-Encoding'] = String(encoding);

    const init: RequestInit & { duplex?: string } = {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'manual',
    };
    // 逐跳校验重定向：上游 302 到 127.0.0.1 / 内网必须被拦下
    const upstream = await fetchChecked(targetUrl, init, allowPrivate);

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const bodyless = upstream.status === 204 || upstream.status === 304;

    if (route === '/i') {
      const buf = await readLimited(upstream, 8 * 1024 * 1024);
      // 只放行图片类型：避免把 text/html 以同源方式回给渲染层（等于给 XSS 开门）
      const safeType = SAFE_IMAGE_TYPES.test(contentType) ? contentType : 'application/octet-stream';
      res.writeHead(upstream.status, {
        'Content-Type': safeType,
        'Content-Length': String(buf.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        // 失败的响应不能按「一小时不变」缓存：否则一张 404 的封面会整整一小时都刷不出来
        'Cache-Control': upstream.ok ? CACHE_SEGMENT : 'no-store',
      });
      res.end(buf);
      return;
    }

    // —— /p 媒体路由 ——
    // content-type 直接标明是播放列表时无需窥探；否则先读第一块判断
    const declaredPlaylist = /mpegurl/i.test(contentType);
    const reader = upstream.body && !bodyless ? upstream.body.getReader() : null;
    let first: Uint8Array | null = null;
    if (reader && !declaredPlaylist) {
      const read = await reader.read();
      if (!read.done) first = read.value;
    }

    const playlist = declaredPlaylist || (first ? looksLikePlaylistHead(first) : false);

    if (playlist) {
      if (!reader) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': '0',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      // 播放列表是小文本：整体读入 → 改写成代理地址。
      // 相对路径必须按**最终地址**解析：CDN 常常 302 到另一个目录，
      // 用入口 URL 当基准会把分片拼到错的路径上（表现为起播黑屏 / 404）。
      const buf = await readRest(reader, first);
      const text = buf.toString('utf8');
      const playlistBase = upstream.url || targetUrl.href;
      // 判直播只看**媒体列表**：没有 `#EXT-X-ENDLIST` 说明它还在滚动。
      //
      // master 列表（#EXT-X-STREAM-INF）按 RFC 8216 本来就不含 ENDLIST，它的
      // 「分片行」其实是变体播放列表地址。早先这里把 master 也当成直播，于是
      // `&live=1` 被写进变体地址、再被写进每个分片地址，下游全部跳过缓存：
      // SegmentCache 与 /prefetch 对多码率源整条链路失效，白白回源与烧带宽。
      // 正确做法是 master 不传播 live，让变体自己按 ENDLIST 判定。
      const masterPlaylist = isMasterPlaylist(text);
      const liveMode = isLive || (!masterPlaylist && !text.includes('#EXT-X-ENDLIST'));
      const rewritten = upstream.ok
        ? rewritePlaylist(text, playlistBase, `${base}${prefix}`, adFilter, liveMode)
        : text;
      const out = Buffer.from(rewritten, 'utf8');
      res.writeHead(upstream.ok ? 200 : upstream.status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(out.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(out);

      // 把分片地址顺手预热：播放器拿到这份 m3u8 才会去要分片，
      // 此刻开始抓，等它真的来要时前几片大概率已经在内存里。
      // 注意两点：
      // 1) 必须用**改写前**的文本：改写后全是本机代理地址，拿去预热等于自己请求自己；
      // 2) 必须用**已切广告**的文本：开了广告过滤时播放器根本不会去要那几段广告，
      //    照原样预热等于白下几 MB，还挤占真正要看的分片的带宽。
      // 故意不 await：响应已经发出去了，预热是纯后台动作，失败也不影响播放。
      // 直播列表不预热：分片序号一直在滚动，等播放器真要时这些分片早过期了，
      // 白下几 MB 还会和真正的起播抢带宽。
      if (upstream.ok && !liveMode) {
        const warmBody = adFilter ? stripAdGroups(text) : text;
        // master 列表里列的是子播放列表，按「分片」去抓只会白下一个 m3u8，
        // 真正的分片要等播放器挑了码率才知道。这种情况交给客户端后的 /prefetch
        // （它会往下钻一层挑变体），这里不做无用功。
        if (!isMasterPlaylist(warmBody)) {
          const warmList = segmentUrls(warmBody, playlistBase).slice(0, PREFETCH_DEFAULT_COUNT);
          if (warmList.length > 0) {
            void warmSegments(warmList, allowPrivate).catch(() => undefined);
          }        }
      }
      return;
    }

    // 真正的媒体分片：流式直通，边下边发，不在内存里攒完整块
    // 顺带把副本写进预取缓存（`cacheable`）：播放器重播/回看同一分片时不必回源
    // 直播分片不缓存：URL 带滚动序号，缓存永远不命中，复制一遍纯属浪费
    await pipeStream(
      upstream,
      reader,
      first,
      res,
      contentType,
      req,
      req.method !== 'HEAD' && upstream.status === 200 && !rangeHeader && !isLive,
      targetUrl.href,
      isLive
    );
  }

  /**
   * 把上游响应体流式转发给渲染层。
   *
   * 关键点：
   * - 不缓冲整个分片，首字节到达就往下游写（起播快、seek 快）；
   * - 尊重下游背压（`res.write` 返回 false 时等 drain），否则大分片会堆在内存；
   * - 下游提前断开时取消上游读取，避免继续下载已无人消费的数据。
   */
  /**
   * 后台预取：解析播放列表，按顺序抓前 `count` 个分片进内存缓存。
   *
   * 只在客户端点击播放时调一次。失败的单个分片不算失败——CDN 偶尔抽风，
   * 能缓存几个算几个，播放器真去要没缓存到的分片时照样走正常流式路径。
   */
  async function prefetch(
    target: string,
    count: number,
    adFilter: boolean,
    allowPrivate: boolean
  ): Promise<PrefetchResult> {
    const wanted = Math.max(1, Math.min(32, Number.isFinite(count) ? count : PREFETCH_DEFAULT_COUNT));

    const first = await assertAllowedTarget(target, allowPrivate);
    const init: RequestInit = { headers: mediaRequestHeaders(first), redirect: 'manual' };
    // 预取链路上的每个请求都要自带死线：预取是后台行为，上游半死不活时
    // 不能把连接和缓存配额一直占着（`/p` 那条路早就这么做了）。
    const withDeadline = (): RequestInit => ({ ...init, signal: AbortSignal.timeout(PREFETCH_TIMEOUT_MS) });

    // master 播放列表里列的是子播放列表而不是分片。遇到这种必须往下钻一层
    // 再取分片，否则「预取」在多码率源（国内采集站的主流形态）上恒等于空操作，
    // 却还返回 ok:true —— 调用方完全看不出它什么都没做。
    let listUrl = first;
    let text = '';
    let lastBody = '';
    for (let depth = 0; depth <= PREFETCH_MAX_DEPTH; depth += 1) {
      const playlistRes = await fetchChecked(listUrl, withDeadline(), allowPrivate);
      if (!playlistRes.ok) {
        return { ok: false, cached: 0, bytes: cache.bytesCached, playlist: false, error: `HTTP ${playlistRes.status}` };
      }
      lastBody = (await readLimited(playlistRes, PREFETCH_MAX_SEGMENT)).toString('utf8');
      text = adFilter ? stripAdGroups(lastBody) : lastBody;
      const listed = segmentUrls(text, playlistRes.url || listUrl.href);
      if (listed.length === 0) {
        // 不是播放列表（直链 mp4 之类）：把这条直链本身读进缓存
        const single = await fetchChecked(first, withDeadline(), allowPrivate);
        if (!single.ok) {
          return { ok: false, cached: 0, bytes: cache.bytesCached, playlist: false, error: `HTTP ${single.status}` };
        }
        const buf = await readLimited(single, PREFETCH_MAX_SEGMENT);
        if (looksLikePlaylistHead(buf)) {
          return { ok: false, cached: 0, bytes: cache.bytesCached, playlist: true, error: '请用播放列表路径预取' };
        }
        cache.put(first.href, {
          body: buf,
          contentType: single.headers.get('content-type') || 'application/octet-stream',
          status: single.status,
          headers: {},
        });
        return { ok: true, cached: 1, bytes: cache.bytesCached, playlist: false };
      }
      // 判断这一层列的是分片还是子播放列表：只有前者才值得预取
      if (!isMasterPlaylist(text)) {
        const { created, already } = await warmSegments(listed.slice(0, wanted), allowPrivate);
        const usable = created + already;
        if (usable === 0) {
          return {
            ok: false,
            cached: 0,
            bytes: cache.bytesCached,
            playlist: true,
            error: '这些分片都没能抓到（可能被防盗链拦下或全部失败）',
          };
        }
        return { ok: true, cached: usable, bytes: cache.bytesCached, playlist: true };
      }
      // 是 master：按带宽取中间那档往下钻
      const variants = listed.slice().sort((a, b) => bandwidthOf(text, a) - bandwidthOf(text, b));
      const picked = variants[Math.floor(variants.length / 2)] ?? variants[0];
      if (!picked) break;
      try {
        listUrl = await assertAllowedTarget(picked, allowPrivate);
      } catch {
        break;
      }
    }
    // 钻到这里说明 master 里没有可用的变体，如实上报而不是假装成功
    return {
      ok: false,
      cached: 0,
      bytes: cache.bytesCached,
      playlist: true,
      error: lastBody ? '播放列表里没有可预取的分片' : '播放列表为空',
    };
  }

  /**
   * 把一组分片抓进内存缓存。
   *
   * 顺序 + 小并发：不要打乱顺序（播放器是按顺序取前几个），也不要全开抢带宽。
   *
   * 返回值区分「这次新抓到的」与「本来就在缓存里的」：调用方判断成功与否要看
   * 两者之和，否则「重复预取同一批分片」会被误判成失败。
   */
  async function warmSegments(segments: string[], allowPrivate: boolean): Promise<{ created: number; already: number }> {
    let created = 0;
    let already = 0;
    let index = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const current = index++;
        if (current >= segments.length) return;
        const segmentUrl = segments[current];
        let key = segmentUrl;
        // 同一分片可能被两条预热链路同时盯上（渲染层 /prefetch + 代理回 m3u8 时自动预热）。
        // 只查 cache 是挡不住的：双方都在对方 put 之前看到「没缓存」。
        if (inflight.has(key)) continue;
        inflight.add(key);
        try {
          const segmentTarget = await assertAllowedTarget(segmentUrl, allowPrivate);
          key = segmentTarget.href;
          // 已经预热过就跳过：代理返回 m3u8 时会自动预热，客户端可能又显式请求一次
          if (cache.get(key)) {
            already += 1;
            continue;
          }
          const res = await fetchChecked(
            segmentTarget,
            {
              headers: mediaRequestHeaders(segmentTarget),
              redirect: 'manual',
              // 上游半死不活时不能把整条链路挂住：超时算这一片失败，继续下一片
              signal: AbortSignal.timeout(PREFETCH_TIMEOUT_MS),
            },
            allowPrivate
          );
          // 只认 200：206 是局部响应，当整段缓存会给出错位数据
          if (res.status !== 200) continue;
          const buf = await readLimited(res, PREFETCH_MAX_SEGMENT);
          // **不能缓存播放列表**。master m3u8 里的「分片」其实还是子播放列表；
          // 把它的原始内容塞进缓存后，/p 命中时会把**未改写**的 m3u8 原样返回，
          // 播放器于是拿到直连 CDN 的地址 → 跨域被拦、或者丢了 Referer 被判盗链，
          // 表现为「某些片子起播直接黑屏」。这类响应交给正常的改写路径处理。
          if (looksLikePlaylistHead(buf)) continue;
          cache.put(key, {
            body: buf,
            contentType: res.headers.get('content-type') || 'video/mp2t',
            status: res.status,
            headers: {},
          });
          created += 1;
        } catch {
          /* 单个分片失败不影响其它分片 */
        } finally {
          inflight.delete(key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, segments.length) }, worker));

    return { created, already };
  }

  async function pipeStream(
    upstream: Response,
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
    first: Uint8Array | null,
    res: ServerResponse,
    rawContentType: string,
    req: IncomingMessage,
    cacheable = false,
    cacheKey = '',
    live = false
  ): Promise<void> {
    // 上游的 Content-Type 只当"声明"，不当"事实"：非媒体类型一律降级成二进制，
    // 避免把 text/html 之类以本机同源形式回给渲染层（见 SAFE_MEDIA_TYPES）。
    const contentType = SAFE_MEDIA_TYPES.test(rawContentType) ? rawContentType : 'application/octet-stream';
    const headers: Record<string, string | number> = {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      // 分片内容按 URL 恒定：允许缓存，seek/重播不用回源；
      // 直播分片只此一次，缓存一小时后半段早已过期，反而会让人看到旧画面。
      // 上游失败（403/404/500）时绝不能给 immutable：否则一次瞬时错误
      // 会被浏览器按「一小时不变」缓存，重试也刷不出来。
      'Cache-Control': live || !upstream.ok ? 'no-store' : CACHE_SEGMENT,
    };
    // 上游带了 content-encoding 时，undici 已经把响应体解压好了，但**响应头原样保留**
    // （实测 gzip：头里仍是压缩后的 content-length=52，body 却是 540 字节明文）。
    // 这时如果照抄 content-length，浏览器只读前 52 字节就认定响应结束，剩下的丢掉，
    // 分片被截断 → 解码出花屏/噪点。所以只要上游声明过编码，就不要透传长度，改走 chunked。
    const upstreamEncoding = upstream.headers.get('content-encoding');
    const contentLength = upstreamEncoding ? null : upstream.headers.get('content-length');
    if (contentLength) headers['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;

    res.writeHead(upstream.status, headers);

    if (req.method === 'HEAD' || !reader) {
      res.end();
      return;
    }

    let closed = false;
    res.on('close', () => {
      closed = true;
      void reader.cancel().catch(() => undefined);
    });

    let total = 0;
    let completed = false;
    let truncated = false;
    const byteLimit = streamByteLimit();
    // 边发边攒一份副本进预取缓存：播放器回头 seek/重播同一个分片时直接命中内存。
    // 只在分片不大时攒，避免把大文件整份留在堆里。
    const mirrored: Buffer[] = [];
    let mirrorBytes = 0;
    const mirror = (chunk: Uint8Array): void => {
      if (!cacheable) return;
      mirrorBytes += chunk.byteLength;
      if (mirrorBytes > PREFETCH_MAX_SEGMENT) {
        cacheable = false;
        return;
      }
      mirrored.push(Buffer.from(chunk));
    };
    const write = async (chunk: Uint8Array): Promise<boolean> => {
      total += chunk.byteLength;
      if (total > byteLimit) {
        // 超限不能只是「停止搬运然后 res.end()」：我们已经按上游的
        // Content-Length 写好了响应头，客户端会以为还有数据、一直等到超时，
        // 拿到的却是半截文件，而且没有任何错误线索。
        // 这里标记截断并在 finally 里 destroy 连接，让客户端立刻看到「断了」。
        truncated = true;
        return false;
      }
      mirror(chunk);
      if (res.write(chunk)) return true;
      // 等背压解除，但连接被关掉时 drain 永远不会来：
      // 必须同时监听 close，否则每次拖进度条都会漏一个挂起的 Promise
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.once('drain', done);
        res.once('close', done);
      });
      return !closed;
    };

    try {
      if (first && first.byteLength > 0 && !(await write(first))) {
        // 超限时不能先 res.end() 再 destroy：end 会把一个「正常结束」的空响应
        // 推给客户端，看起来像成功。交给 finally 里的 destroy 表达「断了」。
        if (!truncated) res.end();
        return;
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          // 只有 reader 明确报告「读完了」才算完整：`write()` 返回 false 而跳出
          // 循环的情况（超长截断、下游断开）拿到的都是半截数据，绝不能进缓存。
          completed = true;
          break;
        }
        if (!(await write(value))) break;
      }
    } catch {
      /* 上游中途断流：已发出的部分保留，直接结束响应 */
    } finally {
      // 只有完整收到才写缓存。中途断流/超长截断的分片缓存住的话，播放器下次
      // 命中缓存会拿到半截数据 —— 表现为花屏、噪点、或者干脆卡住不前进。
      //
      // 另外还要比对 content-length：chunked 的上游如果干净地提前 EOF，
      // `done === true` 但字节数不足，同样会缓存残缺分片。
      const declared = Number(contentLength ?? Number.NaN);
      const lengthOk = !Number.isFinite(declared) || total === declared;
      if (completed && lengthOk && cacheable && !closed && mirrorBytes > 0) {
        cache.put(cacheKey, {
          body: Buffer.concat(mirrored),
          contentType,
          status: upstream.status,
          headers: {},
        });
      }
      if (truncated) {
        // 连接直接断掉，别让客户端对着半截数据等超时
        console.warn(`[proxy] 媒体流超过 ${byteLimit} 字节上限，已中断：${redactUrl(cacheKey)}`);
        res.destroy();
      } else {
        res.end();
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('媒体代理启动失败');
  base = `http://127.0.0.1:${address.port}`;

  return {
    base: `${base}/t/${token}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        // keep-alive 连接不会自己断，必须先强制关掉，否则 close 回调永远不来
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
