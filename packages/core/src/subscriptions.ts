/**
 * 数据源订阅解析（客户端版）。
 *
 * 对应上游 src/lib/source-list.ts + tvbox-parser.ts：
 * 同一入口兼容 LibreTV-SourceList JSON 与 TVBOX 配置 JSON，
 * 输出归一化的点播源（Apple CMS）与直播源（M3U）。
 *
 * 客户端直连意味着不做服务端 SSRF 校验（没有需要保护的内部网络），
 * 但仍只接受 http(s) 绝对地址。
 */

import { hostnameOf, isValidSourceUrl, stableKey, trimSlash } from './format';
import type { LiveSourceConfig, SourceConfig } from './types';

export const MAX_VOD_SOURCES = 100;
export const MAX_LIVE_SOURCES = 50;

/** 连续失败多少次自动暂停订阅刷新 */
export const SUBSCRIPTION_FAIL_THRESHOLD = 3;
/** 刷新周期可选项（天）；0 表示只在手动导入时刷新 */
export const SUBSCRIPTION_REFRESH_OPTIONS = [0, 1, 3, 7, 14, 30] as const;
export const SUBSCRIPTION_MAX_REFRESH_DAYS = 365;

export interface SubscriptionEntry {
  /** stableKey(url)，同一地址只保留一条 */
  key: string;
  url: string;
  name: string;
  /** 刷新周期（天）；0 = 关闭自动刷新 */
  refreshDays: number;
  /** 上次成功同步时间（epoch ms）；0 = 从未成功 */
  lastSyncedAt: number;
  /** 连续失败次数 */
  failStreak: number;
  /** 连续失败达到阈值后暂停自动刷新，手动同步成功或改周期恢复 */
  paused: boolean;
  addedAt: number;
}

export function subscriptionRefreshLabel(days: number): string {
  if (days <= 0) return '关闭';
  return `每 ${days} 天`;
}

/** 是否到期需要后台刷新（关闭/暂停/未到期都不算） */
export function isSubscriptionDue(entry: SubscriptionEntry, now: number): boolean {
  if (entry.paused) return false;
  if (!Number.isFinite(entry.refreshDays) || entry.refreshDays <= 0) return false;
  if (entry.lastSyncedAt <= 0) return true;
  return now - entry.lastSyncedAt >= entry.refreshDays * 24 * 60 * 60 * 1000;
}

