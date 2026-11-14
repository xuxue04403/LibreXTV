/**
 * 首页分类入口：从采集站的 `?ac=list` 接口读取分类表，映射到统一分类桶后按类型浏览。
 *
 * Apple CMS 的 type_id 各家不同（有的把「动作片」当顶级分类，有的挂在「电影」下），
 * 所以不能写死 1=电影。这里以「分类名 → 统一桶」的方式建立映射，再回查该源自己的 type_id。
 */

import { cmsRequestHeaders, filterAdultResults, parseSearchList } from './cms';
import { HttpError, type HttpClient } from './http';
import { catalogLimiter, sourceLimiter } from './limiter';
import type { SearchResultItem, SourceConfig } from './types';
export type CategoryKey = 'movie' | 'tv' | 'variety' | 'anime' | 'kids' | 'doc' | 'short' | 'sports' | 'other';

export interface CategoryBucket {
  key: CategoryKey;
  label: string;
  /** 名称命中这些关键词即归入该桶（按顺序判定，越靠前越先匹配） */
  keywords: string[];
}

/**
 * 顺序很重要：判定按数组顺序短路。
 * 「少儿动画」「纪录电影」这类带修饰的名字必须先命中专属桶，否则会被通用的「片」抢走。
 */
export const CATEGORY_BUCKETS: CategoryBucket[] = [
  { key: 'kids', label: '少儿', keywords: ['少儿', '儿童', '亲子', '益智', '儿歌'] },
  { key: 'doc', label: '纪录片', keywords: ['纪录片', '记录片', '纪实', '纪录'] },
  { key: 'anime', label: '动漫', keywords: ['动漫', '动画', '番剧', '国漫', '日漫'] },
  { key: 'variety', label: '综艺', keywords: ['综艺', '真人秀', '脱口秀', '选秀', '晚会'] },
  {
    key: 'short',
    label: '短剧',
    // 后半段是采集站给短剧起的**题材名**。红牛/百度把它们摆成独立顶级分类，
    // 没有父分类可继承，只能正面列出来（实测红牛「古装仙侠」等 6 个各有 20 条，
    // 分集中位数都是 1，确认是单集短剧）。
    keywords: [
      '短剧', '微短剧', '竖屏剧', '爽文短剧',
      '古装仙侠', '现代都市', '穿越年代', '年代穿越', '言情总裁', '重生民国',
      '反转爽剧', '脑洞悬疑', 'AI漫剧', '女频恋爱', '成长逆袭',
    ],
  },
  {
    key: 'tv',
    label: '电视剧',
    // 「香港剧」「台湾剧」这类按地区拆的子分类是真实采集站的标准做法
    // （电影天堂/百度/红牛 都把它们作为**独立分类**给出来）。
    // 原词表只有「港台剧」「日韩剧」这种聚合名，于是这些分类既进不了电视剧桶、
    // 也不会被展示 —— 电视剧分类页会少掉一大块内容。
    // 同一批名字若挂在「连续剧」父分类下，也会被【父级继承】兜住，见 bucketOf()。
    keywords: [
      '电视剧', '连续剧', '剧集', '国产剧', '港台剧', '日韩剧', '欧美剧', '海外剧',
      '泰剧', '美剧', '韩剧', '日剧',
      '香港剧', '台湾剧', '韩国剧', '日本剧', '泰国剧', '港澳剧', '大陆剧', '内地剧', '其他剧',
    ],
  },
  {
    key: 'sports',
    label: '体育',
    // 「台球」「斯诺克」「NBA」在采集站里是独立的赛事分类，
    // 名字里没有「体育/赛事」，不加就只能归入 other 而不被展示。
    keywords: ['体育', '赛事', '足球', '篮球', '台球', '网球', '斯诺克', 'NBA'],
  },
  { key: 'movie', label: '电影', keywords: ['电影', '片'] },
  { key: 'other', label: '其他', keywords: [] },
];

/**
 * 首页分类入口的**展示顺序**，与上面的判定顺序解耦。
 *
 * 判定顺序（CATEGORY_BUCKETS）必须让专属桶优先，否则「少儿动画」会被「动漫」抢走；
 * 但用户最先想看的是电影和电视剧，所以展示顺序单独定义。
 */
