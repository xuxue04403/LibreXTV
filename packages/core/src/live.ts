/**
 * 直播 / IPTV（客户端版）。
 *
 * 对应上游 src/app/api/live/playlist、/api/live/epg 与 src/lib/xmltv.ts。
 * 全部改为客户端拉取：M3U 解析 → 频道/分组；XMLTV 解析 → 当前/下一档节目。
 * gzip 由 http 层的 maybeGunzip 处理，不依赖 Node zlib。
 */

import { maybeGunzip, type HttpClient } from './http';
import { collectGroups, createM3uParser, parseM3u, parseM3uEpgUrl } from './m3u';
import type { EpgProgram, LiveChannel, LiveEpg, LivePlaylist } from './types';

export interface LiveOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LiveProgress {
  /** 目前已解析出的频道总数 */
  channels: number;
  /** 已下载字节数 */
  bytes: number;
  /** 已耗时（ms） */
  elapsed: number;
}

export interface LiveStreamOptions extends LiveOptions {
  /**
   * 每解析出一批新频道就回调一次（渐进渲染）。
   *
   * 只有宿主提供了 `http.stream` 才会真正渐进；否则会在下载完成后
   * 一次性回调。调用方应当把回调当成「累加」而不是「全量」。
   */
  onChannels?: (added: LiveChannel[], progress: LiveProgress) => void;
  /** 每隔多久推一次进度（默认 400ms），避免大列表把渲染层刷爆 */
  progressIntervalMs?: number;
  /**
   * 流式路径下「多久没收到数据」判定卡死（默认 20 秒）。
   *
   * 不用 timeoutMs 是因为大列表（上万频道）合法地要下一两分钟，
   * 总时长死线会把正常情况误杀。
   */
  idleTimeoutMs?: number;
}

/** UTF-8 流式解码器：网络分块会切开多字节字符，必须用流式模式 */
function createDecoder(): { decode: (chunk: Uint8Array) => string; flush: () => string } {
  const decoder = new TextDecoder('utf-8');
  return {
    decode: (chunk) => decoder.decode(chunk, { stream: true }),
    flush: () => decoder.decode(),
  };
}

/**
 * 拉取并解析 M3U 订阅。
 *
 * 传了 `onChannels` 且宿主支持 `http.stream` 时会走渐进路径：
 * 边下边解析，第一批频道几百毫秒就能显示，而不是等整个列表下完。
 */
