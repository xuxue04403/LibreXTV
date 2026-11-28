/**
 * 成人内容过滤。
 *
 * 移植自 packages/core/src/cms.ts 的 ADULT_KEYWORDS / ADULT_TITLE_KEYWORDS /
 * isAdultContent。词表按实测补过：百度资源的「伦理」「港台三级」、暴风的
 * 「两性课堂」等都是顶级分类，靠标题兜不住，必须按分类名拦。
 */
import { CmsVod } from './Cms';
import { SearchItem } from '../model/Types';

/** 分类名命中即判为成人内容 */
export const ADULT_KEYWORDS: string[] = [
  '伦理',
  '三级',
  '港台三级',
  '西方伦理',
  '日本伦理',
  '里番',
  '无码',
  '有码',
  '成人',
  '情色',
  '色情',
  // 用整词而不是「两性」「写真」「热舞」：core 侧原来的宽词会误伤
  // 「写真集」「热舞青春」这类正常分类，实测后已收窄成下面两个。
  '两性课堂',
  '写真热舞',
  '擦边',
];

/** 标题兜底词：部分源把成人片塞进「剧情片」「短剧」这类正常分类 */
export const ADULT_TITLE_KEYWORDS: string[] = [
  '情色',
  '色情',
  '成人视频',
  '成人电影',
  '成人片',
  '三级片',
  '无码',
  '有码',
  'AV女优',
  '女优',
];

/**
 * 简介/备注里的成人词。
 *
 * 采集站常把「伦理」「无码」写在 `vod_remarks`（如「伦理片 更新至12集」），
 * 片名和分类都是干净的 —— 只查前两项会整批漏出去。core 侧已有这一路。
 */
export const ADULT_REMARK_KEYWORDS: string[] = [
  '伦理',
  '无码',
  '有码',
  '色情',
  '情色',
  '三级',
];

/** 直播频道名里的成人词（英文用词边界，避免误杀 Essex TV / Middlesex） */
const ADULT_LIVE_EN = new RegExp('(^|[^a-z])(sex|xxx|porn|adult|erotic|playboy|brazzers|hot adult)([^a-z]|$)');
const ADULT_LIVE_CN: string[] = ['成人', '情色', '色情', '里番', '三级', '无码', '有码'];

/** 「福利院」「儿童福利」这类正常词不能被「福利」误伤 */
const ADULT_TYPE_EXCEPTIONS = new RegExp('福利院|福利社|少年福利|儿童福利|社会福利');

/** 判一条内容是否成人 */
export function isAdultVod(vod: CmsVod, sourceIsAdult: boolean = false): boolean {
  if (sourceIsAdult) {
    return true;
  }
  const typeName = (vod.type_name ?? '').toLowerCase();
  if (typeName.length > 0 && !ADULT_TYPE_EXCEPTIONS.test(typeName)) {
    for (let i = 0; i < ADULT_KEYWORDS.length; i++) {
      if (typeName.indexOf(ADULT_KEYWORDS[i].toLowerCase()) >= 0) {
        return true;
      }
    }
  }
  const name = (vod.vod_name ?? '').toLowerCase();
  if (name.length > 0) {
    for (let i = 0; i < ADULT_TITLE_KEYWORDS.length; i++) {
      if (name.indexOf(ADULT_TITLE_KEYWORDS[i].toLowerCase()) >= 0) {
        return true;
      }
    }
  }
  // 备注/简介兜底：采集站常把「伦理」「无码」写在 vod_remarks 里
  const remarks = (vod.vod_remarks ?? '').toLowerCase();
  if (remarks.length > 0) {
    for (let i = 0; i < ADULT_REMARK_KEYWORDS.length; i++) {
      if (remarks.indexOf(ADULT_REMARK_KEYWORDS[i].toLowerCase()) >= 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 判一个直播频道是不是成人频道。
 *
 * 直播链路此前完全没有过滤：m3u 清单里混进来的成人台会直接出现在网格里。
 * 英文词必须用词边界匹配 —— `includes('sex')` 会把 Essex TV / Middlesex 也杀掉。
 */
export function isAdultChannelName(name: string | undefined, group?: string): boolean {
  const hay = `${name ?? ''} ${group ?? ''}`.toLowerCase();
  if (hay.trim().length === 0) {
    return false;
  }
  for (let i = 0; i < ADULT_LIVE_CN.length; i++) {
    if (hay.indexOf(ADULT_LIVE_CN[i]) >= 0) {
      return true;
    }
  }
  return ADULT_LIVE_EN.test(hay);
}

/** 批量过滤（保持入参顺序） */
export function filterAdultVods(vods: CmsVod[], sourceIsAdult: boolean, enabled: boolean): CmsVod[] {
  if (!enabled) {
    return vods;
  }
  const out: CmsVod[] = [];
  for (let i = 0; i < vods.length; i++) {
    if (!isAdultVod(vods[i], sourceIsAdult)) {
      out.push(vods[i]);
    }
  }
  return out;
}

/** 对已解析好的搜索结果做过滤（搜索链路用这个） */
export function filterAdultItems(items: SearchItem[], enabled: boolean): SearchItem[] {
  if (!enabled) {
    return items;
  }
  const out: SearchItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (isAdultName(it.typeName, it.name, it.isAdult === true)) {
      continue;
    }
    out.push(it);
  }
  return out;
}

/** 按分类名 + 标题判定（与 isAdultVod 同一套词表） */
export function isAdultName(typeName: string | undefined, name: string | undefined, sourceIsAdult: boolean): boolean {
  if (sourceIsAdult) {
    return true;
  }
  const t = (typeName ?? '').toLowerCase();
  if (t.length > 0 && !ADULT_TYPE_EXCEPTIONS.test(t)) {
    for (let i = 0; i < ADULT_KEYWORDS.length; i++) {
      if (t.indexOf(ADULT_KEYWORDS[i].toLowerCase()) >= 0) {
        return true;
      }
    }
  }
  const n = (name ?? '').toLowerCase();
  if (n.length > 0) {
    for (let i = 0; i < ADULT_TITLE_KEYWORDS.length; i++) {
      if (n.indexOf(ADULT_TITLE_KEYWORDS[i].toLowerCase()) >= 0) {
        return true;
      }
    }
  }
  return false;
}
