import { useEffect, useMemo, useState } from 'react';
import { HOME_CATEGORIES, probeCategories, type CategoryKey } from '@librextv/core';
import { http } from './bridge';
import { useAppStore } from './store';

/**
 * 分类可用性探测（首页与分类页共用）。
 *
 * 探测走「只看分类表」的快速模式，13 个源约一秒级完成；结果按「源签名」落到
 * localStorage：下次启动直接按上次结论渲染，后台再刷新，首屏不等它。
 *
 * 这个文件只导出 hook 与类型（React Fast Refresh 要求组件文件里不放别的导出，
 * 否则改一次样式就要整文件重载，正在播放的视频会被打断）。
 */
const AVAILABILITY_KEY = 'librextv-category-availability-v1';
/** 探测结论的有效期：源站内容天天变，超过一天就该重新问一遍 */
const AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedAvailability {
  signature: string;
  keys: CategoryKey[];
  at: number;
}

function readCachedAvailability(signature: string): CategoryKey[] | undefined {
  try {
    const raw = localStorage.getItem(AVAILABILITY_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CachedAvailability;
    if (parsed.signature !== signature || !Array.isArray(parsed.keys)) return undefined;
    // 注释一直写着「24 小时内的结论直接用」，但代码从来没看过 at：
    // 结论会永久有效。导入一份新配置后（源地址全换、key 却还是 builtin_0..3），
    // 首页会按几个月前的探测结果把分类按钮藏起来，用户怎么看都少几个分类。
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > AVAILABILITY_TTL_MS) return undefined;
    return parsed.keys;
  } catch {
    return undefined;
  }
}

function writeCachedAvailability(signature: string, keys: CategoryKey[]): void {
  try {
    const payload: CachedAvailability = { signature, keys, at: Date.now() };
    localStorage.setItem(AVAILABILITY_KEY, JSON.stringify(payload));
  } catch {
    /* 配额满或被禁用时忽略，探测结果本身还会用 */
  }
}

/**
 * 分类探测的模块级单飞。
 *
 * 探测一轮曾经要打「8 个分类 × N 个源」次内容请求，13 个源下实测 104 秒；
 * 这段时间里它和用户主动点开的分类页抢同一个全局并发闸门，所以首页一挂载，
 * 分类浏览就跟着变慢。
 *
 * 现在改两件事：
 * 1. 走 `fast` 模式：只看各源的分类表（带 6 小时缓存 + 在途去重），13 次请求就够，
 *    一秒级完成，不再发内容请求。
 * 2. 结果照旧按签名落到 localStorage，下次启动先按上次结论渲染。
 *
 * 模块级单飞的意义（保留）：探测结果与「进行中的那一轮」都挂在模块上，按签名复用；
 * 组件卸载只取消「把结果写回 state」，不打断请求本身——用户在探测期间切页再切回来
 * 不会从头再问一遍。
 */
let probeOnce: { signature: string; promise: Promise<CategoryKey[]> } | null = null;
let probedResult: { signature: string; keys: CategoryKey[] } | null = null;

function ensureProbe(
  signature: string,
  sources: ReturnType<typeof useAppStore.getState>['sources'],
  adultFilter: boolean
): Promise<CategoryKey[]> {
  if (probedResult?.signature === signature) return Promise.resolve(probedResult.keys);
  if (probeOnce?.signature === signature) return probeOnce.promise;
  const promise = probeCategories({
    sources,
    http,
    filterAdult: adultFilter,
    timeoutMs: 12_000,
    fast: true,
  })
    .then((results) => results.filter((r) => r.available).map((r) => r.key))
    .catch(() => [] as CategoryKey[])
    .then((available) => {
      // 一个分类都判定不出来（全部源超时、断网、刚开机）时不能把 8 个入口全藏掉：
      // 用户连点进去试一次的机会都没有。退回全量展示，且不落盘——下次进来重新探。
      const keys = available.length > 0 ? available : HOME_CATEGORIES.map((c) => c.key);
      probedResult = { signature, keys };
      if (probeOnce?.signature === signature) probeOnce = null;
      if (available.length > 0) writeCachedAvailability(signature, available);
      return keys;
    });
  probeOnce = { signature, promise };
  return promise;
}

/** 当前源集合下「真的抓得到内容」的分类；`undefined` 表示还在探测 */
export function useAvailableCategories(): CategoryKey[] | undefined {
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const sources = useMemo(
    () => allSources.filter((s) => selectedKeys.includes(s.key)),
    [allSources, selectedKeys]
  );
  // 签名必须带 url：内置源的 key 是写死的 `builtin_0..3`，导入一份新配置后
  // key 完全不变而地址全换了，只用 key 做签名会命中上一份配置的探测结论。
  const sourceSignature = `${sources
    .map((s) => `${s.key}=${s.url}`)
    .sort()
    .join(',')}|${adultFilter ? 1 : 0}`;

  // 存的是「属于哪个签名」的结果：签名一变就自然失效，不用手动清空
  const [probed, setProbed] = useState<{ signature: string; keys: CategoryKey[] } | undefined>(undefined);

  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    void ensureProbe(sourceSignature, sources, adultFilter).then((keys) => {
      // 卸载了只是不再写回 state，请求本身照常跑完并落盘，下次进来直接命中
      if (cancelled) return;
      setProbed({ signature: sourceSignature, keys });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSignature]);

  if (sources.length === 0) return [];
  // 本轮结果 > 上次落盘的结论 > undefined（探测中，UI 先按全量渲染）
  if (probed?.signature === sourceSignature) return probed.keys;
  return readCachedAvailability(sourceSignature);
}