export const HOME_CATEGORY_ORDER: CategoryKey[] = [
  'movie',
  'tv',
  'kids',
  'variety',
  'anime',
  'doc',
  'short',
  'sports',
];

/** 首页分类入口（按展示顺序，去掉「其他」） */
export const HOME_CATEGORIES: CategoryBucket[] = HOME_CATEGORY_ORDER.map(
  (key) => CATEGORY_BUCKETS.find((bucket) => bucket.key === key)
).filter((bucket): bucket is CategoryBucket => Boolean(bucket));

/** 采集站的一条分类 */
export interface SourceCategory {
  id: string;
  name: string;
  /** 父分类 id，'0' / 空表示顶级 */
  parentId?: string;
}

/** 名称 → 分类桶（未命中返回 'other'） */
export function classifyCategoryName(name: string): CategoryKey {
  const text = (name || '').trim();
  if (!text) return 'other';
  for (const bucket of CATEGORY_BUCKETS) {
    if (bucket.key === 'other') continue;
    if (bucket.keywords.some((keyword) => text.includes(keyword))) return bucket.key;
  }
  return 'other';
}

/** 分类桶的展示名 */
export function categoryLabel(key: CategoryKey): string {
  return CATEGORY_BUCKETS.find((bucket) => bucket.key === key)?.label ?? '其他';
}

/**
 * 名字本身判不出桶时，**不允许**靠父分类继承的垃圾分类。
 *
 * 「未分类」「其他」这类桶装的是采集站自己也没归好类的东西，
 * 跟着父分类混进「电影」只会让分类页混进杂项。
 */
const BUCKET_INHERIT_BLOCKLIST = /^(未分类|其他|其它|预告片|花絮|待定)$/;

/**
 * 判定一个分类属于哪个桶，必要时**继承父分类**。
 *
 * 实测依据（2026-10，6 个采集源）：采集站普遍把题材当子分类挂在「短剧」「体育」下面，
 * 名字里完全不含父级关键词——
 *   极速/红牛：「古装仙侠 / 现代都市 / 穿越年代 / 言情总裁 / 重生民国 / 反转爽剧 /
 *              脑洞悬疑 / AI漫剧」挂在「短剧」下，「台球」挂在「体育赛事」下；
 *   电影天堂/如意：「香港剧 / 台湾剧 / 日本剧 / 泰国剧」挂在「连续剧」下。
 * 只按名字判桶，这些分类会全部落到 other 而不被展示，「电视剧」「短剧」桶里
 * 也就只剩父分类自己那一条（而父分类不聚合子分类，等于空）。
 */
export function bucketOf(
  category: SourceCategory,
  byId: ReadonlyMap<string, SourceCategory>
): CategoryKey {
  const own = classifyCategoryName(category.name);
  if (own !== 'other') return own;
  if (BUCKET_INHERIT_BLOCKLIST.test(category.name.trim())) return 'other';
  // 逐级往上找，避免采集站给了三层分类；seen 防环
  const seen = new Set<string>();
  let parentId = category.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const key = classifyCategoryName(parent.name);
    if (key !== 'other') return key;
    parentId = parent.parentId;
  }
  return 'other';
}

/** 解析 `?ac=list` 响应里的分类表（字段名在各类采集站间有差异，做宽容处理） */
export function parseSourceCategories(data: unknown): SourceCategory[] {
  if (!data || typeof data !== 'object') return [];
  const raw = (data as { class?: unknown; classes?: unknown }).class ?? (data as { classes?: unknown }).classes;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SourceCategory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawId = record.type_id ?? record.typeId ?? record.id;
    const id = rawId === undefined || rawId === null ? '' : String(rawId).trim();
    const name = String(record.type_name ?? record.typeName ?? record.name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const rawParent = record.type_pid ?? record.typePid ?? record.parent_id ?? record.parentId;
    const parentId = rawParent === undefined || rawParent === null ? undefined : String(rawParent).trim();
    out.push({ id, name, parentId: parentId && parentId !== '0' ? parentId : undefined });
  }
  return out;
}

/** 在分类表里找某个桶对应的 type_id；优先顶级分类，其次 id 小的（通常是主分类） */
export function matchTypeId(categories: SourceCategory[], key: CategoryKey): string | undefined {
  return matchTypeIds(categories, key, 1)[0];
}

