/**
 * 桌面主进程画质探测。
 *
 * 移植自 LibreTV 上游 src/lib/quality-probe.ts（AGPL-3.0，作者 LibreSpark），
 * 差异：抓取放在主进程（无 CORS、可用 node:crypto），并复用 core 的详情解析。
 *
 * 两级策略：
 * 1. 多码率源：master playlist 的 #EXT-X-STREAM-INF 直接给分辨率；
 * 2. 单码率源：下沉到 init/首个分片，从 MP4 VisualSampleEntry 或 H.264 SPS 里挖。
 * HEVC 或强鉴权源测不出，返回「未知」而不是错误。
 */

import {
  createFetchHttp,
  failureReasonLabel,
  fetchDetail,
  inferHeightFromBitrate,
  isQualityEntryFresh,
  isRetryableTimeout,
  mergeQualityEntries,
  qualityKey,
  qualityLabel,
  type QualityEntry,
  type SourceConfig,
} from '@librextv/core';
import { assertAllowedTarget, fetchChecked } from './proxy';
import {
  decryptAes128CbcPrefix,
  looksLikeMp4,
  parseMp4VideoResolution,
  parseTsVideoResolution,
} from './codec-parse';

/** m3u8 只读够解析的头部（master 通常 <1KB，媒体列表可能几百 KB） */
const M3U8_MAX_BYTES = 64 * 1024;
/** SPS/moov 必在开头，96KB 足够，不必为几十 MB 的分片买单 */
const SEGMENT_PREFIX_BYTES = 96 * 1024;
/** fMP4 的 init segment 很小 */
const INIT_PREFIX_BYTES = 64 * 1024;
/** 单条探测总死线 */
export const QUALITY_PROBE_TIMEOUT_MS = 12_000;
/** 分片解析独立预算：走到这里说明源是通的，超时只算「没探出」 */
const SEGMENT_BUDGET_MS = 4_000;

export interface QualityProbeRequest {
  source: SourceConfig;
  vodId: string;
}

export interface QualityProbeResponse {
  ok: boolean;
  height?: number;
  label?: string;
  error?: string;
  reason?: string;
  retryable: boolean;
  cached: boolean;
}

/** 探测结果缓存（主进程内存；重启失效可接受） */
const cache = new Map<string, QualityEntry>();

export function clearQualityCache(): void {
  cache.clear();
}

function cacheRecord(): Record<string, QualityEntry> {
  return Object.fromEntries(cache);
}

function remember(entry: QualityEntry): void {
  const merged = mergeQualityEntries(cacheRecord(), { [qualityKey(entry.sourceKey, entry.vodId)]: entry });
  cache.clear();
  for (const [key, value] of Object.entries(merged)) cache.set(key, value);
}

function prefixHeaders(source: SourceConfig): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: `${originOf(source.url)}/`,
    Accept: '*/*',
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function resolveUrl(base: string, ref: string): string | undefined {
  try {
    return new URL(ref, base).toString();
  } catch {
    return undefined;
  }
}

/** 拉取字节前缀；URL 未通过 SSRF 检查或请求失败都返回 undefined */
async function fetchBytesPrefix(
  url: string,
  maxBytes: number,
  source: SourceConfig,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  try {
    await assertAllowedTarget(url);
  } catch {
    return undefined;
  }
  // 必须用 fetchChecked 而不是裸 fetch：裸 fetch 的 redirect:'follow' 只校验首跳，
  // 恶意源站回一个 302 到 127.0.0.1 就能绕过 SSRF 防护打内网。
  const res = await fetchChecked(new URL(url), { headers: prefixHeaders(source), signal }, false);
  if (!res.ok) return undefined;
  return readBytesPrefix(res, maxBytes);
}

async function fetchTextPrefix(
  url: string,
  maxBytes: number,
  source: SourceConfig,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    await assertAllowedTarget(url);
  } catch (err) {
    return { ok: false, status: 0, text: err instanceof Error ? err.message : '地址不可用' };
  }
  // 同上：逐跳校验重定向，不能只信首跳
  const res = await fetchChecked(new URL(url), { headers: prefixHeaders(source), signal }, false);
  if (!res.ok) return { ok: false, status: res.status, text: '' };
  return { ok: true, status: res.status, text: await readTextPrefix(res, maxBytes) };
}