export async function fetchLivePlaylist(
  url: string,
  http: HttpClient,
  opts: LiveStreamOptions = {}
): Promise<LivePlaylist & { epgUrl?: string }> {
  const headers = {
    Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, text/plain, */*',
  };
  const started = Date.now();

  if (opts.onChannels && typeof http.stream === 'function') {
    const parser = createM3uParser(url);
    const decoder = createDecoder();
    const all: LiveChannel[] = [];
    let bytes = 0;
    let lastPush = 0;
    const interval = opts.progressIntervalMs ?? 400;
    let head = '';
    /** 被节流挡下的批次：下次回调要一起带上，否则这批频道在渐进列表里永远缺失 */
    let pendingPush: LiveChannel[] = [];

    const emit = (added: LiveChannel[], force: boolean): void => {
      if (added.length > 0) {
        pendingPush.push(...added);
        all.push(...added);
      }
      if (pendingPush.length === 0) return;
      const now = Date.now();
      if (!force && now - lastPush < interval) return;
      lastPush = now;
      const payload = pendingPush;
      pendingPush = [];
      opts.onChannels?.(payload, { channels: all.length, bytes, elapsed: now - started });
    };

    const feed = (chunk: Uint8Array): void => {
      bytes += chunk.byteLength;
      if (chunk.byteLength === 0) return;
      // 注意：同一个 TextDecoder 的 stream 模式是有状态的，一块字节只能 decode 一次，
      // 否则第二个 chunk 会被当成「接续上一块剩余字节」→ 中文全变乱码。
      const text = decoder.decode(chunk);
      // 前 4KB 留下来解析 #EXTM3U 头部的 EPG 地址与订阅名
      if (head.length < 4096) head += text.slice(0, 4096 - head.length);
      emit(parser.push(text), false);
    };

    let res;
    try {
      res = await http.stream(url, {
        headers,
        signal: opts.signal,
        idleTimeoutMs: opts.idleTimeoutMs,
        onChunk: feed,
      });
    } catch (err) {
      // 流式中途失败但已经拿到部分频道时用已解析结果兜底（总比空白页好）
      emit(parser.end(), true);
      if (all.length === 0) throw err;
      // 兜底返回也要带 epgUrl：head 里通常已经有 x-tvg-url 了，
      // 漏掉它会让「节目单」在直播中断后突然整片变空。成功路径（:131-136）
      // 与非流式路径都带了这个字段。
      return {
        channels: all,
        groups: collectGroups(all),
        name: readPlaylistName(head),
        epgUrl: parseM3uEpgUrl(head, url),
      };
    }
    emit(parser.push(decoder.flush()), false);
    emit(parser.end(), true);

    // 上游返回 404/503 时通常是一段 HTML 错误页，逐行喂给解析器只会得到 0 个频道，
    // 报「格式不支持」会把人引到错误方向：真正该说的是状态码。
    if (!res.ok && all.length === 0) {
      throw new Error(`直播源返回 HTTP ${res.status}`);
    }
    if (all.length === 0) throw new Error('未解析到可用频道（可能是 txt 格式或不支持的列表）');
    const text = res.text || head;
    return {
      name: readPlaylistName(text || head),
      channels: all,
      groups: collectGroups(all),
      epgUrl: parseM3uEpgUrl(text || head, url),
    };
  }

  const res = await http.request(url, {
    headers,
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`直播源拉取失败（HTTP ${res.status}）`);
  const channels = parseM3u(res.text, url);
  if (channels.length === 0) throw new Error('未解析到可用频道（可能是 txt 格式或不支持的列表）');
  opts.onChannels?.(channels, {
    channels: channels.length,
    bytes: res.bytes.byteLength,
    elapsed: Date.now() - started,
  });
  return {
    name: readPlaylistName(res.text),
    channels,
    groups: collectGroups(channels),
    epgUrl: parseM3uEpgUrl(res.text, url),
  };
}/** #EXTM3U 之后的 `#PLAYLIST:名称` 或首行注释里取订阅名 */
function readPlaylistName(content: string): string | undefined {
  const m = /^#PLAYLIST:(.+)$/m.exec(content);
  return m ? m[1].trim() : undefined;
}

/**
 * 直播订阅里的成人类目/频道关键词。
 *
 * IPTV 列表里成人频道通常以分组名或台名出现（如「成人」「18+」「午夜」
 * 「Hot」「XXX」），此前直播链路**完全没有过滤**，与点播的开关不一致。
 * 这里刻意不用过宽的词（如单独的「情」）以免误伤正常频道。
 */
export const ADULT_LIVE_KEYWORDS = [
  '成人', '18+', '18禁', '限制级', '色情', '情色', '伦理', '午夜', '深夜福利',
  '裸', '无码', '有码', '自慰', '约炮', 'sex', 'xxx', 'porn', 'adult', 'erotic',
  'hot adult', 'playboy', 'brazzers',
];

/**
 * 英文短词必须按词边界匹配：`haystack.includes('sex')` 会命中 `Essex TV`、
 * `Middlesex`，把正经的地方台/英国台误杀。中文词没有词边界概念，继续用 includes。
 */
const ADULT_LIVE_EN = /(^|[^a-z])(sex|xxx|porn|adult|erotic|playboy|brazzers|hot adult)([^a-z]|$)/;

/**
 * 从关键词表里挑出「中文/数字」那一类，供 includes 匹配。
 *
 * 判断方式是比较首字符的码位：ASCII 之外的即是中文（或全角符号），
 * 数字开头（`18+`、`18禁`）也算这一类 —— 它们不会像 `sex` 那样作为
 * 英文单词的一部分出现在正经台名里。之前用 `/[^\x00-\x7F]|^\d/` 正则做这件事，
 * 会被 lint 的 no-control-regex 拦下，改成码位比较既等价又不用转义控制字符。
 */
const ADULT_LIVE_ZH = ADULT_LIVE_KEYWORDS.filter((k) => {
  const first = k.charCodeAt(0);
  return first > 0x7f || (first >= 0x30 && first <= 0x39);
});

/** 频道是否属于成人内容（先看分组名，再看台名；都转小写比较） */
export function isAdultChannel(channel: { name?: string; group?: string; rawName?: string }): boolean {
  const haystack = `${channel.group || ''} ${channel.name || ''} ${channel.rawName || ''}`.toLowerCase();
  if (!haystack.trim()) return false;
  // 中文/数字类关键词（成人、18+、午夜…）没有误伤风险，走 includes
  if (ADULT_LIVE_ZH.some((k) => haystack.includes(k.toLowerCase()))) return true;
  return ADULT_LIVE_EN.test(haystack);
}

/** 过滤成人频道（与点播的 adultFilter 共用同一个开关语义） */
export function filterAdultChannels<T extends { name?: string; group?: string; rawName?: string }>(
  channels: T[],
  enabled: boolean
): T[] {
  if (!enabled) return channels;
  return channels.filter((ch) => !isAdultChannel(ch));
}

/** 频道列表过滤：按分组 + 关键词（名称/原始台名）；保留调用方的扩展字段 */
export function filterChannels<T extends LiveChannel>(
  channels: T[],
  opts: { group?: string; keyword?: string }
): T[] {
  const kw = (opts.keyword || '').trim().toLowerCase();
  return channels.filter((ch) => {
    if (opts.group && (ch.group || '未分组') !== opts.group) return false;
    if (!kw) return true;
    return (
      ch.name.toLowerCase().includes(kw) ||
      (ch.rawName || '').toLowerCase().includes(kw) ||
      (ch.group || '').toLowerCase().includes(kw)
    );
  });
}

/**
 * 跨源合并后的频道去重：同名的台只保留最靠前的一条。
 *
 * 单份 m3u 内部的重复地址由解析器负责；这里解决的是「多个直播源都提供 CCTV5」
 * 的场景——不去重的话列表里会出现几张一模一样的台标卡片，用户点哪张都各有一半
 * 概率是死台。传入顺序即优先级（默认源清单的顺序），所以调用方应当把可播率更高、
 * 画质更好的源排在前面。
 *
 * 名字为空时退回按 URL 去重；名字只做「去空白与分隔符 + 小写」，不做模糊匹配，
 * 因为 `CCTV5` 与 `CCTV5+` 是两个不同的台。
 */
export function dedupeChannels<T extends { name?: string; url: string }>(channels: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const channel of channels) {
    const name = (channel.name || '').replace(/[\s\-_·]+/g, '').toLowerCase();
    const key = name || channel.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(channel);
  }
  return out;
}

