/**
 * M3U / M3U8 直播播放列表解析。
 *
 * 移植自 packages/core/src/m3u.ts，行为一致：
 * - 相对地址按订阅 URL 解析成绝对地址，只放行 http(s)；
 * - 上游返回 HTML 错误页时不能把 `<html>` 当成「名字叫 html> 的幽灵频道」，
 *   所以带尖括号/引号的行直接丢弃；
 * - 同名台跨源去重时，只留清单里排在前面的那条（清单顺序即优先级）。
 */
import { url as ArkUrl } from '@kit.ArkTS';
import { LiveChannel } from '../model/Types';

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const ATTR_STRIP_RE = /[a-zA-Z0-9_-]+="[^"]*"/g;

/** djb2 散列，给没有 tvg-id 的频道生成稳定 id */
function stableId(input: string): string {
  let h: number = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** 相对地址解析为绝对地址；仅放行 http(s) */
export function normalizeStreamUrl(raw: string, baseUrl?: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/[<>"]/.test(trimmed)) {
    return undefined;
  }
  if (/\s/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  try {
    const resolved = baseUrl !== undefined ? new ArkUrl.URL(trimmed, baseUrl) : new ArkUrl.URL(trimmed);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    return resolved.href;
  } catch (err) {
    return undefined;
  }
}

/** URL 无名时的兜底名称：取路径末段，decode 后仍空则用主机名 */
function nameFromUrl(url: string): string {
  try {
    const u = new ArkUrl.URL(url);
    const segs = u.pathname.split('/');
    let last = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].length > 0) {
        last = segs[i];
        break;
      }
    }
    if (last.length > 0) {
      const decoded = decodeURIComponent(last).replace(/\.(m3u8?|flv|ts|mp4)$/i, '');
      if (decoded.length > 0) {
        return decoded;
      }
    }
    return u.hostname;
  } catch (err) {
    return '未命名频道';
  }
}

interface ExtinfContext {
  attrs: Record<string, string>;
  title: string;
  extGroup: string;
}

/** 解析整份 m3u 文本 */
export function parseM3u(text: string, baseUrl: string, sourceKey: string, sourceName: string): LiveChannel[] {
  const out: LiveChannel[] = [];
  const seen = new Set<string>();
  let ctx: ExtinfContext | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (line.toUpperCase().startsWith('#EXTINF')) {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      let m = ATTR_RE.exec(line);
      while (m !== null) {
        attrs[m[1].toLowerCase()] = m[2].trim();
        m = ATTR_RE.exec(line);
      }
      const stripped = line.replace(ATTR_STRIP_RE, '').replace(/^#EXTINF\s*:\s*/i, '');
      const commaIdx = stripped.indexOf(',');
      const rawTitle = commaIdx >= 0 ? stripped.slice(commaIdx + 1) : stripped;
      const title = rawTitle.trim().replace(/^"+|"+$/g, '');
      ctx = { attrs: attrs, title: title, extGroup: '' };
      continue;
    }
    if (line.toUpperCase().startsWith('#EXTGRP:')) {
      const g = line.slice('#EXTGRP:'.length).trim();
      if (ctx !== null && g.length > 0 && attrsGet(ctx.attrs, 'group-title') === undefined) {
        ctx.extGroup = g;
      }
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    const url = normalizeStreamUrl(line, baseUrl);
    const cur = ctx;
    ctx = null;
    if (url === undefined || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const attrs: Record<string, string> = cur !== null ? cur.attrs : {};
    const tvgId = attrsGet(attrs, 'tvg-id');
    const logoRaw = attrsGet(attrs, 'tvg-logo');
    const logo = logoRaw !== undefined ? normalizeStreamUrl(logoRaw, baseUrl) : undefined;
    const name = cur !== null && cur.title.length > 0 ? cur.title : nameFromUrl(url);
    out.push({
      id: tvgId !== undefined ? tvgId : stableId(url),
      name: name,
      url: url,
      logo: logo,
      group: attrsGet(attrs, 'group-title') ?? (cur !== null ? cur.extGroup : undefined),
      sourceKey: sourceKey,
      sourceName: sourceName,
    });
  }
  return out;
}

function attrsGet(attrs: Record<string, string>, key: string): string | undefined {
  const v = attrs[key];
  if (v === undefined) {
    return undefined;
  }
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

/**
 * 跨源按台名去重：同名台只留排在前面的那条。
 * 名字里空格、连字符、间隔号不算差异（CCTV-5 与 CCTV5 视为同一个）。
 */
export function dedupeChannels(channels: LiveChannel[]): LiveChannel[] {
  const out: LiveChannel[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const key = c.name.replace(/[\s\-_·]+/g, '').toLowerCase();
    const k = key.length > 0 ? key : c.url;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** 从 m3u 里取分组名（保持出现顺序），用于界面上的分组筛选 */
export function collectGroups(channels: LiveChannel[]): string[] {
  const out: string[] = ['全部'];
  const seen = new Set<string>();
  seen.add('全部');
  for (let i = 0; i < channels.length; i++) {
    const g = channels[i].group ?? '未分组';
    // 「全部」是哨兵值（不筛选），不是真实分组。上面已经把「全部」预置进 seen，
    // 这里再显式跳过一次：纯粹是防御——万一以后有人删掉那行 seen.add('全部')，
    // 比赛谁先想到「重复 key 从哪来」要花很久，驻留一个显式判断更省事。
    if (g === '全部') {
      continue;
    }
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}
