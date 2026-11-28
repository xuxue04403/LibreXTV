/**
 * 本地片名索引：为「按拼音首字母检索」提供一份可离线查询的片名表。
 *
 * ## 为什么需要它
 *
 * 采集站的列表接口只认 `t`（分类）、`wd`（关键词）、`pg`（页码）。`letter=` 被完全忽略
 * （2026-11 实测：`letter=S` / `letter=s` 对 total 与分布一字不差），所以「列出所有
 * 首字母为 s 的片名」**根本无法表达给远端**。
 *
 * 之前 AndroidTV 的做法是临时翻各源的「最新列表」找匹配项。实测（`.tmp-pool/scan-cost.ts`，
 * 非凡单源 60 页 / 1200 条）：
 *
 * | 查询 | 命中 | 首次出现 | 凑够 20 条需翻到 |
 * |------|------|----------|------------------|
 * | `s`  | 99   | pg=1     | pg=19            |
 * | `dl` | 47   | pg=1     | pg=19            |
 * | `zz` | 36   | pg=3     | pg=29            |
 * | `sx` | 36   | pg=4     | **pg=42**        |
 * | `xy` | 26   | pg=2     | **pg=50**        |
 *
 * 「敲两个字母要翻 42~50 页」——单源、单次查询。13 个源就是 500+ 请求、几十秒，深页还多
 * 是无封面无简介的老片，结果自然又慢又不准。改成索引后同一批片名只在本地比对：**零网络、
 * 毫秒级**，且每多扫一页就多一分召回（临时翻页翻完即弃，索引不会）。
 *
 * ## 冷热分区（为什么不是「定期全量重扫」）
 *
 * 采集站的最新列表按入库时间倒序，所以：
 * - **前几页**（热区）= 新片，每天在变，需要定期重扫；
 * - **第 20 页往后**（冷区）= 三个月前入库的老片，**不会再变动**，扫过一次就该永久留着。
 *
 * 如果按「全量刷新」的思路，每隔几小时就要把 60 页 × 15 源 = 900 个请求重打一遍，而其中
 * 绝大多数内容一个字都不会变——这正是「缓存频率不必那么高」要解决的问题。分区的结果是：
 *
 * | 区域 | 范围 | 何时扫 | 频率 |
 * |------|------|--------|------|
 * | 热区 | 第 1~5 页/源 | 定时重扫（整段替换） | 12 小时 |
 * | 冷区推进 | 第 6~60 页/源 | 增量补齐，扫满即止 | 一次性，分几轮 |
 * | 冷区巡检 | 第 6~60 页里的一小段 | 慢速轮转重扫 | 每源 7 天 4 页 |
 *
 * 三档都**仍然会重新加载**，只是频率拉开了：真正天天变的只有热区，冷区用轮转巡检
 * 兜住「零星下架/改名」，不必整段重打。稳态开销约 75 请求 / 12 小时（热区）加上
 * 60 请求 / 7 天（巡检），相比全量刷新每小时 900 请求降了两个量级。
 *
 * ## 索引兜不住的部分：远端拼音检索（`REMOTE_PINYIN_SOURCES`）
 *
 * 索引只装得下扫过的那些页。实测非凡的第 6000 条以外还有大量老片（`庆余年`、`三体`、
 * `甄嬛传` 在 300 页 / 6000 条里一次都没出现），靠翻页永远补不全。
 *
 * 但有两个源**自己在 `wd` 上实现了拼音检索**：`量子资源`（`cj.lziapi.com`）与
 * `暴风资源`（`bfzyapi.com`）。`wd=dldl` 直接返回斗罗大陆全系列，`wd=qyn` 命中年份久远的
 * 「庆余年 第一季」，而这些片在它们的「最新列表」里根本翻不到对应页——说明是**按全库
 * 标题索引**匹配的（`wd=dl` 还会顺带召回「两个人的车站」，即前缀+全拼混合语义）。
 *
 * 所以最终方案是**两条路并存**：
 * - 本地索引：毫秒级、离线可用、覆盖所有已扫内容 → 决定「输入即出建议」的响应速度；
 * - 远端拼音检索：只打 `REMOTE_PINYIN_SOURCES` 这几个源，补索引装不下的历史老片，
 *   在后台异步合并进建议列表（`remotePinyinSearch`）。
 *
 * 两条路都有才叫「又快又准」：只靠本地索引，老片搜不到；只靠远端，每敲一个字母都要等
 * 网络，而且 13 个源里只有 2 个能这么搜。
 *
 * 所有扫描都走**后台低优先级**（见 `planBackgroundScan`）：只在用户空闲、页面隐藏或
 * 没有交互时推进，绝不与浏览/搜索抢带宽；用户一有操作就让路，下次接着从游标继续。
 *
 * ## 数据结构
 *
 * 每条只存「片名 + 定位 + 首字母串」，不存海报大图与简介正文。6 万条估算 2MB 上下，
 * 所以在 `MAX_INDEX_ENTRIES` 处还有一层按字母覆盖的裁剪兜底。
 */

