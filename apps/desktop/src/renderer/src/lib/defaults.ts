import defaultsRaw from '@defaults';
import type { LiveSourceConfig, SourceConfig } from '@librextv/core';

interface DefaultsFile {
  name: string;
  version?: number;
  sources: { name: string; url: string; detail?: string; isAdult?: boolean; selected?: boolean; note?: string }[];
  liveSources: { name: string; url: string; epg?: string; selected?: boolean; note?: string }[];
}

const data = defaultsRaw as unknown as DefaultsFile;

/**
 * 内置源清单的版本号（`defaults/sources.json` 的 `version`）。
 *
 * 加新内置源时必须同时把这个数字加一，否则老用户的存储里已经
 * `defaultsSeeded: true`，新源永远补不进来。
 */
export const DEFAULTS_VERSION = Number(data.version ?? 0);

/**
 * 内置默认源：与 Android TV 端 assets 里的 default-sources.json 是同一份文件
 * （仓库 defaults/sources.json），避免两端各维护一份。
 *
 * `key` 由下标生成，所以**只能在末尾追加**新源：插在中间会让老用户已保存的
 * `builtin_N` 指向另一个站，历史记录与收藏会串台。
 */
export const DEFAULT_SOURCES: SourceConfig[] = (data.sources ?? []).map((source, index) => ({
  key: `builtin_${index}`,
  name: source.name,
  url: source.url,
  detail: source.detail,
  isAdult: source.isAdult,
  note: source.note,
}));

/**
 * 新装用户默认启用的内置点播源。
 *
 * 全 17 个源按「列表 + 搜索」两个端点实测过：9 个在大陆直连两项都通；其余 8 个
 * 标了 `selected: false`——5 个连不上（量子、电影天堂、如意、暴风、新浪，DNS 被
 * 污染，绕过污染后服务端仍拒绝），3 个搜索被 Cloudflare 挑战页挡住（极速、金鹰、
 * 光速，返回 HTTP 403 的「Just a moment...」）。这些源开着只会让每次搜索白等满
 * 超时，或者在分类页看得到、一搜就 403。源照样进列表、保留原下标（避免老用户
 * `builtin_N` 指向别的站），只是默认不勾选。
 */
export const DEFAULT_SELECTED_KEYS: string[] = (data.sources ?? [])
  .map((source, index) => (source.selected === false ? null : `builtin_${index}`))
  .filter((key): key is string => key !== null);

/** 清单里明确标了 `selected: false` 的内置点播源 key */
export const DEFAULT_DISABLED_KEYS: string[] = (data.sources ?? [])
  .map((source, index) => (source.selected === false ? `builtin_${index}` : null))
  .filter((key): key is string => key !== null);

/**
 * 从哪个清单版本开始「只默认启用大陆直连可用的点播源」。
 *
 * 与 `LIVE_SELECTION_VERSION` 同理：v9 及以前老用户 17 个源全勾着，只改 `selected`
 * 对他们没效果（勾选状态早就存进存储了），所以升级到 v10 时把清单里标了
 * `selected:false` 的那些取消勾选一次。只做这一次：用户之后手动打开的，不会在
 * 下次升级时又被关掉。
 */
export const VOD_SELECTION_VERSION = 10;

export const DEFAULT_LIVE_SOURCES: LiveSourceConfig[] = (data.liveSources ?? []).map((source, index) => ({
  key: `builtin_live_${index}`,
  name: source.name,
  url: source.url,
  epg: source.epg,
}));

/**
 * 新装用户默认启用的内置直播源。
 *
 * 「iptv-org 全球频道」「iptv-org 中国频道」「Guovin 央视卫视」在国内等距抽测的
 * 可播率分别只有 8%~30%、10%~15%、18%~23%，开着它们只会让用户随便点一个台就是死台。
 * 清单里用 `selected: false` 标出来：源照样加进列表，只是默认不勾选，需要时在设置里
 * 手动打开。默认启用的是 vbskycn 国内 IPv4（73%~78% 可播、含 3840×2160）、zhi35
 * 央视卫视港澳台（55%~60%）、best-fan 国内全量（57%~60%）与 Collect-IPTV 精选
 * （40%~43%），同名的台在合并时按清单顺序去重，因此清单里按可播率从高到低排列。
 */
export const DEFAULT_LIVE_SELECTED_KEYS: string[] = (data.liveSources ?? [])
  .map((source, index) => (source.selected === false ? null : `builtin_live_${index}`))
  .filter((key): key is string => key !== null);

/** 清单里明确标了 `selected: false` 的内置直播源 key */
export const DEFAULT_LIVE_DISABLED_KEYS: string[] = (data.liveSources ?? [])
  .map((source, index) => (source.selected === false ? `builtin_live_${index}` : null))
  .filter((key): key is string => key !== null);

/**
 * 从哪个清单版本开始「只默认启用健康源」。
 *
 * 到 v4 为止老用户是三个直播源全开的，只改 `selected` 对他们没有任何效果（他们的
 * 勾选状态早就存进 `liveSelectedKeys` 了），所以升级到该版本时**取消勾选一次**。
 * 只做这一次：用户之后手动打开的，不会在下次升级时又被关掉。
 */
export const LIVE_SELECTION_VERSION = 5;

/** 默认不启用的内置源在设置页需要解释一句，否则用户以为它坏了 */
export const DEFAULT_LIVE_NOTES: Record<string, string> = Object.fromEntries(
  (data.liveSources ?? [])
    .map((source, index) => [`builtin_live_${index}`, source.note ?? ''] as const)
    .filter(([, note]) => note !== '')
);

export const DEFAULTS_NOTICE =
  '内置源均为第三方公开接口，与本项目无隶属关系；仅作开箱即用的示例，可在设置中随时停用或删除。';
