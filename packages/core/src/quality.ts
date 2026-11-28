/**
 * 画质工具：缓存键、档位标签、失败归因与缓存合并。
 *
 * 移植自 LibreTV 上游 src/lib/quality.ts（AGPL-3.0，作者 LibreSpark）。
 * 纯函数、无宿主依赖：探测在桌面主进程做，Android 端可复用同一套口径。
 */

import type { QualityEntry } from './types';

/** 成功结果缓存 30 天：源站换片源的概率低，期间直接复用 */
export const QUALITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 失败结果只缓存 2 分钟：偶发超时/限流不该被当成永久结论 */
export const QUALITY_FAIL_TTL_MS = 2 * 60 * 1000;

/** 失败原因短标签：徽章上直接给「超时/防盗链」，比只藏在 tooltip 里有用的多 */
export function failureReasonLabel(error?: string): string | undefined {
  if (!error) return undefined;
  // 传输层失败要排在「超时」之前：这类文案本身常带「多为网关超时」的解释，先匹配会把归因指错
  if (/中断|断开|送达|网关拦截/.test(error)) return '连接中断';
  if (error.includes('超时')) return '超时';
  if (/HTTP (401|403)/.test(error)) return '防盗链';
  if (/HTTP 5\d\d|\(5\d\d\)/.test(error)) return '网关异常';
  if (error.includes('未找到播放资源')) return '无资源';
  if (error.includes('无效')) return '源无效';
  return undefined;
}

/** 超时是唯一值得自动重试的失败：冷启动/CDN 抖动，再打一次常能成 */
export function isRetryableTimeout(error?: string): boolean {
  return !!error && error.includes('超时');
}

/**
 * 条目是否仍在有效期内（读取与写入都走这里）。
 * 读取路径也必须过滤：否则过期条目会被当成终态显示，且「有结论就不再探」会让它永不过期。
 */
export function isQualityEntryFresh(entry: QualityEntry, now = Date.now()): boolean {
  const ttl = entry.error ? QUALITY_FAIL_TTL_MS : QUALITY_TTL_MS;
  return now - entry.timestamp < ttl;
}

/** 缓存键按「源 + 影片」：同一源不同剧画质不同 */
export function qualityKey(sourceKey: string, vodId: string): string {
  return `${sourceKey}:${vodId}`;
}

/** 与档位值的偏差在此比例内才算同一档（采集站常裁边/等比缩放） */
const TIER_TOLERANCE = 0.15;

/** 档位表：高度 → 标签 */
const TIERS: ReadonlyArray<readonly [number, string]> = [
  [2160, '4K'],
  [1440, '2K'],
  [1080, '1080P'],
  [720, '720P'],
  [540, '540P'],
  [480, '480P'],
  [360, '360P'],
];

/** 高度 → 就近档位；偏差超 15% 原样 `${height}P` */
export function qualityLabel(height?: number): string | undefined {
  if (!height || height <= 0) return undefined;
  let best: readonly [number, string] | undefined;
  for (const tier of TIERS) {
    const [value] = tier;
    if (Math.abs(value - height) > value * TIER_TOLERANCE) continue;
    if (!best || Math.abs(value - height) < Math.abs(best[0] - height)) best = tier;
  }
  return best ? best[1] : `${height}P`;
}

/** 缓存条目上限：每部剧 × 每个源一条，需防无上限膨胀 */
export const QUALITY_MAX_ENTRIES = 400;

/**
 * 合并画质缓存（纯函数）。
 * 1. play 压 probe：解码出来的才是真的；
 * 2. play 之间取较大值：ABR 起播先低档，取最大避免低估；
 * 3. probe 的「测不出」不抹掉已知档位：偶发失败不该毁掉好结果。
 */
export function mergeQualityEntries(
  current: Record<string, QualityEntry>,
  incoming: Record<string, QualityEntry>,
  now = Date.now()
): Record<string, QualityEntry> {
  const next: Record<string, QualityEntry> = {};
  for (const [key, entry] of Object.entries(current)) {
    if (isQualityEntryFresh(entry, now)) next[key] = entry;
  }

  for (const [key, value] of Object.entries(incoming)) {
    const prev = next[key];
    if (prev?.from === 'play') {
      if (value.from !== 'play') continue;
      const best = Math.max(prev.height ?? 0, value.height ?? 0);
      next[key] = { from: 'play', height: best || undefined, timestamp: now, sourceKey: prev.sourceKey, vodId: prev.vodId };
      continue;
    }
    if (prev?.from === 'probe' && value.from === 'probe' && prev.height !== undefined && value.height === undefined) {
      continue;
    }
    next[key] = value;
  }

  const overflow = Object.keys(next).length - QUALITY_MAX_ENTRIES;
  if (overflow > 0) {
    const oldest = Object.entries(next)
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldest) delete next[key];
  }
  return next;
}

// —— 反馈层：徽章四态 ——

export type QualityBadgeKind = 'loading' | 'value' | 'unknown' | 'failed';

export interface QualityBadgeView {
  kind: QualityBadgeKind;
  label?: string;
  reason?: string;
  title: string;
  retryable: boolean;
}

/**
 * 画质徽章四态；返回 undefined 表示「尚未探测过」——不渲染，
 * 避免把「还没探」画成「未知」，两者含义不同。
 */
export function describeQualityBadge(
  entry: QualityEntry | undefined,
  loading = false
): QualityBadgeView | undefined {
  if (loading) return { kind: 'loading', title: '正在探测画质…', retryable: false };
  if (!entry) return undefined;
  const label = qualityLabel(entry.height);
  if (label) {
    return {
      kind: 'value',
      label,
      title:
        entry.from === 'play'
          ? `播放实测的真实分辨率（${entry.height}P）`
          : `解析播放列表得到的档位（${entry.height}P）`,
      retryable: false,
    };
  }
  if (entry.error) {
    const reason = failureReasonLabel(entry.error);
    return {
      kind: 'failed',
      label: '未测到',
      reason,
      title: `本次没测到画质：${entry.error}。${
        reason === '超时' ? '多半是网络抖动或源站响应慢，点击重试' : '点击可重试，也可以直接播放，播放后会自动记录实测分辨率'
      }`,
      retryable: true,
    };
  }
  return {
    kind: 'unknown',
    title: '单码率或直链，播放列表里没有画质信息；播放一次后会记录实测分辨率',
    retryable: false,
  };
}

/**
 * 码率 → 推断高度：部分源站 master playlist 只给 BANDWIDTH。
 * 分层取自常见转码参数，仅用于档位标识。
 */
export function inferHeightFromBitrate(bandwidth: number): number {
  // 0 / NaN / 负数都不代表「240p」，只是「未知」。返回 240 会让档位标识
  // 把没有码率信息的流也标成低清，调用方就该拿到一个明确的兜底值。
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) return 240;
  const tiers: Array<[number, number]> = [
    [20_000_000, 4320],
    [10_000_000, 2160],
    [5_000_000, 1080],
    [3_000_000, 720],
    [1_500_000, 540],
    [800_000, 480],
    [400_000, 360],
  ];
  for (const [bps, height] of tiers) {
    if (bandwidth >= bps) return height;
  }
  return 240;
}