import type { SearchResultItem, SourceConfig } from './types';
import type { HttpClient } from './http';
import { cmsRequestHeaders, cmsUrl, normalizeTitle, parseSearchList } from './cms';
import { pinyinInitials } from './pinyin';
import { catalogLimiter, sourceLimiter } from './limiter';

/** 索引里的一条：只保留「能重建可点卡片 + 能用首字母匹配」的最小字段 */
export interface TitleIndexEntry {
  /** 片名（原样，展示用） */
  readonly name: string;
  /** 拼音首字母串，如 `奇妙萌可` → `qmmk` */
  readonly initials: string;
  readonly sourceKey: string;
  readonly sourceName: string;
  readonly vodId: string;
  readonly pic?: string;
  readonly year?: string;
  readonly typeName?: string;
  readonly area?: string;
  readonly remarks?: string;
}

/** 每个源的推进游标（冷热分开记，热区重扫不影响冷区进度） */
export interface IndexCursor {
  /** 热区上次重扫时间；0 表示还没扫过 */
  readonly hotAt: number;
  /** 冷区已推进到第几页（含热区范围）；冷区从 `INDEX_HOT_PAGES + 1` 开始 */
  readonly deepPages: number;
  /** 冷区是否已补齐到目标深度（true 之后不再推进，但会参与轮转巡检） */
  readonly deepDone: boolean;
  /** 巡检游标：下一段要从第几页开始重扫（`0` 表示还没巡检过） */
  readonly sweepPage?: number;
  /** 上次巡检时间 */
  readonly sweepAt?: number;
}

export interface TitleIndexSnapshot {
  /** 索引签名：源集合变化时整份作废，避免张冠李戴 */
  readonly signature: string;
  /** 热区条目：最近几页，重扫时整批替换 */
  readonly hot: TitleIndexEntry[];
  /** 冷区条目：深页，只增量追加，不重扫 */
  readonly deep: TitleIndexEntry[];
  readonly cursors: Record<string, IndexCursor>;
}

/** 索引最多保留多少条（裁剪兜底，正常情况下扫不到这么多） */
export const MAX_INDEX_ENTRIES = 60_000;

/** 热区页数：这几页每天在变，需要重扫 */
export const INDEX_HOT_PAGES = 5;

/** 热区重扫周期。片库以天为单位变化，12 小时足够，没必要 1 小时 */
export const INDEX_HOT_TTL_MS = 12 * 60 * 60 * 1000;

/** 冷区目标深度（每源）。实测 `sx` 在第 42 页才凑够候选，60 页留了余量 */
export const INDEX_DEEP_TARGET_PAGES = 60;

/** 冷区单轮推进页数（每源）。分几轮补齐，避免一次打出几百个请求 */
export const INDEX_DEEP_STEP_PAGES = 20;

/**
 * 冷区巡检周期：每源每 7 天挑一小段重扫一次。
 *
 * 冷区内容基本不变，但**不是绝对不变**——采集站偶尔下架、改名、换封面。整段重扫
 * （55 页）7 天一次就是 825 请求/7 天，太浪费；改成每次只看 4 页、轮转覆盖，
 * 一周扫完一个源的一半，两周走完一圈。发现内容有变就整段替换该源那一小段。
 */
export const INDEX_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** 每源每次巡检重扫几页 */
export const INDEX_SWEEP_PAGES = 4;

/** 单轮跨源总页数上限，给采集站与 UI 都留余地 */
export const MAX_PAGES_PER_ROUND = 80;

/** 首字母查询最短长度 */
export const MIN_QUERY_LENGTH = 1;

/** 一次最多返回多少条建议 */
export const MAX_SUGGESTIONS = 200;

/**
 * 索引签名：源集合 + 成人过滤。
 *
 * 只取 key 与 url，不取 name：改名不该让整份索引作废（用户会白等一次全量扫描）。
 * 成人开关也算进来：关掉后索引里的成人条目要跟着消失，否则建议里会漏出来。
 */
export function indexSignature(sources: readonly SourceConfig[], adultFilter: boolean): string {
  const parts = sources
    .map((s) => `${s.key}=${s.url}`)
    .sort()
    .join('|');
  return `${adultFilter ? 'a1' : 'a0'}#${parts}`;
}

