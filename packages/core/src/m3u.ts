/**
 * M3U / M3U8 直播播放列表解析。
 *
 * 移植自 LibreTV（AGPL-3.0-or-later）src/lib/m3u-parser.ts：
 * https://github.com/LibreSpark/LibreTV
 * 改动：无（纯函数）。
 */

import type { LiveChannel } from './types';

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const ATTR_STRIP_RE = /[a-zA-Z0-9_-]+="[^"]*"/g;

function stableId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 相对地址按订阅 URL 解析为绝对地址；仅放行 http(s) */
export function normalizeStreamUrl(raw: string, baseUrl?: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // 上游返回 HTML 错误页时（404/503 常见），`<!doctype html><html>404 not found…`
  // 这类整行会被 URL 解析器当成相对路径「成功」解析，最后变成一条名字叫「html>」
  // 的幽灵频道——界面上表现为「列表有内容但全部播不了」。
  // 判据：带尖括号/引号的一定是标记语言；含空白又不以 http(s) 开头的一定不是地址
  // （真正的空格在 URL 里应写成 %20；绝对地址里的裸空格浏览器能容忍，保留兼容）。
  if (/[<>"]/.test(trimmed)) return undefined;
  if (/\s/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return resolved.href;
  } catch {
    return undefined;
  }
}

/** URL 无名时的兜底名称：取路径末段，decode 后仍空则用主机名 */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) {
      // decodeURIComponent 遇到畸形百分号编码（`/100%.m3u8`、`/a%ZZ`）会抛
      // URIError，被外层 catch 兜成「未命名频道」。这里单独兜住，退回原始末段，
      // 至少还能看出是哪个频道。
      let decoded = last;
      try {
        decoded = decodeURIComponent(last);
      } catch {
        /* 保持原始末段 */
      }
      decoded = decoded.replace(/\.(m3u8?|flv|ts|mp4)$/i, '');
      if (decoded) return decoded;
    }
    return u.hostname;
  } catch {
    return '未命名频道';
  }
}

interface ExtinfContext {
  attrs: Record<string, string>;
  title: string;
  extGroup: string;
}

/**
 * 可增量喂入的 M3U 解析器。
 *
 * 为什么需要增量：iptv-org 的 index.m3u 有 2.5MB / 近万频道，实测服务器限速
 * 下要下 70 秒以上，而解析本身只要十几毫秒。整串解析意味着用户要盯着空列表
 * 等一分多钟；改成边收边解析，第一个频道约 1 秒就能上屏。
 */
export interface M3uParser {
  /** 喂入一段文本，返回**这一段**新解析出的频道（可能为空） */
  push(chunk: string): LiveChannel[];
  /** 收尾：把最后一行没换行的残余数据解析完 */
  end(): LiveChannel[];
}

export function createM3uParser(baseUrl?: string): M3uParser {
  const seen = new Set<string>();
  let ctx: ExtinfContext | null = null;
  // 跨 chunk 的半行缓存：网络分块几乎不会落在换行处
  let carry = '';
  let pending: LiveChannel[] = [];

  function handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    if (line.toUpperCase().startsWith('#EXTINF')) {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(line))) attrs[m[1].toLowerCase()] = m[2].trim();

      const stripped = line.replace(ATTR_STRIP_RE, '').replace(/^#EXTINF\s*:\s*/i, '');
      const commaIdx = stripped.indexOf(',');
      const title = (commaIdx >= 0 ? stripped.slice(commaIdx + 1) : stripped)
        .trim()
        .replace(/^"+|"+$/g, '');

      ctx = { attrs, title, extGroup: '' };
      return;
    }

    if (line.toUpperCase().startsWith('#EXTGRP:')) {
      const g = line.slice('#EXTGRP:'.length).trim();
      if (ctx && g && !ctx.attrs['group-title']) ctx.extGroup = g;
      return;
    }

    if (line.startsWith('#')) return;

    const url = normalizeStreamUrl(line, baseUrl);
    const cur = ctx;
    ctx = null;
    if (!url || seen.has(url)) return;
    seen.add(url);

    const attrs = cur?.attrs ?? {};
    const tvgId = attrs['tvg-id'] || undefined;
    const logo = attrs['tvg-logo'] ? normalizeStreamUrl(attrs['tvg-logo'], baseUrl) : undefined;
    const name = cur?.title || nameFromUrl(url);
    pending.push({
      id: tvgId || stableId(url),
      name,
      url,
      logo,
      group: attrs['group-title'] || cur?.extGroup || undefined,
      tvgId,
      rawName: attrs['tvg-name'] || undefined,
    });
  }

  function take(): LiveChannel[] {
    if (pending.length === 0) return [];
    const out = pending;
    pending = [];
    return out;
  }

  return {
    push(chunk: string): LiveChannel[] {
      if (!chunk) return take();
      const text = carry ? carry + chunk : chunk;
      carry = '';
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl === -1) break;
        // 行尾的 \r 交给 trim 处理
        handleLine(text.slice(start, nl));
        start = nl + 1;
      }
      if (start < text.length) carry = text.slice(start);
      return take();
    },
    end(): LiveChannel[] {
      if (carry) {
        handleLine(carry);
        carry = '';
      }
      return take();
    },
  };
}

export function parseM3u(content: string, baseUrl?: string): LiveChannel[] {
  if (!content) return [];
  const parser = createM3uParser(baseUrl);
  const channels = parser.push(content);
  return channels.concat(parser.end());
}

/** 从频道列表提取分组（去重，保持出现顺序，未分组归入「未分组」） */
export function collectGroups(channels: LiveChannel[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of channels) {
    const g = ch.group || '未分组';
    // 「全部」是界面上的哨兵值（表示不筛选），不是真实分组。调用方一律写成
    // `['全部', ...collectGroups(channels)]`，清单里只要有频道把 group-title
    // 写成「全部」，渲染出来就是两个同名分组：React 会报重复 key，点哪一个
    // 都等于不筛选。
    if (g === '全部') continue;
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** 解析 M3U 头部 #EXTM3U 的 x-tvg-url / url-tvg 属性（EPG 地址兜底） */
export function parseM3uEpgUrl(content: string, baseUrl?: string): string | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0] || '';
  if (!/^#EXTM3U/i.test(firstLine.trim())) return undefined;
  const m = /(?:x-tvg-url|url-tvg)="([^"]+)"/i.exec(firstLine);
  if (!m) return undefined;
  return normalizeStreamUrl(m[1].split(',')[0], baseUrl);
}