/** 只读响应体前 maxBytes 字节：分片动辄几十 MB */
async function readBytesPrefix(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readTextPrefix(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

/** master playlist 最高档的短边高度；媒体列表返回 undefined */
export function parseBestHeight(text: string): number | undefined {
  if (!text.includes('#EXT-X-STREAM-INF')) return undefined;
  let best: number | undefined;
  let pending: { bandwidth: number; height?: number } | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
      const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/);
      // 取短边：采集站常把宽高写反，按 height 取会把 720x1280 标成 2K
      pending = {
        bandwidth,
        height: resolution ? Math.min(parseInt(resolution[1], 10), parseInt(resolution[2], 10)) : undefined,
      };
      continue;
    }
    if (!line || line.startsWith('#') || !pending) continue;
    const height =
      pending.height ??
      (pending.bandwidth > 0 ? inferHeightFromBitrate(pending.bandwidth) : undefined);
    if (height && (best === undefined || height > best)) best = height;
    pending = undefined;
  }
  return best;
}

interface MediaPlaylistInfo {
  initUri?: string;
  firstSegment?: string;
  keyMethod?: string;
  keyUri?: string;
  keyIv?: Uint8Array;
  mediaSequence: number;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const value = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) return undefined;
    out[i] = value;
  }
  return out;
}

export function parseMediaPlaylist(text: string): MediaPlaylistInfo {
  const info: MediaPlaylistInfo = { mediaSequence: 0 };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      info.initUri = line.match(/URI="([^"]+)"/)?.[1];
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      info.keyMethod = line.match(/METHOD=([^,]+)/)?.[1]?.trim();
      info.keyUri = line.match(/URI="([^"]+)"/)?.[1];
      const iv = line.match(/IV=0x([0-9a-fA-F]+)/)?.[1];
      info.keyIv = iv ? hexToBytes(iv) : undefined;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const seq = parseInt(line.slice(line.indexOf(':') + 1).trim(), 10);
      info.mediaSequence = Number.isNaN(seq) ? 0 : seq;
      continue;
    }
    if (!line.startsWith('#') && info.firstSegment === undefined) info.firstSegment = line;
  }
  return info;
}

/** HLS 未显式给 IV 时用媒体序列号作大端 128 位 IV */
function defaultIv(sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  const seq = sequence >>> 0;
  iv[12] = (seq >>> 24) & 0xff;
  iv[13] = (seq >>> 16) & 0xff;
  iv[14] = (seq >>> 8) & 0xff;
  iv[15] = seq & 0xff;
  return iv;
}

async function probeSegmentResolution(
  text: string,
  playlistUrl: string,
  source: SourceConfig,
  signal: AbortSignal
): Promise<number | undefined> {
  const list = parseMediaPlaylist(text);
  if (!list.firstSegment) return undefined;

  if (list.initUri) {
    const initUrl = resolveUrl(playlistUrl, list.initUri);
    if (initUrl) {
      const buf = await fetchBytesPrefix(initUrl, INIT_PREFIX_BYTES, source, signal);
      const found = buf ? parseMp4VideoResolution(buf) : undefined;
      if (found) return found.height;
    }
  }

  const segmentUrl = resolveUrl(playlistUrl, list.firstSegment);
  if (!segmentUrl) return undefined;
  let buf = await fetchBytesPrefix(segmentUrl, SEGMENT_PREFIX_BYTES, source, signal);
  if (!buf || buf.length === 0) return undefined;

  if (list.keyMethod && list.keyMethod !== 'NONE') {
    // SAMPLE-AES 是按采样加密的，拿不到分片级解密上下文，直接放弃
    if (list.keyMethod !== 'AES-128' || !list.keyUri) return undefined;
    const keyUrl = resolveUrl(playlistUrl, list.keyUri);
    if (!keyUrl) return undefined;
    const key = await fetchBytesPrefix(keyUrl, 32, source, signal);
    if (!key || key.length < 16) return undefined;
    buf = decryptAes128CbcPrefix(buf, key, list.keyIv ?? defaultIv(list.mediaSequence));
  }

  if (looksLikeMp4(buf)) return parseMp4VideoResolution(buf)?.height;
  return parseTsVideoResolution(buf)?.height;
}

