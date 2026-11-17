/**
 * Apple CMS（苹果CMS）资源站响应解析。
 *
 * 移植自 LibreTV（AGPL-3.0-or-later）src/lib/cms-parser.ts：
 * https://github.com/LibreSpark/LibreTV
 * 改动：无（纯函数，客户端/服务端通用）。
 */

import type { SearchResultItem, VideoDetail } from './types';

/**
 * 简介文本里的 m3u8 链接。
 *
 * 必须把 `?query` 一起吃掉：CDN 防盗链普遍是 `xxx.m3u8?token=…&expires=…`，
 * 惰性匹配停在第一个 `.m3u8` 会丢掉签名参数，播放器拿到的是 403 的裸地址。
 */
const M3U8_PATTERN = /\$?https?:\/\/[^"'\s]*?\.m3u8(?:\?[^"'\s#]*)?/g;

/** 采集站大多校验 UA，客户端直连时也要带上 */
export const CMS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export function cmsRequestHeaders(): Record<string, string> {
  return { 'User-Agent': CMS_USER_AGENT, Accept: 'application/json' };
}

/**
 * 在源地址上追加 Apple CMS 查询参数。
 *
 * 自定义源的地址可能自带查询串（`…/api.php?key=abc`），无脑拼 `?ac=…` 会得到
 * `…?key=abc?ac=videolist&wd=…`——第二个 `?` 变成上一个参数值的一部分，`wd` 根本不生效，
 * 搜索恒 0 条。所以按需选 `?` 还是 `&`。
 */
export function cmsUrl(base: string, params: Record<string, string | number>): string {
  const root = base.trim().replace(/\/+$/, '');
  const sep = root.includes('?') ? '&' : '?';
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${root}${sep}${query}`;
}

/** 搜索响应 → 统一结果列表 */
export function parseSearchList(
  data: unknown,
  source: { key: string; name: string; url: string; isAdult?: boolean }
): SearchResultItem[] {
  if (!data || typeof data !== 'object') throw new Error('API返回的数据格式无效');
  const list = (data as { list?: unknown }).list;
  // 部分源站无结果时返回 list: null（而非 []），视为空结果而非格式错误
  if (list !== null && list !== undefined && !Array.isArray(list)) {
    throw new Error('API返回的数据格式无效');
  }
  return (Array.isArray(list) ? list : []).map((item) => {
    const vod = item as Record<string, unknown>;
    return {
      sourceKey: source.key,
      sourceName: source.name,
      vodId: String(vod.vod_id ?? ''),
      name: String(vod.vod_name ?? ''),
      pic: typeof vod.vod_pic === 'string' ? vod.vod_pic : undefined,
      typeName: typeof vod.type_name === 'string' ? vod.type_name : undefined,
      year: typeof vod.vod_year === 'string' ? vod.vod_year : undefined,
      area: typeof vod.vod_area === 'string' ? vod.vod_area : undefined,
      remarks: typeof vod.vod_remarks === 'string' ? vod.vod_remarks : undefined,
      sourceUrl: source.url,
      isAdult: source.isAdult,
    };
  });
}

/**
 * 从 vod_play_url 中提取分集地址：格式 源1$$$源2，集1$URL1#集2$URL2。
 * 部分源（如量子 lziapi、非凡 ffzy）第一条线路是网页中转页（…/share/xxx，不可播），
 * 真实 m3u8 在后面的线路里，因此优先取包含 m3u8 直链的线路；均无 m3u8 时回退第一条。
 */
export function extractEpisodesFromPlayUrl(playUrl: string): string[] {
  if (!playUrl) return [];
  const groups = playUrl
    .split('$$$')
    .map((group) =>
      group
        .split('#')
        .map((ep) => {
          // 只按**第一个** `$` 切：URL 自身可能带 `$`（部分 CDN 签名就用它），
          // 用 `split('$')` 取 parts[1] 会把后半截截掉，得到一个不能播的地址。
          const at = ep.indexOf('$');
          const url = at >= 0 ? ep.slice(at + 1) : ep;
          return url.trim();
        })
        .filter((url) => url.startsWith('http://') || url.startsWith('https://'))
    )
    .filter((eps) => eps.length > 0);
  if (groups.length === 0) return [];
  return groups.find((eps) => eps.some((url) => url.includes('.m3u8'))) ?? groups[0];
}

/** 从简介文本中兜底提取 m3u8 链接 */
export function extractM3u8FromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(M3U8_PATTERN) || [];
  return matches.map((link) => link.replace(/^\$/, ''));
}

/** 详情 JSON 响应 → 统一详情 */
export function parseDetail(data: unknown, source: { key: string; name: string; url: string }): VideoDetail {
  const d = data as { list?: Record<string, unknown>[] };
  if (!d || !Array.isArray(d.list) || d.list.length === 0) {
    throw new Error('获取到的详情内容无效');
  }
  const vod = d.list[0];
  let episodes = extractEpisodesFromPlayUrl(String(vod.vod_play_url ?? ''));
  if (episodes.length === 0) {
    episodes = extractM3u8FromText(String(vod.vod_content ?? ''));
  }
  return {
    episodes,
    videoInfo: {
      title: str(vod.vod_name),
      cover: str(vod.vod_pic),
      desc: str(vod.vod_content),
      typeName: str(vod.type_name),
      year: str(vod.vod_year),
      area: str(vod.vod_area),
      director: str(vod.vod_director),
      actor: str(vod.vod_actor),
      remarks: str(vod.vod_remarks),
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

/**
 * 部分源的列表接口不返回播放地址，需要爬详情页 HTML 提取 m3u8。
 * 与旧版 handleSpecialSourceDetail 对齐。
 */
export function parseDetailPageHtml(
  html: string,
  source: { key: string; name: string; url: string }
): VideoDetail {
  // 先尝试通用模式，再尝试非凡影视的日期哈希特征路径。
  // `.m3u8` 后面要接着吃 `?query`：CDN 签名参数（token/expires）丢了就是 403。
  let matches = html.match(/\$https?:\/\/[^"'\s<]*?\.m3u8(?:\?[^"'\s<]*)?/g) || [];
  if (matches.length === 0) {
    matches = html.match(/\$https?:\/\/[^"'\s<]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8(?:\?[^"'\s<]*)?/g) || [];
  }
  // 去重并清理尾缀
  const episodes = [...new Set(matches)].map((link) => {
    let u = link.substring(1);
    const parenIndex = u.indexOf('(');
    if (parenIndex > 0) u = u.substring(0, parenIndex);
    return u;
  });

  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);

  return {
    episodes,
    videoInfo: {
      title: titleMatch ? titleMatch[1].trim() : undefined,
      desc: descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : undefined,
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

/**
 * 成人分类关键词（与上游保持一致，并按实测补充）。
 *
 * 只用于匹配**分类名**（type_name）。实测发现部分采集站把成人内容放在
 * 「剧情片」「短剧」这类正常分类下，靠分类名拦不住，因此另有
 * ADULT_TITLE_KEYWORDS 负责标题兜底。
 */
export const ADULT_KEYWORDS = [
  // 「伦理」「三级」是 2026-10 新增百度资源时实测出来的缺口：
  // 该源把成人内容拆成四个**顶级**分类「伦理(55)」「港台三级(56)」「西方伦理(58)」「日本伦理(59)」，
  // 而原词表只有「伦理片」「日本伦理」「韩国伦理」——「伦理」和「港台三级」都漏了。
  // 实测「伦理(55)」有 20 条，全部是成人片（女教师的性爱玩具 / 做我的奴隶 …）。
  // 这两个词只作为**分类名**关键词，不进标题词表：标题里有「愤怒的伦理学」这类正经片名。
  '伦理', '三级',
  '伦理片', '福利', '倫理片', '福利片', '日本伦理', '日本福利', '日本福利片', '日本伦理片', '擦边短剧', '擦边',
  '韩国伦理', '里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒',
  'cosplay', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码', 'SWAG',
  '网红主播', '色情片', '同性片', '福利视频', '无码高清', '有码高清', '91视频', '自拍偷拍', 'mini传媒',
  // 同上，百度资源的两个空分类（当前 0 条，但有内容时必须是成人语义）。
  // 用整词而不是「两性」「写真」，避免误伤「写真集」这类正常摄影类分类。
  '两性课堂', '写真热舞',
];

/**
 * 成人**标题**关键词 —— 分类名正常但片名露骨的情况。
 *
 * 实测依据（2026-10，4 个内置源）：
 * - 「无码」命中「我的23岁之无码青春」→ type_name 是「爱情片」
 * - 「麻豆」命中「麻豆小镇」→ 「台湾剧」
 * - 「黑料」命中「黑料局中局」→ 「短剧」
 * - 「情色片」命中「情色片编年史」→ 「电影解说」
 *
 * 这里刻意避开容易误伤的正经词：`黑料`/`麻豆`/`星空`/`天美`/`果冻`/`蜜桃`
 * 在真实数据里大量出现在「福利院的阳光」「麻豆小镇」「吞噬星空」这类
 * 正常内容中，因此**不纳入**，避免把儿童/家庭题材也过滤掉。
 */
export const ADULT_TITLE_KEYWORDS = [
  '无码', '無碼', '有码', '里番', '裏番', '三级片', '三級片', 'A片', 'a片',
  '情色片', '色情片', '成人片', '限制级', '限制級', '自拍偷拍', '偷拍自拍',
  '国产自拍', '国产传媒', '传媒出品', '门事件', '門事件', '裸聊', '催情',
  '午夜剧场', '午夜神器', '伦理电影', '倫理電影',
  // 2026-10 二轮实测补充：A/B 对比「成人过滤开/关」时，开启后仍漏出 13 条，
  // 几乎全部集中在「情色/色情」这一根词上（情色自白 / 情色大亨 / 水手服情色饲育 /
  // 姐妹情色 / 反情色 / 情色自拍 …），而词表里当时只有「情色片」。
  // 「情色」「色情」在中文影视标题里几乎只用于成人语义，可以安全提升为标题词。
  //
  // 刻意**不加**英文 `sex` / `porn`：真实数据里有「Sex and the City」（欲望都市）、
  // 「Zack and Miri make a porno」这类正经西片，加了会把它们误杀。
  '情色', '色情', '成人视频', '成人电影',
];

/**
 * 分类名的**误伤排除**：这些词里包含成人关键词，但本身是正经内容。
 *
 * 实测证据：`福利` 是分类关键词，但「福利院的阳光」这类家庭/公益题材
 * 在真实采集站里确实存在，不能被误杀。
 */
const ADULT_TYPE_EXCEPTIONS = /福利院|福利社|少年福利|儿童福利|社会福利/u;

/**
 * 判断是否为成人内容。
 *
 * 三个来源（命中任一即屏蔽）：
 * 1. 来源被标记为成人源（订阅里的 `isAdult`）——此前字段存在但从未被使用；
 * 2. 分类名命中 ADULT_KEYWORDS（先排除误伤词）；
 * 3. 标题命中 ADULT_TITLE_KEYWORDS（兜住「正常分类 + 露骨片名」的漏网）。
 */
export function isAdultContent(
  typeName: string | undefined,
  name?: string,
  sourceIsAdult?: boolean
): boolean {
  if (sourceIsAdult) return true;
  if (typeName) {
    const lower = typeName.toLowerCase();
    if (!ADULT_TYPE_EXCEPTIONS.test(typeName) && ADULT_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
      return true;
    }
  }
  if (name) {
    const lower = name.toLowerCase();
    if (ADULT_TITLE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return true;
  }
  return false;
}

export function filterAdultResults<T extends { typeName?: string; name?: string; isAdult?: boolean }>(
  items: T[],
  enabled: boolean
): T[] {
  if (!enabled) return items;
  return items.filter((item) => !isAdultContent(item.typeName, item.name, item.isAdult));
}

/**
 * 归一化标题/关键词：去空白、标点与符号，转小写。
 * 用于跨标点差异匹配（源站存「摔跤吧!爸爸」而用户搜「摔跤吧！爸爸」）。
 */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 仅将独立数字或明确的「第 N 季」后缀作为季数别名。
 *
 * `bareNeedsSpace` 区分两侧：
 * - 查询侧传 false：用户习惯直接输入「庆余年2」，数字前没有空格也得认成季数
 * - 标题侧保持 true：必须有空格，避免把片名自带的数字（「电影2」）误判成第二季
 */
function parseSeasonSuffix(
  title: string,
  allowAnnotations = false,
  bareNeedsSpace = true
): { base: string; season: number; explicit: boolean } | undefined {
  const explicitPattern = allowAnnotations
    ? /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季.*$/u
    : /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季$/u;
  const explicit = title.trim().match(explicitPattern);
  const bare = title.trim().match(bareNeedsSpace ? /^(.*?)\s+([1-9]\d?)$/u : /^(.*?)\s*([1-9]\d?)$/u);
  const match = explicit ?? bare;
  if (!match || !normalizeTitle(match[1])) return undefined;
  const value = match[2];
  const digits = '零一二三四五六七八九';
  let season = Number(value);
  if (!Number.isFinite(season)) {
    const chinese = value.replace('两', '二');
    if (/^[一二三四五六七八九]$/u.test(chinese)) {
      season = digits.indexOf(chinese);
    } else if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(chinese)) {
      const [tens, units] = chinese.split('十');
      season = (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
    }
  }
  if (!Number.isFinite(season)) return undefined;
  return { base: match[1], season, explicit: Boolean(explicit) };
}

/** 数字必须完整命中，避免第 2 季误匹配 12 或 20。 */
function includesKeyword(title: string, keyword: string): boolean {
  if (!title || !keyword) return false;
  let index = title.indexOf(keyword);
  while (index >= 0) {
    const before = title[index - 1] ?? '';
    const after = title[index + keyword.length] ?? '';
    if ((!/^\d/u.test(keyword) || !/\d/u.test(before)) && (!/\d$/u.test(keyword) || !/\d/u.test(after))) return true;
    index = title.indexOf(keyword, index + 1);
  }
  return false;
}

interface PreparedQuery {
  normalized: string;
  season?: { base: string; season: number; explicit: boolean };
  tokens: string[];
}

function prepareQuery(wd: string): PreparedQuery | undefined {
  const normalized = normalizeTitle(wd);
  if (!normalized) return undefined;
  return {
    normalized,
    season: parseSeasonSuffix(wd, false, false),
    tokens: wd.trim().split(/\s+/).map(normalizeTitle).filter(Boolean),
  };
}

function matchesPrepared(nName: string, query: PreparedQuery): boolean {
  if (includesKeyword(nName, query.normalized)) return true;
  return query.tokens.length > 1 && query.tokens.every((token) => includesKeyword(nName, token));
}

function isRelevantPrepared(name: string, query: PreparedQuery): boolean {
  const nName = normalizeTitle(name);
  if (!nName) return false;
  const titleSeason = parseSeasonSuffix(name, true);
  if (query.season && titleSeason) {
    if (query.season.season !== titleSeason.season) return false;
    if (query.season.explicit || titleSeason.explicit) {
      const baseQuery = prepareQuery(query.season.base);
      if (baseQuery) return matchesPrepared(normalizeTitle(titleSeason.base), baseQuery);
    }
  }
  return matchesPrepared(nName, query);
}

/**
 * 忽略标点和大小写，多词查询要求每个词都命中。
 * 独立的末尾数字也可匹配明确的中文季数后缀；
 * 标题内部的数字与四位年份不作为季数别名。
 */
export function isRelevant(name: string, wd: string): boolean {
  const query = prepareQuery(wd);
  if (!query) return true;
  return isRelevantPrepared(name, query);
}

/** 丢弃无关结果；即使全部不相关，也不能返回源站的原始目录。 */
export function filterRelevantResults<T extends { name?: string }>(items: T[], wd: string): T[] {
  const query = prepareQuery(wd);
  if (!query) return items;
  return items.filter((item) => isRelevantPrepared(item.name || '', query));
}

/**
 * 季数解析（供同片判定用）。
 *
 * 收窄了两处，避免把数字片名当季数：
 * - 基底是纯数字（「1917」被拆成「19」的第 17 季）时返回 undefined；
 * - 两侧都放宽到「数字前无空格」，让「庆余年2」与「庆余年 第二季」能对上。
 */
function sameShowSeason(raw: string, annotations: boolean): { base: string; season: number } | undefined {
  const parsed = parseSeasonSuffix(raw, annotations, false);
  if (!parsed) return undefined;
  if (/^\d+$/u.test(normalizeTitle(parsed.base))) return undefined;
  return { base: parsed.base, season: parsed.season };
}

/**
 * 归一化串里 needle 是否紧跟「续集序号」。
 *
 * 只认一位数字（1-9）且后面不是 k/p：「流浪地球2」是续集，
 * 「流浪地球 4K」「流浪地球 1080P」只是画质说明，后者不能当续集挡掉。
 */
function digitsDirectlyAfter(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const rest = haystack.slice(index + needle.length);
    const run = /^(\d+)/u.exec(rest);
    if (run) {
      const digits = run[1];
      const after = rest.slice(digits.length, digits.length + 1).toLowerCase();
      if (digits.length === 1 && digits !== '0' && after !== 'k' && after !== 'p') return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/**
 * 去掉括号注释与年份，只留下「片名本体」。
 *
 * 「繁花(2024) 全集」去掉注释后是「繁花 全集」，紧跟的数字没了，
 * 才不会被紧邻数字规则误判成「繁花2」这类续集。
 */
function stripAnnotations(raw: string): string {
  return raw
    .replace(/[([【][^)\]】]*[)\]】]/gu, ' ')
    .replace(/(^|[\s\p{P}])(?:19|20)\d{2}(?=$|[\s\p{P}])/gu, ' ');
}

/**
 * 判断两个片名是否「同一部片」，用于自动换源的同片匹配。
 *
 * 比 `isRelevant`（搜索相关性）严格：用户搜「庆余年」时返回「庆余年2」是合理的，
 * 但自动换源把它当成同一部片就会静默播错内容（界面标题不变，看的却是续集）。
 * 这里要求季数一致，且基底互相包含——「流浪地球2」相对「流浪地球」按季数或
 * 紧邻数字都能挡住。
 */
export function isSameShow(name: string, wd: string): boolean {
  const title = normalizeTitle(name);
  const wanted = normalizeTitle(wd);
  if (!title || !wanted) return false;
  if (title === wanted) return true;

  const titleSeason = sameShowSeason(name, true);
  const querySeason = sameShowSeason(wd, false);
  const titleNo = titleSeason?.season ?? 1;
  const queryNo = querySeason?.season ?? 1;
  if (titleNo !== queryNo) return false;

  const titleBase = normalizeTitle(titleSeason?.base ?? name);
  const queryBase = normalizeTitle(querySeason?.base ?? wd);
  if (!titleBase || !queryBase) return false;
  if (titleBase === queryBase) return true;
  // 紧邻数字只在「去掉括号注释与年份」之后判断：否则「繁花(2024)」会被当成「繁花2」
  const titleDigits = normalizeTitle(stripAnnotations(name));
  const queryDigits = normalizeTitle(stripAnnotations(wd));
  if (digitsDirectlyAfter(titleDigits, queryDigits) || digitsDirectlyAfter(queryDigits, titleDigits)) return false;
  return titleBase.includes(queryBase) || queryBase.includes(titleBase);
}