// —— XMLTV ——

const PROGRAMME_RE = /<programme\s+([^>]*?)\/>|<programme\s+([^>]*?)>([\s\S]*?)<\/programme>/g;
const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i;
const DESC_RE = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/i;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decodeXmlText(raw: string): string {
  let text = raw.trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 解析 `YYYYMMDDHHmmss(.fff)?( +hhmm | Z)?` 为 epoch ms；无法解析返回 NaN */
export function parseXmltvTime(raw: string): number {
  const m = raw
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,3}))?(?:\s*([+-])(\d{2})(\d{2})|Z)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac, sign, tzh, tzm] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0), frac ? +frac.padEnd(3, '0') : 0);
  if (!sign) return utcMs;
  const offsetMin = +tzh * 60 + +tzm;
  const offsetMs = offsetMin * 60 * 1000 * (sign === '-' ? -1 : 1);
  return utcMs - offsetMs;
}

function extractAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

/** 解析 XMLTV：只保留 [now, now+windowMs] 窗口内的节目，按频道分组并按开播时间排序 */
export function parseXmltv(text: string, windowMs = DEFAULT_WINDOW_MS, now = Date.now()): Map<string, EpgProgram[]> {
  const result = new Map<string, EpgProgram[]>();
  const windowEnd = now + windowMs;
  PROGRAMME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROGRAMME_RE.exec(text))) {
    const attrText = m[1] ?? m[2] ?? '';
    const inner = m[3] ?? '';
    const attrs = extractAttrs(attrText);
    const channelId = attrs['channel']?.trim();
    if (!channelId) continue;
    const start = parseXmltvTime(attrs['start'] || '');
    const stop = parseXmltvTime(attrs['stop'] || '');
    if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
    if (stop <= now || start >= windowEnd) continue;
    const titleMatch = inner.match(TITLE_RE);
    const descMatch = inner.match(DESC_RE);
    const title = titleMatch ? decodeXmlText(titleMatch[1]) : '';
    if (!title) continue;
    const program: EpgProgram = { channelId, start, stop, title };
    if (descMatch) program.desc = decodeXmlText(descMatch[1]);
    const list = result.get(channelId);
    if (list) list.push(program);
    else result.set(channelId, [program]);
  }
  for (const list of result.values()) list.sort((a, b) => a.start - b.start);
  return result;
}

/** 取某频道当前正在播出的节目与下一个节目 */
export function currentAndNext(
  programs: EpgProgram[],
  at = Date.now()
): { current?: EpgProgram; next?: EpgProgram } {
  let current: EpgProgram | undefined;
  let next: EpgProgram | undefined;
  for (const p of programs) {
    if (p.start <= at && p.stop > at) {
      current = p;
      continue;
    }
    if (p.start > at) {
      next = p;
      break;
    }
  }
  return { current, next };
}

/** 拉取并解析 XMLTV 节目单（自动解 gzip） */
export async function fetchEpg(
  epgUrl: string,
  channelId: string,
  http: HttpClient,
  opts: LiveOptions = {}
): Promise<LiveEpg> {
  const res = await http.request(epgUrl, {
    headers: { Accept: 'application/xml, text/xml, application/gzip, */*' },
    timeoutMs: opts.timeoutMs ?? 20_000,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`节目单拉取失败（HTTP ${res.status}）`);
  const bytes = await maybeGunzip(res.bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  const byChannel = parseXmltv(text);
  const programs = byChannel.get(channelId) ?? [];
  const { current, next } = currentAndNext(programs);
  return { channelId, current, next, programs };
}
