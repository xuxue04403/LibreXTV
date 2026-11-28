/**
 * 内置源清单的读取。
 *
 * 清单真源是仓库根目录的 defaults/sources.json，构建时拷进 rawfile，
 * 因此这里只负责解析，不硬编码任何域名。
 *
 * 升级规则（与桌面端/Android 端一致）：
 * - key 由下标生成 `builtin_N` / `builtin_live_N`，所以**只能在末尾追加**，
 *   从中间删源会让老用户的 builtin_7 指向另一个站，历史记录与收藏会串台；
 * - version 变大时，同 key 但 url 变了的条目要就地换址（站点换域名），
 *   不能留下两条同 key。
 */
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import {
  AppData,
  DefaultsFile,
  DefaultsEntryLive,
  DefaultsEntryVod,
  LiveSource,
  VodSource,
} from '../model/Types';

const DEFAULT_SOURCES_FILE = 'default-sources.json';
const DEFAULT_FALLBACK_NAME = 'LibreXTV';

/** 读 assets（rawfile）里的清单文本；失败返回空串 */
export async function readDefaultsText(context: common.UIAbilityContext): Promise<string> {
  try {
    const bytes: Uint8Array = await context.resourceManager.getRawFileContent(DEFAULT_SOURCES_FILE);
    const decoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(bytes);
  } catch (err) {
    return '';
  }
}

/** 解析清单文本，得到两端同构的点播源/直播源与 version */
export function parseDefaults(text: string): DefaultsParsed {
  if (!text || text.trim().length === 0) {
    return { version: 0, name: DEFAULT_FALLBACK_NAME, vod: [], live: [], liveSelected: [], liveDisabled: [], vodSelected: [], vodDisabled: [] };
  }
  let file: DefaultsFile;
  try {
    file = JSON.parse(text) as DefaultsFile;
  } catch (err) {
    return { version: 0, name: DEFAULT_FALLBACK_NAME, vod: [], live: [], liveSelected: [], liveDisabled: [], vodSelected: [], vodDisabled: [] };
  }
  const vod: VodSource[] = [];
  const vodSelected: string[] = [];
  const vodDisabled: string[] = [];
  const rawVod: DefaultsEntryVod[] = file.sources ?? [];
  for (let i = 0; i < rawVod.length; i++) {
    const s = rawVod[i];
    const url = (s.url ?? '').replace(/\/+$/, '');
    if (!url.startsWith('http')) {
      continue;
    }
    const key = `builtin_${i}`;
    vod.push({
      key: key,
      name: s.name,
      url: url,
      detail: s.detail,
      isAdult: s.isAdult === true,
      builtin: true,
      note: s.note,
    });
    if (s.selected === false) {
      vodDisabled.push(key);
    } else {
      vodSelected.push(key);
    }
  }
  const live: LiveSource[] = [];
  const liveSelected: string[] = [];
  const liveDisabled: string[] = [];
  const rawLive: DefaultsEntryLive[] = file.liveSources ?? [];
  for (let i = 0; i < rawLive.length; i++) {
    const s = rawLive[i];
    const url = (s.url ?? '').trim();
    if (!url.startsWith('http')) {
      continue;
    }
    const key = `builtin_live_${i}`;
    live.push({
      key: key,
      name: s.name,
      url: url,
      epg: s.epg,
      builtin: true,
      note: s.note,
    });
    if (s.selected === false) {
      liveDisabled.push(key);
    } else {
      liveSelected.push(key);
    }
  }
  return {
    version: typeof file.version === 'number' ? file.version : 0,
    name: file.name ?? DEFAULT_FALLBACK_NAME,
    vod: vod,
    live: live,
    liveSelected: liveSelected,
    liveDisabled: liveDisabled,
    vodSelected: vodSelected,
    vodDisabled: vodDisabled,
  };
}

/**
 * 把内置清单合并进用户已有数据。
 *
 * 三种情况：
 * - 全新安装（data.seeded === false）：全量导入，点播源按清单里的 `selected:false`
 *   决定默认启用与否（v10 起 8 个大陆直连不通的源默认关闭）；
 * - 版本升级（defaultsVersion < version）：补新源、给换域名的条目就地换址，
 *   老用户删掉的源（removedDefaultUrls 里记过 url）不再复活；
 * - 版本没变：原样返回，用户删掉的就是删掉。
 */