/** 清洗订阅条目：坏数据丢弃、周期夹到合法范围 */
export function normalizeSubscriptions(raw: unknown): SubscriptionEntry[] {
  if (!Array.isArray(raw)) return [];
  const result: SubscriptionEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Partial<SubscriptionEntry>;
    if (typeof obj.url !== 'string' || !isValidSourceUrl(trimSlash(obj.url))) continue;
    const url = trimSlash(obj.url);
    const key = typeof obj.key === 'string' && obj.key ? obj.key : `sub_${stableKey(url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const days = typeof obj.refreshDays === 'number' && Number.isFinite(obj.refreshDays)
      ? Math.max(0, Math.min(SUBSCRIPTION_MAX_REFRESH_DAYS, Math.round(obj.refreshDays)))
      : 0;
    result.push({
      key,
      url,
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : hostnameOf(url),
      refreshDays: days,
      lastSyncedAt: typeof obj.lastSyncedAt === 'number' && Number.isFinite(obj.lastSyncedAt) ? obj.lastSyncedAt : 0,
      failStreak: typeof obj.failStreak === 'number' && Number.isFinite(obj.failStreak) ? Math.max(0, obj.failStreak) : 0,
      paused: obj.paused === true,
      addedAt: typeof obj.addedAt === 'number' && Number.isFinite(obj.addedAt) ? obj.addedAt : 0,
    });
  }
  return result;
}


export type SubscriptionSkipReason = 'spider' | 'xml' | 'unsearchable' | 'nonM3uLive' | 'invalidUrl';

export interface SubscriptionParseStats {
  format: 'libretv' | 'tvbox' | 'array';
  skipped: number;
  skippedByReason: Partial<Record<SubscriptionSkipReason, number>>;
  truncated: number;
  skippedSamples?: string[];
}

export interface ParsedSubscription {
  name?: string;
  sources: SourceConfig[];
  liveSources: LiveSourceConfig[];
  stats: SubscriptionParseStats;
}

const SPIDER_PATTERN = /^csp_|\.(?:jar|js|py)(?:[?#].*)?$/i;
const LOCAL_ASSET_PATTERN = /^\.{0,2}\//;
const CMS_API_PATTERN = /\/api\.php\/provide\/vod(?![^?#]*\/at\/xml)(?:[/?#]|$)/i;
const M3U_PATTERN = /\.m3u8?(?:[?#].*)?$/i;
const TXT_PATTERN = /\.txt(?:[?#].*)?$/i;

/** 宽容 JSON：剥离注释与尾随逗号（共享配置常见，标准 JSON.parse 会失败） */
export function parseRelaxedJson<T = unknown>(text: string): T {
  const cleaned = stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, '')));
  return JSON.parse(cleaned) as T;
}

function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n' || ch === '\r') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

interface RawSource {
  name?: unknown;
  url?: unknown;
  detail?: unknown;
  isAdult?: unknown;
  type?: unknown;
  searchable?: unknown;
  api?: unknown;
  key?: unknown;
}

interface RawLive {
  name?: unknown;
  url?: unknown;
  epg?: unknown;
  type?: unknown;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function pushSkip(stats: SubscriptionParseStats, reason: SubscriptionSkipReason, name?: string) {
  stats.skipped += 1;
  stats.skippedByReason[reason] = (stats.skippedByReason[reason] ?? 0) + 1;
  if (name && (stats.skippedSamples?.length ?? 0) < 3) {
    stats.skippedSamples = [...(stats.skippedSamples ?? []), name];
  }
}

function normalizeVodSource(raw: RawSource, prefix: string, index: number): SourceConfig | null {
  const url = trimSlash(strOrUndef(raw.url) ?? '');
  if (!url || !isValidSourceUrl(url)) return null;
  const detail = strOrUndef(raw.detail);
  return {
    key: `${prefix}_${index}`,
    name: strOrUndef(raw.name) ?? hostnameOf(url),
    url,
    detail: detail && isValidSourceUrl(detail) ? trimSlash(detail) : undefined,
    isAdult: raw.isAdult === true,
  };
}

function normalizeLiveSource(raw: RawLive, prefix: string, index: number): LiveSourceConfig | null {
  const url = trimSlash(strOrUndef(raw.url) ?? '');
  if (!url || !isValidSourceUrl(url)) return null;
  const epg = strOrUndef(raw.epg);
  return {
    key: `${prefix}_live_${index}`,
    name: strOrUndef(raw.name) ?? hostnameOf(url),
    url,
    epg: epg && isValidSourceUrl(epg) ? epg : undefined,
  };
}

/** 解析订阅文本（已是 JSON 字符串） */
export function parseSubscription(text: string, subscriptionUrl?: string): ParsedSubscription {
  let data: unknown;
  try {
    data = parseRelaxedJson(text);
  } catch {
    throw new Error('订阅内容不是合法的 JSON');
  }
  return normalizeSubscription(data, subscriptionUrl);
}

/** 解析已 JSON.parse 的订阅结构 */
export function normalizeSubscription(data: unknown, subscriptionUrl?: string): ParsedSubscription {
  const name = subscriptionUrl ? hostnameOf(subscriptionUrl) : undefined;
  // 源 key 前缀必须带上订阅地址：两份裸数组订阅各自都是 `sub_0`、`sub_1`…，
  // 撞 key 后只能一起勾选/取消，健康度与历史会互相串到另一个订阅的源上。
  const keyPrefix = subscriptionUrl ? `sub_${stableKey(subscriptionUrl)}` : undefined;

  // 裸数组：视为点播源列表
  if (Array.isArray(data)) {
    const stats: SubscriptionParseStats = { format: 'array', skipped: 0, skippedByReason: {}, truncated: 0 };
    const sources: SourceConfig[] = [];
    const seen = new Set<string>();
    for (const item of data as RawSource[]) {
      if (!item || typeof item !== 'object') {
        pushSkip(stats, 'invalidUrl');
        continue;
      }
      const url = trimSlash(strOrUndef(item.url) ?? '');
      if (!url || !isValidSourceUrl(url)) {
        pushSkip(stats, 'invalidUrl', strOrUndef(item.name));
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      if (sources.length >= MAX_VOD_SOURCES) {
        stats.truncated += 1;
        continue;
      }
      const normalized = normalizeVodSource(item, keyPrefix ?? 'sub', sources.length);
      if (normalized) sources.push(normalized);
    }
    return { name, sources, liveSources: [], stats };
  }

  if (!data || typeof data !== 'object') throw new Error('订阅内容格式不正确');
  const obj = data as Record<string, unknown>;
  const isTvbox = Array.isArray(obj.sites) || Array.isArray(obj.lives);
  const stats: SubscriptionParseStats = {
    format: isTvbox ? 'tvbox' : 'libretv',
    skipped: 0,
    skippedByReason: {},
    truncated: 0,
  };
  const listName = strOrUndef(obj.name) ?? name;
  const prefix =
    keyPrefix ?? `sub_${stableKey(JSON.stringify(obj).slice(0, 64))}`;

  const sources: SourceConfig[] = [];
  const liveSources: LiveSourceConfig[] = [];
  const seenVod = new Set<string>();
  const seenLive = new Set<string>();

  if (isTvbox) {
    const sites = (obj.sites ?? []) as RawSource[];
    for (const site of sites) {
      if (!site || typeof site !== 'object') continue;
      const api = strOrUndef(site.api) ?? strOrUndef(site.url) ?? '';
      const siteName = strOrUndef(site.name) ?? strOrUndef(site.key);
      // Spider 判定必须先于协议校验：csp_xxx / ./json 这类本就不是 http(s) 地址
      if (api && (SPIDER_PATTERN.test(api) || LOCAL_ASSET_PATTERN.test(api))) {
        pushSkip(stats, 'spider', siteName);
        continue;
      }
      if (!api || !/^https?:\/\//i.test(api)) {
        pushSkip(stats, 'invalidUrl', siteName);
        continue;
      }
      if (site.searchable === 0 || site.searchable === '0') {
        pushSkip(stats, 'unsearchable', siteName);
        continue;
      }
      const type = Number(site.type ?? -1);
      const isJsonApi = type === 1 || (type !== 3 && CMS_API_PATTERN.test(api));
      if (!isJsonApi) {
        pushSkip(stats, 'xml', siteName);
        continue;
      }
      const url = trimSlash(api);
      if (seenVod.has(url)) continue;
      seenVod.add(url);
      if (sources.length >= MAX_VOD_SOURCES) {
        stats.truncated += 1;
        continue;
      }
      sources.push({
        key: `${prefix}_${sources.length}`,
        name: siteName ?? hostnameOf(url),
        url,
      });
    }

    const lives = (obj.lives ?? []) as RawLive[];
    for (const live of lives) {
      if (!live || typeof live !== 'object') continue;
      const url = trimSlash(strOrUndef(live.url) ?? '');
      const liveName = strOrUndef(live.name);
      if (!url || !isValidSourceUrl(url)) {
        pushSkip(stats, 'invalidUrl', liveName);
        continue;
      }
      if (!M3U_PATTERN.test(url) || TXT_PATTERN.test(url)) {
        pushSkip(stats, 'nonM3uLive', liveName);
        continue;
      }
      if (seenLive.has(url)) continue;
      seenLive.add(url);
      if (liveSources.length >= MAX_LIVE_SOURCES) {
        stats.truncated += 1;
        continue;
      }
      const epg = strOrUndef(live.epg);
      liveSources.push({
        key: `${prefix}_live_${liveSources.length}`,
        name: liveName ?? hostnameOf(url),
        url,
        epg: epg && isValidSourceUrl(epg) ? epg : undefined,
      });
    }
  } else {
    const rawSources = (obj.sources ?? []) as RawSource[];
    if (!Array.isArray(rawSources) && !Array.isArray(obj.liveSources)) {
      throw new Error('订阅内容格式不正确');
    }
    for (const raw of Array.isArray(rawSources) ? rawSources : []) {
      if (!raw || typeof raw !== 'object') {
        pushSkip(stats, 'invalidUrl');
        continue;
      }
      const url = trimSlash(strOrUndef(raw.url) ?? '');
      if (!url || !isValidSourceUrl(url)) {
        pushSkip(stats, 'invalidUrl', strOrUndef(raw.name));
        continue;
      }
      if (seenVod.has(url)) continue;
      seenVod.add(url);
      if (sources.length >= MAX_VOD_SOURCES) {
        stats.truncated += 1;
        continue;
      }
      const normalized = normalizeVodSource(raw, prefix, sources.length);
      if (normalized) sources.push(normalized);
    }

    const rawLives = (obj.liveSources ?? []) as RawLive[];
    for (const raw of Array.isArray(rawLives) ? rawLives : []) {
      if (!raw || typeof raw !== 'object') {
        pushSkip(stats, 'invalidUrl');
        continue;
      }
      const url = trimSlash(strOrUndef(raw.url) ?? '');
      if (!url || !isValidSourceUrl(url)) {
        pushSkip(stats, 'invalidUrl', strOrUndef(raw.name));
        continue;
      }
      if (seenLive.has(url)) continue;
      seenLive.add(url);
      if (liveSources.length >= MAX_LIVE_SOURCES) {
        stats.truncated += 1;
        continue;
      }
      const normalized = normalizeLiveSource(raw, prefix, liveSources.length);
      if (normalized) liveSources.push(normalized);
    }
  }

  if (sources.length === 0 && liveSources.length === 0) {
    throw new Error('订阅内容格式不正确');
  }
  return { name: listName, sources, liveSources, stats };
}

/** 导出为 LibreTV-SourceList JSON（v2），用于分享给桌面端/电视端或再次导入 */
export function exportSourceList(
  sources: SourceConfig[],
  liveSources: LiveSourceConfig[],
  name = '我的源列表'
): string {
  return JSON.stringify(
    {
      name,
      version: 2,
      sources: sources.map((s) => ({
        name: s.name,
        url: s.url,
        ...(s.detail ? { detail: s.detail } : {}),
        ...(s.isAdult ? { isAdult: true } : {}),
      })),
      liveSources: liveSources.map((s) => ({
        name: s.name,
        url: s.url,
        ...(s.epg ? { epg: s.epg } : {}),
      })),
    },
    null,
    2
  );
}