export function emptyIndex(signature = ''): TitleIndexSnapshot {
  return { signature, hot: [], deep: [], cursors: {} };
}

/** 全部条目（冷区在前：同一部片冷区里是老记录，热区里是新记录，后者在合并时胜出） */
export function allEntries(snapshot: TitleIndexSnapshot): TitleIndexEntry[] {
  return [...snapshot.deep, ...snapshot.hot];
}

/**
 * 快照能否直接拿来用。
 *
 * 只看签名与「有没有内容」：**不看时间**。热区过期由 `planScan` 决定要不要重扫，
 * 但过期不等于不能用——继续拿旧索引出建议，远比让用户对着空白等一轮扫描好。
 */
export function isIndexUsable(snapshot: TitleIndexSnapshot | undefined, signature: string): boolean {
  if (!snapshot || snapshot.signature !== signature) return false;
  return snapshot.hot.length > 0 || snapshot.deep.length > 0;
}

/**
 * 是否还有该干的活（都干完时后台预热应该彻底停下，别再定时唤醒）。
 *
 * 注意巡检也算活：它 7 天才做一次，但「还没到点」不等于「没事做」——
 * 这里只在**三档都到位**时返回 false，让调用方用较长的定时器继续唤醒。
 */
export function needsWork(
  snapshot: TitleIndexSnapshot,
  sources: readonly SourceConfig[],
  now = Date.now()
): boolean {
  for (const source of sources) {
    const cursor = snapshot.cursors[source.key];
    if (!cursor) return true;
    if (now - cursor.hotAt >= INDEX_HOT_TTL_MS) return true;
    if (!cursor.deepDone) return true;
    if (now - (cursor.sweepAt ?? 0) >= INDEX_SWEEP_INTERVAL_MS) return true;
  }
  return false;
}

/** 冷区推进进度，供设置页/调试显示 */
export function deepProgress(
  snapshot: TitleIndexSnapshot,
  sources: readonly SourceConfig[]
): { done: number; total: number; pages: number; target: number } {
  let done = 0;
  let pages = 0;
  for (const source of sources) {
    const cursor = snapshot.cursors[source.key];
    if (cursor?.deepDone) done++;
    pages += Math.max(0, (cursor?.deepPages ?? 0) - INDEX_HOT_PAGES);
  }
  return {
    done,
    total: sources.length,
    pages,
    target: Math.max(0, INDEX_DEEP_TARGET_PAGES - INDEX_HOT_PAGES) * sources.length,
  };
}

/** 把一条搜索结果转成索引条目；片名为空或首字母为空的丢掉（它们检索不到） */
export function toIndexEntry(item: SearchResultItem): TitleIndexEntry | null {
  const name = (item.name || '').trim();
  if (!name) return null;
  const initials = pinyinInitials(name);
  if (!initials) return null;
  return {
    name,
    initials,
    sourceKey: item.sourceKey,
    sourceName: item.sourceName,
    vodId: item.vodId,
    ...(item.pic ? { pic: item.pic } : {}),
    ...(item.year ? { year: item.year } : {}),
    ...(item.typeName ? { typeName: item.typeName } : {}),
    ...(item.area ? { area: item.area } : {}),
    ...(item.remarks ? { remarks: item.remarks } : {}),
  };
}

/**
 * 去重合并：同一源同一 id 只留一条，新的覆盖旧的（海报可能更新）。
 *
 * 跨源同名**不合并**：用户点建议后要能选源，多源各一条是对的。
 */
export function mergeEntries(
  existing: readonly TitleIndexEntry[],
  incoming: readonly TitleIndexEntry[]
): TitleIndexEntry[] {
  const map = new Map<string, TitleIndexEntry>();
  for (const e of existing) map.set(`${e.sourceKey}:${e.vodId}`, e);
  for (const e of incoming) map.set(`${e.sourceKey}:${e.vodId}`, e);
  return [...map.values()];
}

/**
 * 裁剪到上限。
 *
 * 淘汰顺序的设计要点：**不能只按「新」砍**。热区一直重扫会不断挤掉冷区，最后 z/x 开头
 * 这种冷门字母会被清空——用户敲 `zz` 一无所获。因此：
 * 1. 先保「每个首字母至少 `perLetterFloor` 条」（按字母分组，各组留最新的）；
 * 2. 剩下的名额给最新的条目。
 */