export function mergeDefaults(data: AppData, parsed: DefaultsParsed): AppData {
  const upgraded = data.defaultsVersion < parsed.version;
  if (data.seeded && !upgraded) {
    return data;
  }
  const removed = new Set<string>(data.removedDefaultUrls);

  // ---- 点播源：同 key 换址 + 末尾追加 ----
  const byKey = new Map<string, VodSource>();
  for (let i = 0; i < data.sources.length; i++) {
    byKey.set(data.sources[i].key, data.sources[i]);
  }
  const existingUrls = new Set<string>();
  for (let i = 0; i < data.sources.length; i++) {
    existingUrls.add(data.sources[i].url);
  }
  const freshByKey = new Map<string, VodSource>();
  const added: VodSource[] = [];
  for (let i = 0; i < parsed.vod.length; i++) {
    const d = parsed.vod[i];
    const local = byKey.get(d.key);
    if (local !== undefined && local.url !== d.url && !removed.has(local.url)) {
      // 站点换了域名：保留原 key 与启用状态，只替换地址与名称
      freshByKey.set(d.key, d);
      continue;
    }
    if (local !== undefined) {
      continue;
    }
    if (existingUrls.has(d.url) || removed.has(d.url)) {
      continue;
    }
    added.push(d);
  }
  const sources: VodSource[] = [];
  for (let i = 0; i < data.sources.length; i++) {
    const s = data.sources[i];
    sources.push(freshByKey.get(s.key) ?? s);
  }
  for (let i = 0; i < added.length; i++) {
    sources.push(added[i]);
  }
  const sourceKeys = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    sourceKeys.add(sources[i].key);
  }
  // v10 起把大陆直连不通的 8 个内置点播源默认关掉（5 个连不上、3 个搜索被
  // Cloudflare 挡）。老用户升级到 v10 时一次性取消勾选，之后用户自己再打开
  // 不会被关掉——与直播源的 LIVE_SELECTION_VERSION 同一套规则。
  const vodDisabled = new Set<string>(parsed.vodDisabled);
  const vodBase: string[] =
    data.defaultsVersion < VOD_SELECTION_VERSION
      ? data.selected.filter((k: string) => !vodDisabled.has(k))
      : data.selected;
  const selected: string[] = [];
  const selectedSeen = new Set<string>();
  for (let i = 0; i < vodBase.length; i++) {
    const k = vodBase[i];
    if (sourceKeys.has(k) && !selectedSeen.has(k)) {
      selectedSeen.add(k);
      selected.push(k);
    }
  }
  for (let i = 0; i < added.length; i++) {
    const k = added[i].key;
    if (!vodDisabled.has(k) && !selectedSeen.has(k)) {
      selectedSeen.add(k);
      selected.push(k);
    }
  }

  // ---- 直播源：同样按 key 换址 + 末尾追加 ----
  const liveByKey = new Map<string, LiveSource>();
  const liveUrls = new Set<string>();
  for (let i = 0; i < data.liveSources.length; i++) {
    liveByKey.set(data.liveSources[i].key, data.liveSources[i]);
    liveUrls.add(data.liveSources[i].url);
  }
  const liveFresh = new Map<string, LiveSource>();
  const liveAdded: LiveSource[] = [];
  for (let i = 0; i < parsed.live.length; i++) {
    const d = parsed.live[i];
    const local = liveByKey.get(d.key);
    if (local !== undefined && local.url !== d.url && !removed.has(local.url)) {
      liveFresh.set(d.key, d);
      continue;
    }
    if (local !== undefined) {
      continue;
    }
    if (liveUrls.has(d.url) || removed.has(d.url)) {
      continue;
    }
    liveAdded.push(d);
  }
  const liveSources: LiveSource[] = [];
  for (let i = 0; i < data.liveSources.length; i++) {
    const s = data.liveSources[i];
    liveSources.push(liveFresh.get(s.key) ?? s);
  }
  for (let i = 0; i < liveAdded.length; i++) {
    liveSources.push(liveAdded[i]);
  }
  const disabled = new Set<string>(parsed.liveDisabled);
  const liveKeys = new Set<string>();
  for (let i = 0; i < liveSources.length; i++) {
    liveKeys.add(liveSources[i].key);
  }
  const liveSelected: string[] = [];
  const liveSeen = new Set<string>();
  for (let i = 0; i < data.liveSelected.length; i++) {
    const k = data.liveSelected[i];
    if (liveKeys.has(k) && !liveSeen.has(k)) {
      liveSeen.add(k);
      liveSelected.push(k);
    }
  }
  for (let i = 0; i < liveAdded.length; i++) {
    const k = liveAdded[i].key;
    if (!disabled.has(k) && !liveSeen.has(k)) {
      liveSeen.add(k);
      liveSelected.push(k);
    }
  }

  return {
    sources: sources,
    selected: selected,
    liveSources: liveSources,
    liveSelected: liveSelected,
    history: data.history,
    favorites: data.favorites,
    liveFavorites: data.liveFavorites,
    settings: data.settings,
    seeded: true,
    defaultsVersion: parsed.version,
    removedDefaultUrls: data.removedDefaultUrls,
  };
}

export interface DefaultsParsed {
  version: number;
  name: string;
  vod: VodSource[];
  live: LiveSource[];
  liveSelected: string[];
  liveDisabled: string[];
  /** 清单里没标 selected:false 的内置点播源 key（新装用户默认启用） */
  vodSelected: string[];
  /** 清单里标了 selected:false 的内置点播源 key（大陆直连不通的那些） */
  vodDisabled: string[];
}

/** 从哪个清单版本开始「只默认启用大陆直连可用的点播源」（与直播源的规则并列） */
export const VOD_SELECTION_VERSION = 10;
