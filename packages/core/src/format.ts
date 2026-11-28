/** 格式化工具，移植自 LibreTV src/lib/utils.ts（AGPL-3.0-or-later）。 */

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 地址合法性校验：仅 http(s)，且必须是能被 URL 解析的真实地址。
 *
 * 原来的 `/^https?:\/\/.+/` 只数前缀，`https://exa mple.com`、`http://[` 这类
 * 一眼假的地址照样放进订阅，等真正请求时才在 fetch 里炸成一句英文报错。
 */
export function isValidSourceUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  const text = url.trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return false;
  try {
    const parsed = new URL(text);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 取 hostname 作为名称兜底；地址非法时原样返回 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 由 URL 生成稳定短 key（djb2 变体，与上游 store.subKeyPrefix 同风格） */
export function stableKey(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 清理地址末尾斜杠 */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * 把集数下标夹进合法范围。
 *
 * 观看记录里的 `episodeIndex` 合法值是 `[0, episodeCount-1]`，但「看完一集」时
 * 会把它推到下一集，最后一集看完就写成了 `episodeCount`——直接拿去渲染就是
 * 「第 17 / 16 集」这种自相矛盾的卡片，拿去当播放起点则会被各处不同的
 * `Math.min` 兜住，于是「显示第 15 集、实际播第 2 集」这类错位到处冒。
 * 所有读写集数的地方都走这里，只留一个口径。
 */
export function clampEpisodeIndex(index: number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.trunc(index), Math.trunc(length) - 1));
}

/**
 * 剧集标题：一律按数组下标编号。
 *
 * 原来优先取 URL 里的数字当集号，但采集站的地址千奇百怪（`/1.m3u8`、`/20260914/xxx/index.m3u8`），
 * 同一个列表里还可能混着预告片，结果就是「选集面板显示第 2 集、播放页头部显示第 15 集」。
 * 用户看到的集号必须等同于他点的那一格、也等同于真正播放的那一格，所以统一用下标。
 */
export function episodeLabel(index: number): string {
  // 与 clampEpisodeIndex 同一口径：NaN/Infinity 一律当第 1 集，
  // 否则面板上会出现「第 NaN 集」
  if (!Number.isFinite(index)) return '第 1 集';
  return `第 ${Math.max(0, Math.trunc(index)) + 1} 集`;
}