export function pruneIndex(
  entries: readonly TitleIndexEntry[],
  maxEntries = MAX_INDEX_ENTRIES,
  perLetterFloor = 300
): TitleIndexEntry[] {
  if (entries.length <= maxEntries) return [...entries];
  const byLetter = new Map<string, TitleIndexEntry[]>();
  for (const e of entries) {
    const letter = e.initials[0] ?? '#';
    const list = byLetter.get(letter);
    if (list) list.push(e);
    else byLetter.set(letter, [e]);
  }
  const keep = new Set<TitleIndexEntry>();
  for (const list of byLetter.values()) {
    // 同样的 `slice(-0)` 陷阱：传 0 时必须什么都不留，否则整组入 keep、裁剪失效
    for (const e of perLetterFloor > 0 ? list.slice(-perLetterFloor) : []) keep.add(e);
  }
  // `remaining` 为 0 时必须跳过：`slice(-0)` 等价于 `slice(0)`，会把**整个数组**加进
  // `keep`，裁剪彻底失效（字母覆盖率一高就会踩到，`perLetterFloor × 27` 就能超过上限）。
  const remaining = Math.max(0, maxEntries - keep.size);
  if (remaining > 0) {
    for (const e of entries.slice(-remaining)) keep.add(e);
  }
  return entries.filter((e) => keep.has(e));
}

/** 归一化查询串：转小写、去掉首尾空白与空白分隔 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, '');
}

export interface SuggestOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface SuggestionGroup {
  /** 归一化后的片名 + 年份，作为去重键 */
  readonly key: string;
  readonly name: string;
  readonly initials: string;
  readonly year?: string;
  readonly typeName?: string;
  readonly area?: string;
  readonly pic?: string;
  /** 有这部片的源（≥1），点选后按这些源去搜 */
  readonly entries: TitleIndexEntry[];
}

/** 建议排序权重：完全相等 > 前缀 > 中段（越靠前分越高） */
function scoreOf(initials: string, needle: string): number {
  if (initials === needle) return 100;
  if (initials.startsWith(needle)) return 80;
  const at = initials.indexOf(needle);
  if (at > 0) return 50 - Math.min(at, 20);
  return 0;
}

/**
 * 从索引里查建议。
 *
 * 匹配语义与 `matchesPinyin` 一致（连续命中，不做跳字母），但排序更细：
 * 完全相等 > 前缀 > 中段靠前 > 中段靠后；同分时源多的优先（更可能是热门片），
 * 再短片名优先（`斗罗大陆` 比 `斗罗大陆之绝世唐门` 更像用户要找的），最后中文序稳定。
 */