async function withSegmentBudget(
  playlistUrl: string,
  text: string,
  source: SourceConfig,
  merged: AbortSignal,
  clientSignal?: AbortSignal
): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('分片解析超时', 'TimeoutError')), SEGMENT_BUDGET_MS);
  try {
    return await probeSegmentResolution(text, playlistUrl, source, AbortSignal.any([merged, controller.signal]));
  } catch {
    if (clientSignal?.aborted) throw new DOMException('已取消', 'AbortError');
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 中间集优先，探不出再退最后一集；单集直接返回唯一一集 */
export function probeEpisodeOrder(episodes: string[]): string[] {
  if (episodes.length < 2) return episodes.slice(0, 1);
  const mid = episodes[Math.floor(episodes.length / 2)] ?? episodes[0];
  const last = episodes[episodes.length - 1];
  return mid === last ? [mid] : [mid, last];
}

async function probeEpisode(
  target: string,
  source: SourceConfig,
  merged: AbortSignal,
  signal?: AbortSignal
): Promise<{ height?: number; error?: string }> {
  const isM3u8 = /\.m3u8([?#]|$)/i.test(target);

  if (!isM3u8) {
    // mp4 直链：moov 里有分辨率；未 faststart 的文件 moov 在尾部 → 仍未知
    if (!/\.mp4([?#]|$)/i.test(target)) return {};
    const buf = await fetchBytesPrefix(target, SEGMENT_PREFIX_BYTES, source, merged);
    return { height: buf ? parseMp4VideoResolution(buf)?.height : undefined };
  }

  const res = await fetchTextPrefix(target, M3U8_MAX_BYTES, source, merged);
  if (!res.ok) return { error: res.status ? `HTTP ${res.status}` : '网络请求失败' };

  const height = parseBestHeight(res.text);
  if (height !== undefined) return { height };
  return { height: await withSegmentBudget(target, res.text, source, merged, signal) };
}

async function fetchEpisodes(source: SourceConfig, id: string, signal: AbortSignal): Promise<string[]> {
  try {
    const detail = await fetchDetail(source, id, createFetchHttp(), { timeoutMs: 8000, signal });
    return detail.episodes;
  } catch {
    return [];
  }
}

/** 探测单条「源 + 影片」；height 为 undefined 表示测不出，error 表示失败 */
export async function probeQuality(
  request: QualityProbeRequest & { signal?: AbortSignal }
): Promise<QualityProbeResponse> {
  const { source, vodId, signal } = request;
  const key = qualityKey(source.key, vodId);
  const cached = cache.get(key);
  if (cached && isQualityEntryFresh(cached)) {
    return {
      ok: true,
      height: cached.height,
      label: qualityLabel(cached.height),
      error: cached.error,
      reason: failureReasonLabel(cached.error),
      retryable: isRetryableTimeout(cached.error),
      cached: true,
    };
  }

  if (!/^https?:\/\//i.test(source.url || '') || !/^[\w-]+$/.test(vodId)) {
    return { ok: false, error: '无效的源或影片 ID', retryable: false, cached: false };
  }
  try {
    await assertAllowedTarget(source.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : '源地址不可用';
    return { ok: false, error: message, retryable: false, cached: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('画质探测超时', 'TimeoutError')),
    QUALITY_PROBE_TIMEOUT_MS
  );
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

  try {
    const episodes = await fetchEpisodes(source, vodId, merged);
    if (episodes.length === 0) {
      const entry: QualityEntry = { sourceKey: source.key, vodId, error: '未找到播放资源', from: 'probe', timestamp: Date.now() };
      remember(entry);
      return { ok: true, error: entry.error, reason: failureReasonLabel(entry.error), retryable: false, cached: false };
    }

    const startedAt = Date.now();
    let lastError: string | undefined;
    let height: number | undefined;
    for (const target of probeEpisodeOrder(episodes)) {
      const r = await probeEpisode(target, source, merged, signal);
      if (r.height !== undefined) {
        height = r.height;
        break;
      }
      if (r.error) lastError = r.error;
      // 401/403 是源站级拒绝，换集也不会变
      if (lastError && /^HTTP (401|403)$/.test(lastError)) break;
      // 时间过半就不再换集，免得把「未知」拖成「失败」
      if (Date.now() - startedAt > QUALITY_PROBE_TIMEOUT_MS / 2) break;
    }

    const entry: QualityEntry = {
      sourceKey: source.key,
      vodId,
      height,
      error: height === undefined ? lastError : undefined,
      from: 'probe',
      timestamp: Date.now(),
    };
    remember(entry);
    return {
      ok: true,
      height,
      label: qualityLabel(height),
      error: entry.error,
      reason: failureReasonLabel(entry.error),
      retryable: isRetryableTimeout(entry.error),
      cached: false,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error && err.name === 'TimeoutError' ? '画质探测超时' : err instanceof Error ? err.message : '探测失败';
    remember({ sourceKey: source.key, vodId, error: message, from: 'probe', timestamp: Date.now() });
    return { ok: true, error: message, reason: failureReasonLabel(message), retryable: isRetryableTimeout(message), cached: false };
  } finally {
    clearTimeout(timer);
  }
}


