/**
 * 片名索引的本地持久化。
 *
 * 与 `catalog-cache.ts` 同一套思路（localStorage + 签名校验），但索引有自己的两个
 * 关键差异：
 *
 * 1. **签名不符不必整份丢掉**。分类缓存换源就作废是对的（分类树完全可能不同），
 *    但片名索引里绝大部分条目仍然有效——换掉一个源，其它 14 个源的片名一条都没变。
 *    所以这里只按 `sourceKey` 剔除已删除源的条目，其余保留。
 *
 * 2. **体积上限更硬**。6 万条 × ~130 字节 ≈ 8MB，而 Chromium 的 localStorage 配额是
 *    10MB 且与分类目录、搜索缓存、播放历史共享。`catalog.ts` 的注释记录过历史事故：
 *    缓存顶到配额后写不进去，每次冷启动都全量重拉。所以这里先 `pruneIndex` 再存，
 *    存不下就逐次减半重试，绝不让写失败变成「每次启动都重新扫一遍」。
 */
import {
  emptyIndex,
  isIndexUsable,
  pruneIndex,
  type IndexCursor,
  type TitleIndexEntry,
  type TitleIndexSnapshot,
} from '@librextv/core';

const INDEX_KEY = 'librextv-title-index-v1';

interface StoredIndex {
  signature: string;
  hot: TitleIndexEntry[];
  deep: TitleIndexEntry[];
  cursors: Record<string, IndexCursor>;
}

/** 单次写入的条目上限（约 1.5MB），超出就裁剪——索引宁可少也不能写不进去 */
const WRITE_LIMIT = 12_000;

function safeParse(raw: string | null): StoredIndex | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredIndex>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!Array.isArray(parsed.hot) || !Array.isArray(parsed.deep)) return null;
    return {
      signature: typeof parsed.signature === 'string' ? parsed.signature : '',
      hot: parsed.hot,
      deep: parsed.deep,
      cursors:
        parsed.cursors && typeof parsed.cursors === 'object'
          ? (parsed.cursors as Record<string, IndexCursor>)
          : {},
    };
  } catch {
    return null;
  }
}

/**
 * 读索引。
 *
 * 传了 `signature` 且不匹配时，**不整份作废**，而是剔掉不在当前源里的条目——
 * 只有一条都剩不下时才退化成空索引。
 */
export function readIndex(signature?: string, liveKeys?: readonly string[]): TitleIndexSnapshot {
  const stored = safeParse(localStorage.getItem(INDEX_KEY));
  if (!stored) return emptyIndex(signature ?? '');

  const keep = liveKeys ? new Set(liveKeys) : null;
  const filter = (list: TitleIndexEntry[]): TitleIndexEntry[] =>
    keep ? list.filter((e) => keep.has(e.sourceKey)) : list;
  const hot = filter(stored.hot);
  const deep = filter(stored.deep);
  if (hot.length === 0 && deep.length === 0) return emptyIndex(signature ?? stored.signature);

  const cursors: Record<string, IndexCursor> = {};
  for (const [key, cursor] of Object.entries(stored.cursors)) {
    if (!keep || keep.has(key)) cursors[key] = cursor;
  }

  return {
    // 签名总是用调用方给的新值：源换了就该按新签名继续，否则下次写回又把旧签名带进去
    signature: signature ?? stored.signature,
    hot,
    deep,
    cursors,
  };
}

/**
 * 写索引。超出配额时逐次减半重试，最坏情况是只存下小部分条目——
 * 这仍比写失败（每次启动全量重扫）好得多。
 */
export function writeIndex(snapshot: TitleIndexSnapshot): boolean {
  const payload = (hot: TitleIndexEntry[], deep: TitleIndexEntry[]): StoredIndex => ({
    signature: snapshot.signature,
    hot,
    deep,
    cursors: snapshot.cursors,
  });

  let hot = snapshot.hot;
  let deep = snapshot.deep;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(payload(hot, deep)));
      return true;
    } catch {
      // 配额满或序列化失败：把条目砍半再来一次
      if (hot.length === 0 && deep.length === 0) return false;
      hot = hot.slice(0, Math.floor(hot.length / 2));
      deep = deep.slice(0, Math.floor(deep.length / 2));
    }
  }
  return false;
}

/**
 * 写入前先裁剪：热区全留，冷区按上限裁。
 *
 * 热区是新片（用户最可能搜的），必须全留；冷区是历史档案，超限时丢最老的。
 */
export function prepareForWrite(snapshot: TitleIndexSnapshot): TitleIndexSnapshot {
  if (snapshot.hot.length + snapshot.deep.length <= WRITE_LIMIT) return snapshot;
  const hot = snapshot.hot;
  const merged = pruneIndex([...snapshot.deep, ...hot], WRITE_LIMIT);
  const hotKeys = new Set(hot.map((e) => `${e.sourceKey}:${e.vodId}`));
  return {
    ...snapshot,
    hot,
    deep: merged.filter((e) => !hotKeys.has(`${e.sourceKey}:${e.vodId}`)),
  };
}

/** 清空索引（设置页「清空缓存」用） */
export function clearIndex(): void {
  localStorage.removeItem(INDEX_KEY);
}

/** 当前索引是否可用（签名匹配且有内容），供启动器判断要不要扫 */
export function hasUsableIndex(signature: string): boolean {
  return isIndexUsable(readIndex(signature), signature);
}