export function suggestFromIndex(
  entries: readonly TitleIndexEntry[],
  query: string,
  opts: SuggestOptions = {}
): SuggestionGroup[] {
  const needle = normalizeQuery(query);
  if (needle.length < MIN_QUERY_LENGTH) return [];
  const limit = Math.max(1, opts.limit ?? MAX_SUGGESTIONS);

  const groups = new Map<string, SuggestionGroup & { score: number }>();
  for (const e of entries) {
    if (opts.signal?.aborted) break;
    const score = scoreOf(e.initials, needle);
    if (score <= 0) continue;
    const key = `${normalizeTitle(e.name)}#${e.year ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      // 同一部片跨源的重复条目：同源同 id 无需再判（索引已按它去重过）
      existing.entries.push(e);
      if (score > existing.score) existing.score = score;
      continue;
    }
    groups.set(key, {
      key,
      name: e.name,
      initials: e.initials,
      ...(e.year ? { year: e.year } : {}),
      ...(e.typeName ? { typeName: e.typeName } : {}),
      ...(e.area ? { area: e.area } : {}),
      ...(e.pic ? { pic: e.pic } : {}),
      entries: [e],
      score,
    });
  }

  const list = [...groups.values()];
  list.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const bySources = b.entries.length - a.entries.length;
    if (bySources !== 0) return bySources;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return list.slice(0, limit).map(({ score: _score, ...rest }) => ({
    ...rest,
    entries: [...rest.entries].sort((a, b) => a.sourceName.localeCompare(b.sourceName, 'zh-CN')),
  }));
}

/** 把建议组还原成可点的搜索结果条目（点选建议后直接进结果页） */
export function suggestionToItems(group: SuggestionGroup): SearchResultItem[] {
  return group.entries.map((e) => ({
    sourceKey: e.sourceKey,
    sourceName: e.sourceName,
    vodId: e.vodId,
    name: e.name,
    ...(e.pic ? { pic: e.pic } : {}),
    ...(e.typeName ? { typeName: e.typeName } : {}),
    ...(e.year ? { year: e.year } : {}),
    ...(e.area ? { area: e.area } : {}),
    ...(e.remarks ? { remarks: e.remarks } : {}),
  }));
}

/** 一个扫描任务：某个源的某几页，属于热区（覆盖）、冷区推进（追加）还是巡检（覆盖该段） */
export interface ScanTask {
  readonly source: SourceConfig;
  readonly pages: number[];
  readonly tier: 'hot' | 'deep' | 'sweep';
}

/**
 * 算出本轮该扫什么。
 *
 * 优先级（越靠前越先做，越靠前越「值得为它让用户等」）：
 * 1. **热区过期**的源先补——新片进不来最难受；
 * 2. **冷区推进**：按进度最少的源优先，让 15 个源齐头并进，字母覆盖均匀；
 * 3. **冷区巡检**：已经补满的源，按 `sweepPage` 轮转重扫一小段。
 *
 * `budgetPages` 是跨源合计的页数上限，调用方按「前台/后台」场景给不同值：
 * 后台给 `MAX_PAGES_PER_ROUND`，用户正在操作时可以传更小的值甚至只做热区。
 */
export function planScan(
  snapshot: TitleIndexSnapshot,
  sources: readonly SourceConfig[],
  opts: { budgetPages?: number; now?: number; forceHot?: boolean; tiers?: ScanTask['tier'][] } = {}
): ScanTask[] {
  const budget = Math.max(1, opts.budgetPages ?? MAX_PAGES_PER_ROUND);
  const now = opts.now ?? Date.now();
  const enabled = new Set<ScanTask['tier']>(opts.tiers ?? ['hot', 'deep', 'sweep']);
  const tasks: ScanTask[] = [];
  let left = budget;

  // 1) 热区：过期就整段重扫（页数是固定的 INDEX_HOT_PAGES）
  if (enabled.has('hot')) {
    for (const source of sources) {
      if (left <= 0) break;
      const cursor = snapshot.cursors[source.key];
      const stale = !cursor || opts.forceHot || now - cursor.hotAt >= INDEX_HOT_TTL_MS;
      if (!stale) continue;
      // 热区必须整段扫完。只扫 1~2 页却把 `hotAt` 置成「已刷新」，会让剩下几页的条目
      // 在 `applyScan` 整批替换时被清掉，而且 12 小时内不会再补——预算不够就留到下轮。
      if (left < INDEX_HOT_PAGES) break;
      const pages: number[] = [];
      for (let pg = 1; pg <= INDEX_HOT_PAGES; pg++) pages.push(pg);
      left -= pages.length;
      tasks.push({ source, pages, tier: 'hot' });
    }
  }

  // 2) 冷区推进：进度最少的源优先
  if (enabled.has('deep')) {
    const pending = sources
      .map((source) => ({ source, cursor: snapshot.cursors[source.key] }))
      .filter(({ cursor }) => !cursor?.deepDone)
      .sort((a, b) => (a.cursor?.deepPages ?? 0) - (b.cursor?.deepPages ?? 0));

    for (const { source, cursor } of pending) {
      if (left <= 0) break;
      // `deepPages` 记的是「已经扫到第几页」，下一轮从它的**下一页**开始。
      // 这里不能写成 `Math.max(INDEX_HOT_PAGES + 1, cursor.deepPages)`——那样每轮都会把
      // 上一轮的末页重扫一遍（6..25 → 25..44 → 44..60，白费两页/源/轮）。
      const start = Math.max(INDEX_HOT_PAGES + 1, (cursor?.deepPages ?? INDEX_HOT_PAGES) + 1);
      const end = Math.min(
        start + INDEX_DEEP_STEP_PAGES - 1,
        INDEX_DEEP_TARGET_PAGES,
        start + left - 1
      );
      if (end < start) continue;
      const pages: number[] = [];
      for (let pg = start; pg <= end; pg++) pages.push(pg);
      left -= pages.length;
      tasks.push({ source, pages, tier: 'deep' });
    }
  }

  // 3) 冷区巡检：已补满且到期的源，按游标取一小段重扫
  if (enabled.has('sweep')) {
    const due = sources
      .map((source) => ({ source, cursor: snapshot.cursors[source.key] }))
      .filter(({ cursor }) => Boolean(cursor?.deepDone))
      .filter(({ cursor }) => now - (cursor!.sweepAt ?? 0) >= INDEX_SWEEP_INTERVAL_MS)
      .sort((a, b) => (a.cursor?.sweepAt ?? 0) - (b.cursor?.sweepAt ?? 0));

    for (const { source, cursor } of due) {
      if (left <= 0) break;
      const span = INDEX_DEEP_TARGET_PAGES - INDEX_HOT_PAGES;
      let start = cursor?.sweepPage ?? INDEX_HOT_PAGES + 1;
      // 游标越界（源变浅了）就从头来
      if (start < INDEX_HOT_PAGES + 1 || start > INDEX_DEEP_TARGET_PAGES) start = INDEX_HOT_PAGES + 1;
      const pages: number[] = [];
      for (let i = 0; i < INDEX_SWEEP_PAGES && pages.length < left; i++) {
        const pg = INDEX_HOT_PAGES + 1 + (((start - INDEX_HOT_PAGES - 1 + i) % span) + span) % span;
        if (!pages.includes(pg)) pages.push(pg);
      }
      if (pages.length === 0) continue;
      left -= pages.length;
      tasks.push({ source, pages, tier: 'sweep' });
    }
  }

  return tasks;
}

/**
 * 后台扫描计划：只做「不紧急」的那部分，且页数上限压得更低。
 *
 * 与 `planScan` 的区别是**永远不带 `forceHot`**、并且当热区已经新鲜时不重扫热区——
 * 后台跑的意义是慢慢把索引补全，不是跟用户抢带宽去刷新刚刷过的东西。
 */
export function planBackgroundScan(
  snapshot: TitleIndexSnapshot,
  sources: readonly SourceConfig[],
  opts: { budgetPages?: number; now?: number } = {}
): ScanTask[] {
  return planScan(snapshot, sources, {
    budgetPages: opts.budgetPages ?? MAX_PAGES_PER_ROUND,
    now: opts.now,
    tiers: ['hot', 'deep', 'sweep'],
  });
}

export interface TaskResult {
  readonly sourceKey: string;
  readonly tier: 'hot' | 'deep' | 'sweep';
  readonly pages: number[];
  readonly entries: TitleIndexEntry[];
}

export interface ScanResult {
  readonly results: TaskResult[];
  /** 本轮实际发出去的页数 */
  readonly pages: number;
  readonly failures: { sourceKey: string; page: number; error: string }[];
}

export interface ScanOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 每抓到一页回调一次，供 UI 增量渲染 */
  onPage?: (sourceKey: string, page: number, entries: TitleIndexEntry[]) => void;
}

/**
 * 执行扫描任务。
 *
 * 只发 `?ac=videolist&pg=n`（不带 `t`）。实测 14 个内置源都支持，20 条/页、每条都带
 * `vod_name`（见 `.tmp-pool/latest-matrix.ts`）。
 *
 * 单个源某一页失败就停在这个源上（游标只推进到失败页之前），下轮自然重试；
 * 其它源不受影响。
 */
export async function runScan(
  tasks: readonly ScanTask[],
  http: HttpClient,
  opts: ScanOptions = {}
): Promise<ScanResult> {
  const results: TaskResult[] = [];
  const failures: { sourceKey: string; page: number; error: string }[] = [];
  let pages = 0;

  for (const task of tasks) {
    if (opts.signal?.aborted) break;
    const base = task.source.url.replace(/\/+$/, '');
    const got: TitleIndexEntry[] = [];
    const done: number[] = [];
    for (const page of task.pages) {
      if (opts.signal?.aborted) break;
      try {
        const res = await catalogLimiter(() =>
          sourceLimiter(base)(() =>
            http.request(cmsUrl(base, { ac: 'videolist', pg: page }), {
              headers: cmsRequestHeaders(),
              timeoutMs: opts.timeoutMs ?? 12_000,
              signal: opts.signal,
            })
          )
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = JSON.parse(res.text);
        const items = parseSearchList(data, task.source);
        const entries = items.map(toIndexEntry).filter((e): e is TitleIndexEntry => e !== null);
        got.push(...entries);
        done.push(page);
        pages++;
        opts.onPage?.(task.source.key, page, entries);
        // 空页说明到底了，不必再把剩下的页打完
        if (items.length === 0) break;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') break;
        failures.push({
          sourceKey: task.source.key,
          page,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    if (done.length > 0) {
      results.push({ sourceKey: task.source.key, tier: task.tier, pages: done, entries: got });
    }
  }

  return { results, pages, failures };
}

/**
 * 把扫描结果写回快照。
 *
 * - 热区：**整段扫完才整批替换**该源的旧热区条目（窗口是滑动的，旧的第 1 页已经不是最新了）；
 *   只扫了一部分（某页失败）时改成合并，并且不刷新 `hotAt`，下一轮继续重试；
 * - 冷区推进：**增量追加**（深页内容基本不变，追加即可）；
 * - 冷区巡检：**合并刷新**——巡到的条目会更新，但已下架的片**不会**被删掉。
 *   这是当前实现的已知局限，不是笔误：索引条目里没有记页码，删的时候无法判断
 *   「这条来自我刚巡的那几页」还是「来自别的页」，误删就会把索引打薄。
 *   索引只用来出建议（点下去还会走真实搜索），留一条下架片最多是建议里多一行。
 */
export function applyScan(
  snapshot: TitleIndexSnapshot,
  scan: ScanResult,
  now = Date.now()
): TitleIndexSnapshot {
  if (scan.results.length === 0) return snapshot;
  const cursors: Record<string, IndexCursor> = { ...snapshot.cursors };
  let hot = [...snapshot.hot];
  let deep = [...snapshot.deep];

  for (const result of scan.results) {
    const cursor = cursors[result.sourceKey] ?? { hotAt: 0, deepPages: INDEX_HOT_PAGES, deepDone: false };
    if (result.tier === 'hot') {
      // 只有整段扫完才算「热区已刷新」。中途某页失败时**不能**整批替换：那会把失败页
      // 对应的旧条目清掉，同时把 `hotAt` 推到 12 小时后，等于把一次网络抖动放大成
      // 「丢一批条目 + 12 小时不重试」。所以部分成功改成合并，并保持原来的 `hotAt`。
      const complete = result.pages.length >= INDEX_HOT_PAGES;
      hot = complete
        ? mergeEntries(
            hot.filter((e) => e.sourceKey !== result.sourceKey),
            result.entries
          )
        : mergeEntries(hot, result.entries);
      const hotAt = complete ? now : cursor.hotAt;
      const deepPages = result.pages.some((p) => p >= INDEX_HOT_PAGES)
        ? Math.max(cursor.deepPages, INDEX_HOT_PAGES)
        : cursor.deepPages;
      cursors[result.sourceKey] = { ...cursor, hotAt, deepPages };
      continue;
    }
    deep = mergeEntries(deep, result.entries);

    if (result.tier === 'sweep') {
      // 巡检：只推进游标，不动 deepDone（它是「补齐」状态，不是「巡检」状态）
      const span = INDEX_DEEP_TARGET_PAGES - INDEX_HOT_PAGES;
      // `pages` 为空时 Math.max() 得 -Infinity，游标会写成 NaN；而越界检查
      // 对 NaN 的两个比较都是 false，NaN 会一路传到 `pg=NaN`。这里守住。
      if (result.pages.length === 0) continue;
      const last = Math.max(...result.pages);
      const next = INDEX_HOT_PAGES + 1 + (((last - INDEX_HOT_PAGES) % span) + span) % span;
      cursors[result.sourceKey] = { ...cursor, sweepPage: next, sweepAt: now };
      continue;
    }

    const reached = Math.max(cursor.deepPages, ...result.pages);
    cursors[result.sourceKey] = {
      ...cursor,
      deepPages: reached,
      deepDone: reached >= INDEX_DEEP_TARGET_PAGES,
    };
  }

  // 热区先进、冷区在后：`pruneIndex` 的「留最新」按数组尾部算，冷区是老片，
  // 超出上限时应该先丢它们，所以把冷区放在前面、热区放在后面。
  //
  // 但**去重要按「热区优先」**：`dedupeEntries` 保留首次出现的那份，而热区刚扫到的
  // 条目带着最新的 `pic`/`remarks`，冷区那份可能是几周前的。先把热区合并进去，
  // 让同键条目以热区版本为准。
  const merged = pruneIndex(mergeEntries([...deep, ...hot], hot));
  // 拆回去：按 `hot` 的键集合判定归属。
  //
  // 这里必须再 `dedupeEntries` 一次：源站分页会随新片上线漂移，上周还在第 20 页的条目
  // 这周可能滑到第 3 页，于是同一个 `sourceKey:vodId` 会**同时**存在于 hot 和 deep 里。
  // 两份都会被判成 hot，不去重的话 `hot` 里就留下两条同键条目，`suggestFromIndex`
  // 会把它们塞进同一个建议组两次，UI 上的「N 源」被虚报、点进去还会重复请求。
  const hotKeys = new Set(hot.map((e) => `${e.sourceKey}:${e.vodId}`));
  return {
    signature: snapshot.signature,
    hot: dedupeEntries(merged.filter((e) => hotKeys.has(`${e.sourceKey}:${e.vodId}`))),
    deep: merged.filter((e) => !hotKeys.has(`${e.sourceKey}:${e.vodId}`)),
    cursors,
  };
}

/* ------------------------------------------------------------------------- *
 * 远端拼音检索（补本地索引装不下的历史老片）
 * ------------------------------------------------------------------------- */

/**
 * 支持「`wd` 传拼音首字母」的源（按 URL 片段识别，换了域名也能认出来）。
 *
 * 2026-11 实测（`.tmp-pool/pinyin-search-cover.ts`，8 部老片 × 全拼/首字母两轮）：
 * - `量子资源` 4/8、`暴风资源` 5/8；
 * - 其余 12 个源 **0/8**——它们把 `wd=dldl` 当成英文关键词，返回的全是不相干条目
 *   （`wd=dl` 在百度资源返回 `DeadlySecret`，在 360 资源返回 `KING OF PRIS`）。
 *
 * 判据是「传首字母能召回中文片名」而不是「有返回」，所以这里只登记确认过的两个，
 * 不要凭源名猜。加新源前先用 `pinyin-search-cover.ts` 跑一遍。
 */
export const REMOTE_PINYIN_SOURCES: readonly { name: string; match: string }[] = [
  { name: '量子资源', match: 'lziapi.com' },
  { name: '暴风资源', match: 'bfzyapi.com' },
];

/** 当前启用的源里，哪些支持远端拼音检索 */
export function remotePinyinSources(sources: readonly SourceConfig[]): SourceConfig[] {
  return sources.filter((s) => REMOTE_PINYIN_SOURCES.some((r) => s.url.includes(r.match)));
}

export interface RemotePinyinOptions {
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 每个源翻到第几页为止（默认 1：拼音检索的命中都很集中在首页） */
  maxPages?: number;
}

/**
 * 向支持拼音检索的源发一次 `wd=<首字母>`，把结果转成索引条目。
 *
 * 只在**本地索引给不出足够建议**时调用（见 `SearchScreen`），所以可以容忍慢一点；
 * 但仍然要设超时——用户可能一边输入一边触发，不能把请求堆起来。
 *
 * 注意：这些源对拼音 `wd` 的处理是「前缀 + 全拼混合」，返回里会混进不相干条目
 * （`wd=dl` 带出「两个人的车站」）。**这里不做过滤**，交由调用方用
 * `pinyinInitials(name)` 二次校验，避免把「量子资源把 dl 当关键词」的行为差异
 * 硬编码进 core。
 */
export async function remotePinyinSearch(
  query: string,
  sources: readonly SourceConfig[],
  http: HttpClient,
  opts: RemotePinyinOptions = {}
): Promise<TitleIndexEntry[]> {
  const needle = normalizeQuery(query);
  if (needle.length < MIN_QUERY_LENGTH) return [];
  // 首字母串只能是 ASCII 字母/数字。传中文（例如点「最近搜索」里的片名）进来时，
  // 下面的 `entry.initials.includes(needle)` 必然为假，白跑两个源的请求，直接跳过。
  if (!/^[a-z0-9]+$/.test(needle)) return [];
  const targets = remotePinyinSources(sources);
  if (targets.length === 0) return [];

  const maxPages = Math.max(1, opts.maxPages ?? 1);
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const out: TitleIndexEntry[] = [];

  await Promise.all(
    targets.map(async (source) => {
      const base = source.url.replace(/\/+$/, '');
      for (let page = 1; page <= maxPages; page++) {
        if (opts.signal?.aborted) return;
        try {
          const res = await catalogLimiter(() =>
            sourceLimiter(base)(() =>
              http.request(cmsUrl(base, { ac: 'videolist', wd: needle, pg: page }), {
                headers: cmsRequestHeaders(),
                timeoutMs,
                signal: opts.signal,
              })
            )
          );
          if (!res.ok) return;
          const items = parseSearchList(JSON.parse(res.text) as unknown, source);
          if (items.length === 0) return;
          for (const item of items) {
            const entry = toIndexEntry(item);
            // 二次校验：片名首字母真的包含查询串才收（过滤「量子把 dl 当关键词」的噪声）
            if (!entry || !entry.initials.includes(needle)) continue;
            out.push(entry);
            if (opts.limit !== undefined && out.length >= opts.limit) return;
          }
        } catch {
          // 单个源失败不影响另一个源；远端补漏本来就是尽力而为
          return;
        }
      }
    })
  );

  // 两个源同时返回同一部片是常态（量子与暴风同库），所以这里统一去重
  const unique = dedupeEntries(out);
  return opts.limit !== undefined ? unique.slice(0, opts.limit) : unique;
}

/**
 * 远端拼音检索后按 `sourceKey:vodId` 去重。
 *
 * 两个源同时返回同一部片是常态（量子与暴风同库），去重键必须带 sourceKey：
 * 同名不同源要各留一条，用户点进详情时才有「换源重试」的余地。
 */
export function dedupeEntries(entries: readonly TitleIndexEntry[]): TitleIndexEntry[] {
  const seen = new Set<string>();
  const out: TitleIndexEntry[] = [];
  for (const e of entries) {
    const key = `${e.sourceKey}:${e.vodId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