/**
 * 找出某个桶对应的全部 type_id。
 *
 * 关键：Apple CMS 的父分类**不聚合**子分类内容——`?t=1`（电影片）只返回 type_id 恰好
 * 为 1 的条目，动作片/喜剧片是独立 type_id。因此要优先取「叶子分类」，
 * 只有没有子分类时才回退到父分类本身，否则分类页会几乎空白。
 */
export function matchTypeIds(categories: SourceCategory[], key: CategoryKey, limit = 6): string[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const matched = categories.filter((category) => bucketOf(category, byId) === key);
  if (matched.length === 0) return [];

  const childCount = new Map<string, number>();
  for (const category of categories) {
    if (!category.parentId) continue;
    childCount.set(category.parentId, (childCount.get(category.parentId) ?? 0) + 1);
  }

  const numeric = (id: string) => {
    const n = Number(id);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };

  const leaves = matched.filter((category) => !childCount.has(category.id));
  const parents = matched.filter((category) => childCount.has(category.id));

  const ordered = [
    ...leaves.sort((a, b) => numeric(a.id) - numeric(b.id)),
    // 父分类只在没有可用叶子时兜底（例如只给了「电影」一个顶级分类的源）
    ...parents.filter((parent) => !matched.some((m) => m.parentId === parent.id)).sort((a, b) => numeric(a.id) - numeric(b.id)),
  ];

  return ordered.slice(0, Math.max(1, limit)).map((category) => category.id);
}

export interface CategoryFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 读取某源的分类表：`?ac=list` 会带回 class 数组 */
export async function fetchSourceCategories(
  source: SourceConfig,
  http: HttpClient,
  opts: CategoryFetchOptions = {}
): Promise<SourceCategory[]> {
  const base = source.url.replace(/\/+$/, '');
  const url = `${base}?ac=list&pg=1`;
  const res = await catalogLimiter(() =>
    http.request(url, {
      headers: cmsRequestHeaders(),
      timeoutMs: opts.timeoutMs ?? 10_000,
      signal: opts.signal,
    })
  );
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new HttpError('返回内容不是合法 JSON', res.status);
  }
  return parseSourceCategories(data);
}

export interface CategoryBrowsePage {
  items: SearchResultItem[];
  /** 源站总页数（供 UI 判断是否还能加载更多） */
  pageCount: number;
}

/** 按类型浏览某源的一页内容 */
export async function browseSourceCategory(
  source: SourceConfig,
  typeId: string,
  page: number,
  http: HttpClient,
  opts: CategoryFetchOptions = {}
): Promise<CategoryBrowsePage> {
  const base = source.url.replace(/\/+$/, '');
  const url = `${base}?ac=videolist&t=${encodeURIComponent(typeId)}&pg=${Math.max(1, page)}`;
  const res = await catalogLimiter(() =>
    sourceLimiter(base)(() =>
      http.request(url, {
        headers: cmsRequestHeaders(),
        timeoutMs: opts.timeoutMs ?? 12_000,
        signal: opts.signal,
      })
    )
  );
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new HttpError('返回内容不是合法 JSON', res.status);
  }
  const items = parseSearchList(data, source);
  const rawCount = parseInt(String((data as { pagecount?: unknown }).pagecount ?? '1'), 10);
  const pageCount = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1;
  return { items, pageCount };
}

/** 分类表缓存：分类不常变，按源地址缓存 6 小时，避免每次切分类都打上游 */
const categoryCache = new Map<string, { at: number; categories: SourceCategory[] }>();
const CATEGORY_TTL_MS = 6 * 60 * 60 * 1000;

export function getCachedCategories(url: string): SourceCategory[] | undefined {
  const hit = categoryCache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CATEGORY_TTL_MS) {
    categoryCache.delete(url);
    return undefined;
  }
  return hit.categories;
}

export function setCachedCategories(url: string, categories: SourceCategory[]): void {
  categoryCache.set(url, { at: Date.now(), categories });
}

export function clearCategoryCache(): void {
  categoryCache.clear();
  browseCache.clear();
}

