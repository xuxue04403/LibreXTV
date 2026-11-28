/**
 * HLS 播放列表广告分片过滤（纯函数）。
 *
 * 移植自 LibreTV（AGPL-3.0-or-later）src/lib/m3u8.ts 中的广告过滤部分：
 * https://github.com/LibreSpark/LibreTV
 * 改动：仅保留广告相关函数，去掉离线下载/加解密逻辑。
 */

const LEAD_AD_MAX_SECONDS = 90;
const LEAD_AD_MAX_SEGMENTS = 20;

/**
 * 剔除 m3u8 片头插入的广告段（整段移除分片，而不是只删 #EXT-X-DISCONTINUITY
 * 标记——实测 dytt 源每段 PTS 基准独立跳变，删标记会让 hls.js 把整条流当连续
 * 时间轴，视频丢帧、音频错位，出现「只闻广告声不见其画面」）。
 *
 * 保守判定（全部满足才剔除）：
 * 0. 多分组封装下片头组与其余组同构时跳过；
 * 1. 首个分片之前存在 DISCONTINUITY；
 * 2. 该段以下一个 DISCONTINUITY 结束，且其后仍有分段；
 * 3. 段时长 ≤ 90s 且分片数 ≤ 20。
 */
export function stripLeadAdGroup(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l: string) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l: string) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const discIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);
  if (discIdx.length >= 4) {
    const groupSize = (from: number, to: number) => {
      let seg = 0;
      for (let k = from; k < to; k++) if (isSegment(lines[k])) seg += 1;
      return seg;
    };
    const leadSize = groupSize(discIdx[0] + 1, discIdx[1]);
    const others: number[] = [];
    for (let g = 1; g < discIdx.length; g++) {
      others.push(groupSize(discIdx[g] + 1, g + 1 < discIdx.length ? discIdx[g + 1] : lines.length));
    }
    const sorted = [...others].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const typical = Math.abs(leadSize - median) <= Math.max(3, median * 0.5);
    if (typical) return m3u8Content;
  }

  const firstDisc = discIdx[0];
  if (firstDisc === undefined) return m3u8Content;
  if (lines.slice(0, firstDisc).some(isSegment)) return m3u8Content;

  const nextDisc = discIdx.slice(1).find((i) => i > firstDisc);
  if (nextDisc === undefined) return m3u8Content;

  let seconds = 0;
  let count = 0;
  for (let i = firstDisc + 1; i < nextDisc; i++) {
    const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
    if (m) seconds += parseFloat(m[1]) || 0;
    else if (isSegment(lines[i])) count += 1;
  }
  if (count === 0 || count > LEAD_AD_MAX_SEGMENTS) return m3u8Content;
  if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return m3u8Content;

  // 丢弃区间内的 KEY/MAP：它们属于广告段。保留下来会被搬到正片最前面，
  // hls.js 随后拿广告的 AES key 去解正片前几段 → 花屏/解码失败。
  // 注意与 stripMarkedAdGroups / stripInterstitialAdGroups 的差别：那两处是
  // 「原位跳过」（顺序不变，删掉的 KEY 只影响它自己的分片），这里是把区间
  // 整体摘掉，任何落在区间内的标签都会前移，所以必须一并丢弃。
  const kept = lines.filter((l, i) => i < firstDisc || i >= nextDisc);
  const out: string[] = [];
  let seenSegment = false;
  for (const l of kept) {
    if (!seenSegment && isDisc(l)) continue;
    if (isSegment(l)) seenSegment = true;
    out.push(l);
  }
  return out.join('\n');
}

/** 广告分片 URL 特征（暴风等采集云把中插广告放在 /video/adjump/… 路径） */
const AD_URL_PATTERN = /adjump|advert|\/ads?\//i;

function looksLikeAdUrl(line: string): boolean {
  return AD_URL_PATTERN.test(line.trim());
}

function stripMarkedAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l: string) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l: string) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const drop = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDisc(lines[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let count = 0;
    let allAd = true;
    while (j < lines.length && !isDisc(lines[j])) {
      if (isSegment(lines[j])) {
        count += 1;
        if (!looksLikeAdUrl(lines[j])) allAd = false;
      }
      j += 1;
    }
    if (count > 0 && allAd) {
      drop[i] = true;
      for (let k = i + 1; k < j; k++) {
        const t = lines[k].trim();
        if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
        drop[k] = true;
      }
    }
    i = j;
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

const INTERSTITIAL_MAX_SECONDS = 30;
const INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120;

interface AdGroupScan {
  start: number;
  end: number;
  discLine: number;
  seconds: number;
  count: number;
}

function scanGroups(
  lines: string[],
  isDisc: (l: string) => boolean,
  isSegment: (l: string) => boolean
): AdGroupScan[] {
  const discIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);

  const groups: AdGroupScan[] = [];
  const bounds = [0, ...discIdx, lines.length];
  for (let k = 0; k < bounds.length - 1; k++) {
    const start = k === 0 ? 0 : bounds[k] + 1;
    const end = bounds[k + 1];
    let seconds = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
      if (m) seconds += parseFloat(m[1]) || 0;
      else if (isSegment(lines[i])) count += 1;
    }
    groups.push({ start, end, discLine: k === 0 ? -1 : bounds[k], seconds, count });
  }
  return groups;
}

export function stripInterstitialAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l: string) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l: string) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const groups = scanGroups(lines, isDisc, isSegment);
  const drop = new Array<boolean>(lines.length).fill(false);
  for (let k = 1; k < groups.length; k++) {
    const g = groups[k];
    const prev = groups[k - 1];
    const next = groups[k + 1];
    if (g.count === 0 || g.discLine < 0) continue;
    if (g.seconds <= 0 || g.seconds > INTERSTITIAL_MAX_SECONDS) continue;
    if (!prev || prev.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
    if (!next || next.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
    drop[g.discLine] = true;
    for (let i = g.start; i < g.end; i++) {
      const t = lines[i].trim();
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
      drop[i] = true;
    }
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/** 清除首个分片之前的 DISCONTINUITY：其前没有媒体内容，标记无语义 */
function stripLeadingDisc(content: string): string {
  const lines = content.split('\n');
  const firstSeg = lines.findIndex((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  });
  if (firstSeg <= 0) return content;
  const kept = lines.filter((l, i) => !(i < firstSeg && l.trim() === '#EXT-X-DISCONTINUITY'));
  return kept.length === lines.length ? content : kept.join('\n');
}

/** 广告过滤总入口：URL 特征中插段 → 超短插入段 → 片头插入段 → 清理首部 DISCONTINUITY */
export function stripAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  return stripLeadingDisc(stripLeadAdGroup(stripInterstitialAdGroups(stripMarkedAdGroups(m3u8Content))));
}