export interface CategorySourceOutcome {
  sourceKey: string;
  sourceName: string;
  ok: boolean;
  /** 该源是否有这个分类（没有时 UI 显示「该源无此分类」而非失败） */
  supported: boolean;
  count: number;
  error?: string;
  timedOut?: boolean;
  ms: number;
}

export interface CategoryBrowseResult {
  items: SearchResultItem[];
  outcomes: CategorySourceOutcome[];
  /** 命中该分类的源数量 */
  supportedSources: number;
}

export interface CategoryBrowseOptions {
  sources: SourceConfig[];
  key: CategoryKey;
  http: HttpClient;
  /** 每个源抓取的页数（默认 1） */
  pages?: number;
  /**
   * 从第几页开始抓（默认 1）。
   *
   * 「加载更多」必须配合 `pages: 1, startPage: n` 使用：只调大 `pages`
   * 会让每次翻页都把前面所有页重下一遍（第 8 页 = 8 倍请求）。
   */
  startPage?: number;
  /** 单源最多并行抓取的子分类数（默认 4） */
  typeLimit?: number;
  /** 是否过滤成人分类内容（默认 true，与搜索保持一致） */
  filterAdult?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 每完成一个源就回调一次（不是全部完成后才回调，UI 可以边收边渲染） */
  onSource?: (outcome: CategorySourceOutcome) => void;
  /**
   * 增量结果回调：只要有新内容就带着「目前为止的全部条目」回调一次。
   *
   * 这是分类页首屏速度的关键：4 个源 × 4 个子分类 = 16 个请求，
   * 等全部回来要 3~6 秒，而第一个源通常在 1 秒内就有内容。
   * 回调里拿到的是已经合并、去重、过滤过的完整快照，UI 直接整体替换即可，
   * 不需要自己做增量合并（那正是最容易出错的地方）。
   */
  onPartial?: (items: SearchResultItem[], outcomes: CategorySourceOutcome[]) => void;
  /**
   * 整轮浏览的墙钟预算（毫秒，默认 15 秒）。
   *
   * 没有预算时最坏耗时是「所有源的超时之和」：13 个源里只要有两个在限流，
   * 光它们的 4 个子分类 × 12 秒就能把一次分类浏览拖到一分钟（实测
   * 44.6 秒，其中 4 个源各自贡献 20~44 秒）。有了预算，到点就带着已经
   * 收到的内容返回，没答复的源标记为超时——首屏有内容可看，尾部慢源
   * 不再拖住整个页面。
   */
  budgetMs?: number;
}

/**
 * 正在进行的分类表请求。
 *
 * `probeCategories` 会为 8 个首页分类各调一次 `browseCategory`，8 次都会经过
 * `categoriesOf`。缓存只在**响应回来之后**才写入，所以这 8 次并发调用会同时
 * 命中「无缓存」分支，把同一个 `?ac=list` 打 8 遍——13 个源就是 104 个重复请求，
 * 全部挤在并发闸门里，这正是「首页一进来就卡、分类浏览跟着变慢」的主因。
 *
 * 这里把「进行中的请求」也当成缓存：同一地址在途时后来者直接 await 同一个
 * promise。失败时立刻删掉，下一次调用可以正常重试。
 */
const inflightCategories = new Map<string, Promise<SourceCategory[]>>();

/** 取某源的分类表（带 6 小时缓存 + 在途去重） */
async function categoriesOf(
  source: SourceConfig,
  http: HttpClient,
  opts: CategoryFetchOptions
): Promise<SourceCategory[]> {
  const cached = getCachedCategories(source.url);
  if (cached) return cached;

  const inflight = inflightCategories.get(source.url);
  if (inflight) return inflight;

  const promise = fetchSourceCategories(source, http, opts)
    .then((categories) => {
      setCachedCategories(source.url, categories);
      return categories;
    })
    .finally(() => {
      // 无论成败都要摘掉：成功时已有缓存接管，失败时留给下一次重试的机会
      if (inflightCategories.get(source.url) === promise) inflightCategories.delete(source.url);
    });
  inflightCategories.set(source.url, promise);
  return promise;
}

/**
 * 按分类聚合浏览：每个源先查自己的分类表，找到该分类（及其子分类）的 type_id 再拉内容。
 * 某个源没有这个分类属于正常情况，不计入失败。
 */
export async function browseCategory(opts: CategoryBrowseOptions): Promise<CategoryBrowseResult> {
  const pages = Math.min(20, Math.max(1, opts.pages ?? 1));
  const startPage = Math.min(500, Math.max(1, opts.startPage ?? 1));
  // 4 而不是 6：实测 typeLimit=6 时 4 源共 24 个请求，被全局闸门（6）排成 4 轮，
  // 耗时 6.6 秒；降到 4 只需 16 个请求、3 轮，3.8 秒拿到 300 部（对照 459 部）。
  // 首屏本来也看不完 459 部，少抓两个子分类换来近 3 秒的体感提升是划算的。
  const typeLimit = Math.min(20, Math.max(1, opts.typeLimit ?? 4));
  const filterAdult = opts.filterAdult ?? true;
  const timeoutMs = opts.timeoutMs ?? 12_000;

  // 只缓存第一页：翻页是有意为之的追加动作，缓存住反而看不到新内容。
  // 用户反馈「切回上一个分类还要重新拉一遍各源」——分类之间来回切换是最常见的操作，
  // 每次都打 4 个源 × 6 个子分类，体感就是「每次都在重新加载播放源」。
  const cacheKey =
    pages === 1 && startPage === 1
      ? `${opts.key}|${filterAdult ? 1 : 0}|${typeLimit}|${opts.sources
          .map((s) => s.url)
          .sort()
          .join(',')}`
      : '';
  if (cacheKey) {
    const hit = browseCache.get(cacheKey);
    // 返回副本：调用方（各页面）会原地 push/sort 自己那份数组，直接给缓存引用会被改坏。
    const ttl = hit?.partial ? BROWSE_PARTIAL_TTL_MS : BROWSE_TTL_MS;
    if (hit && Date.now() - hit.at < ttl) {
      return { ...hit.result, items: [...hit.result.items], outcomes: [...hit.result.outcomes] };
    }
  }

  interface SourceCollected {
    outcome: CategorySourceOutcome;
    items: SearchResultItem[];
  }

  // 同一地址被配了多条（老版本重复注入内置源、用户手抄了两遍）时只打一次上游：
  // 否则并发直接翻倍，采集站会以 503 回敬，表现为「所有源都失败」。
  const uniqueSources: SourceConfig[] = [];
  const seenUrls = new Set<string>();
  const duplicated: SourceCollected[] = [];
  for (const source of opts.sources) {
    if (seenUrls.has(source.url)) {
      const first = uniqueSources.find((s) => s.url === source.url);
      duplicated.push({
        outcome: {
          sourceKey: source.key,
          sourceName: source.name,
          ok: true,
          supported: false,
          count: 0,
          error: `与「${first?.name ?? '同一地址'}」重复，已跳过`,
          ms: 0,
        },
        items: [],
      });
      continue;
    }
    seenUrls.add(source.url);
    uniqueSources.push(source);
  }

  // 已完成的源，按完成顺序累积；每完成一个就回调一次 onPartial
  const done: SourceCollected[] = [...duplicated];
  const emitPartial = () => {
    if (!opts.onPartial || opts.signal?.aborted) return;
    // 与最终结果同样口径：合并、去重、成人过滤
    const partialItems: SearchResultItem[] = [];
    const seenIds = new Set<string>();
    for (const entry of done) {
      for (const item of entry.items) {
        const id = `${item.sourceKey}:${item.vodId}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        partialItems.push(item);
      }
    }
    try {
      opts.onPartial(partialItems, done.map((entry) => entry.outcome));
    } catch {
      /* 回调异常不影响整体 */
    }
  };

  const budgetMs = Math.max(1_000, opts.budgetMs ?? DEFAULT_BROWSE_BUDGET_MS);
  const startedAt = Date.now();

  // 内层控制器：到预算点就把还挂着的请求取消掉。不取消的话它们会继续占着
  // 并发闸门，用户紧接着点下一个分类时才发现「闸门里全是上一轮的僵尸请求」。
  const inner = new AbortController();
  const relayAbort = () => inner.abort();
  if (opts.signal) {
    if (opts.signal.aborted) inner.abort();
    else opts.signal.addEventListener('abort', relayAbort, { once: true });
  }
  const signal = inner.signal;

  /**
   * 结果按「源对象身份」记账，而不是按下标：超时返回时下标可能残缺，
   * 而 sourceKey 又可能被用户导入的源撞上（见上面的注释），对象身份是唯一安全的键。
   */
  const results = new Map<SourceConfig, SourceCollected>();
  const record = (source: SourceConfig, entry: SourceCollected): SourceCollected => {
    results.set(source, entry);
    done.push(entry);
    emitPartial();
    return entry;
  };

  const work = Promise.all(
    uniqueSources.map(async (source): Promise<void> => {
      const started = Date.now();
      const finish = (
        outcome: Omit<CategorySourceOutcome, 'ms' | 'sourceKey' | 'sourceName'>,
        items: SearchResultItem[] = []
      ): SourceCollected => ({
        outcome: {
          sourceKey: source.key,
          sourceName: source.name,
          ms: Date.now() - started,
          ...outcome,
        },
        items,
      });

      try {
        const categories = await categoriesOf(source, opts.http, { timeoutMs, signal });
        const typeIds = matchTypeIds(categories, opts.key, typeLimit);
        if (typeIds.length === 0) {
          record(source, finish({ ok: true, supported: false, count: 0 }));
          return;
        }

        // 子分类并行抓取：父分类不聚合子分类，只抓父级会几乎空白
        const batches = await Promise.all(
          typeIds.map(async (typeId) => {
            const list: SearchResultItem[] = [];
            for (let page = startPage; page < startPage + pages; page++) {
              const result = await browseSourceCategory(source, typeId, page, opts.http, {
                timeoutMs,
                signal,
              });
              list.push(...result.items);
              if (page >= result.pageCount) break;
            }
            return list;
          })
        );

        // 「伦理片」这类名字带「片」，会被归档到电影桶，因此必须在分类浏览里也做成人过滤
        const list = filterAdultResults(batches.flat(), filterAdult);
        record(source, finish({ ok: true, supported: true, count: list.length }, list));
      } catch (err) {
        // 已经超时返回之后才 reject 的那些源不必再记一笔（结果集已定），
        // 但记下来也无害——record 是幂等的按源覆盖。
        if (results.has(source)) return;
        const timedOut = err instanceof HttpError && err.status === 408;
        record(
          source,
          finish({
            ok: false,
            supported: false,
            count: 0,
            error: err instanceof Error ? err.message : '失败',
            timedOut,
          })
        );
      }
    })
  );

  // 到点就放手：宁可少两个源的内容，也不让一次分类浏览卡到一分钟。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  const settled = await Promise.race([work.then(() => 'all' as const), deadline]);
  if (timer) clearTimeout(timer);
  const expired = settled === 'timeout';
  if (expired) {
    inner.abort();
    // 让已经 reject 的几个 catch 先跑完，结果更贴近真实（失败原因比「未完成」有用）
    await Promise.resolve();
  }
  opts.signal?.removeEventListener('abort', relayAbort);

  // `done` 是「完成顺序」，最终结果仍按源声明顺序排列，保证列表顺序稳定。
  // 用下标而不是 sourceKey 回查：sourceKey 理论上唯一，但用户导入的源可能撞 key，
  // 一旦撞上按 key 回查就会把多个源折叠成一条，丢内容且很难查。
  const collected: SourceCollected[] = [
    ...uniqueSources.map((source): SourceCollected => {
      const hit = results.get(source);
      if (hit) return hit;
      return {
        outcome: {
          sourceKey: source.key,
          sourceName: source.name,
          ok: false,
          supported: false,
          count: 0,
          error: `超出 ${Math.round(budgetMs / 1000)} 秒总时限，已跳过`,
          timedOut: true,
          ms: Date.now() - startedAt,
        },
        items: [],
      };
    }),
    ...duplicated,
  ];
  const outcomes = collected.map((entry) => entry.outcome);
  for (const outcome of outcomes) {
    try {
      opts.onSource?.(outcome);
    } catch {
      /* 回调异常不影响整体 */
    }
  }

  const items: SearchResultItem[] = [];
  const seen = new Set<string>();
  for (const entry of collected) {
    for (const item of entry.items) {
      const id = `${item.sourceKey}:${item.vodId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
  }

  const result: CategoryBrowseResult = {
    items,
    outcomes,
    supportedSources: outcomes.filter((outcome) => outcome.supported).length,
  };
  // 中途被取消的结果不能写缓存，否则用户下次切回来看到的是半截列表。
  // 同样地，一条源都没成功答复时也不写：那种结果要么是网络打嗝、要么是采集站
  // 正在限流，缓存 5 分钟只会让用户反复看到同一个空页面，还找不到原因。
  //
  // 这里必须只看「真正发过请求的源」：duplicated 那些是本地判定跳过的，
  // 它们的 outcome.ok 恒为 true（「跳过」不是失败），一旦把它们算进 answered，
  // 只要用户配了重复地址，上面那条「一条源都没成功就不缓存」就永远失效——
  // 全源失败的空列表照样被缓存 5 分钟。
  //
  // 被预算砍掉的那一轮（expired）仍然写缓存，但标记 partial 并只留
  // BROWSE_PARTIAL_TTL_MS：否则只要有一个源每次都超时，缓存就永远写不进去，
  // 用户每切一次分类都要重付一次 15 秒。短 TTL 让「立刻切回来」是快的，
  // 过一会儿又会去尝试补齐。
  const answered = uniqueSources.some((source) => results.get(source)?.outcome.ok === true);
  if (cacheKey && answered && !opts.signal?.aborted) {
    browseCache.set(cacheKey, { at: Date.now(), result, partial: expired });
  }
  return result;
}

/** 分类浏览的默认墙钟预算：15 秒内必须给用户一屏内容 */
const DEFAULT_BROWSE_BUDGET_MS = 15_000;
/** 分类浏览结果缓存（5 分钟）：切回上一个分类应当立刻出内容 */
const BROWSE_TTL_MS = 5 * 60 * 1000;
/** 被预算截断的结果只留 90 秒：够用户来回切两次，又不至于把残缺列表钉住 */
const BROWSE_PARTIAL_TTL_MS = 90 * 1000;
const browseCache = new Map<
  string,
  { at: number; result: CategoryBrowseResult; partial?: boolean }
>();

/** 清空分类结果缓存（源变更、手动刷新时调用） */
export function clearBrowseCache(): void {
  browseCache.clear();
}

/** 单个分类的可用性探测结果 */
export interface CategoryAvailability {
  key: CategoryKey;
  /** 该分类在所选源里是否至少有一个源返回了内容 */
  available: boolean;
  /** 参与判定的源数量 */
  sources: number;
  /** 有内容的源数量 */
  hits: number;
  /** 首个可用条目（用于可选的首屏预览） */
  sample?: SearchResultItem;
}

export interface ProbeCategoriesOptions {
  sources: SourceConfig[];
  http: HttpClient;
  /** 只探测这些分类（默认 HOME_CATEGORY_ORDER 全部） */
  keys?: CategoryKey[];
  /** 每个分类只取 1 页、每源最多 1 个子分类，控制开销 */
  typeLimit?: number;
  filterAdult?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 每个分类探测完成时回调（UI 可以边探测边点亮按钮） */
  onProbe?: (result: CategoryAvailability) => void;
  /**
   * 快速模式：只看分类表，不抓内容。
   *
   * 常规模式会为 8 个分类各跑一次 `browseCategory`，也就是 8 × 源数 次内容请求。
   * 实测 13 个源下整轮要 104 秒——而首页并没有在等结论，它只是想让「少儿」这类
   * 空入口不要出现。快速模式把「源站分类表里有没有这个桶」当作可用性依据，
   * 只发 13 次 `?ac=list`（还有 6 小时缓存与在途去重），一秒级完成。
   *
   * 代价：源站声明了分类但内容为空时会高估。这种分类点进去至少不是「全空」，
   * 各源会各自返回空列表，比首页挂 104 秒好得多。
   */
  fast?: boolean;
}

/**
 * 探测哪些分类真的有内容。
 *
 * 首页不该摆出「少儿」这种在所选源里一条都没有的入口：点进去只会看到空页面。
 * 这里每个分类只抓 1 页、每源最多 1 个子分类，4 个源 8 个分类约 32 个请求，
 * 并发执行后在几秒内完成；分类表本身有 6 小时缓存，二次进入几乎零开销。
 */
export async function probeCategories(opts: ProbeCategoriesOptions): Promise<CategoryAvailability[]> {
  const keys = opts.keys ?? HOME_CATEGORY_ORDER;
  const filterAdult = opts.filterAdult ?? true;
  const typeLimit = opts.typeLimit ?? 1;
  const fast = opts.fast === true;

  // 结果缓存：首页反复挂载时不必每次重打 32 个请求。键里带上源地址、分类集合与过滤开关。
  // fast 也要进键：两种模式的口径不同（表 vs 内容），混用会让「高估」的结论泄漏到精确模式。
  const cacheKey = `${keys.join(',')}|${filterAdult ? 1 : 0}|${typeLimit}|${fast ? 'f' : 'c'}|${opts.sources
    .map((source) => source.url)
    .sort()
    .join(',')}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.results.map((item) => ({ ...item }));

  // 只要有一个分类拿到了「源确实答复过」的结论，这次探测就是可采信的；
  // 全部源都超时/拒绝时不写缓存，否则用户等 10 分钟才有机会重试，
  // 而这 10 分钟里首页会一直显示「所选源暂未返回任何分类内容」。
  let meaningful = false;

  /** 快速模式：13 次分类表请求决定 8 个入口的显隐 */
  const probeFast = async (): Promise<CategoryAvailability[]> => {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const tables = await Promise.all(
      opts.sources.map(async (source): Promise<SourceCategory[] | null> => {
        try {
          return await categoriesOf(source, opts.http, { timeoutMs, signal: opts.signal });
        } catch {
          return null;
        }
      })
    );
    if (tables.some((table) => table !== null)) meaningful = true;
    return keys.map((key): CategoryAvailability => {
      let hits = 0;
      for (const table of tables) {
        if (table && matchTypeIds(table, key, 1).length > 0) hits += 1;
      }
      const availability: CategoryAvailability = {
        key,
        available: hits > 0,
        sources: opts.sources.length,
        hits,
      };
      try {
        opts.onProbe?.(availability);
      } catch {
        /* 回调异常不影响整体 */
      }
      return availability;
    });
  };

  const results = fast
    ? await probeFast()
    : await Promise.all(
    keys.map(async (key): Promise<CategoryAvailability> => {
      try {
        const result = await browseCategory({
          sources: opts.sources,
          key,
          http: opts.http,
          pages: 1,
          typeLimit,
          filterAdult,
          timeoutMs: opts.timeoutMs ?? 10_000,
          signal: opts.signal,
        });
        const hits = result.outcomes.filter((o) => o.supported && o.count > 0).length;
        // 「有源成功答复」与「有源有内容」是两件事：源答了但没有这个分类，
        // 同样是可信结论，必须能被缓存下来。
        if (result.outcomes.some((o) => o.ok)) meaningful = true;
        const availability: CategoryAvailability = {
          key,
          available: result.items.length > 0,
          sources: result.outcomes.length,
          hits,
          sample: result.items[0],
        };
        try {
          opts.onProbe?.(availability);
        } catch {
          /* 回调异常不影响整体 */
        }
        return availability;
      } catch {
        const availability: CategoryAvailability = {
          key,
          available: false,
          sources: opts.sources.length,
          hits: 0,
        };
        try {
          opts.onProbe?.(availability);
        } catch {
          /* ignore */
        }
        return availability;
      }
    })
      );
  // 被取消的探测不写缓存，避免把「全空」结论固化下来
  if (!opts.signal?.aborted && meaningful) {
    // 存一份快照，返回另一份副本：调用方（首页一边探测一边点亮入口）会原地改自己那份，
    // 直接把自己手上的数组也塞进缓存，就等于把缓存交给外部随意改写。
    probeCache.set(cacheKey, { at: Date.now(), results: results.map((item) => ({ ...item })) });
  }
  return results;
}

/** 探测结果缓存：10 分钟。分类内容变化不快，没必要每次回首页都重探一遍 */
const PROBE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map<string, { at: number; results: CategoryAvailability[] }>();

/** 清空探测缓存（切换源、改设置时调用） */
export function clearProbeCache(): void {
  probeCache.clear();
}
