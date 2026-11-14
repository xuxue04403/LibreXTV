import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browseCategory,
  groupSearchResults,
  HOME_CATEGORIES,
  type AggregatedGroup,
  type CategoryKey,
  type CategorySourceOutcome,
} from '@librextv/core';
import { http } from '../lib/bridge';
import { cachedItems, rememberItems } from '../lib/catalog-cache';
import { useAppStore } from '../lib/store';
import { useAvailableCategories } from '../lib/category-availability';
import { DetailPanel } from '../components/DetailPanel';
import { HScrollRow } from '../components/HScrollRow';
import { Icon } from '../components/Icons';
import { Poster } from '../components/Poster';
import { useToast } from '../components/toast-context';
import type { WatchTarget } from './Watch';

/** 分类浏览：进入时按当前分类拉取各源内容，可继续滚动加载更多页 */
/**
 * 网格里最多保留多少个卡片。
 *
 * 「加载更多」最多叠 8 页，而每页合并后的条目数没有上限：连点 7 次很容易
 * 让一两千张卡同时挂进 DOM，每张卡都带一张经本地代理加载的海报，
 * 滚动直接掉到个位数帧、内存一路涨。这里给一个硬上限，
 * 到顶就停止续页并明确告诉用户（而不是默默不再加载）。
 */
const MAX_GRID_GROUPS = 480;

export function CategoryPage({
  category,
  onCategoryChange,
  onPlay,
  onOpenSettings,
}: {
  category: CategoryKey;
  onCategoryChange: (next: CategoryKey) => void;
  onPlay: (target: WatchTarget) => void;
  onOpenSettings: () => void;
}) {
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const sources = useMemo(
    () => allSources.filter((s) => selectedKeys.includes(s.key)),
    [allSources, selectedKeys]
  );
  const toast = useToast();

  const [groups, setGroups] = useState<AggregatedGroup[]>([]);
  const [outcomes, setOutcomes] = useState<CategorySourceOutcome[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [selected, setSelected] = useState<AggregatedGroup | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runId = useRef(0);
  // `load` 是 useCallback 且依赖里没有 groups（那会让每次列表变化都重建回调），
  // 但收尾判断「界面还留着内容吗」需要读到最新的值，所以额外存一份 ref。
  const groupsRef = useRef<AggregatedGroup[]>([]);
  groupsRef.current = groups;

  const label = HOME_CATEGORIES.find((c) => c.key === category)?.label ?? '分类';

  // 切换条只列出有内容的分类，与首页一致
  const availableCategories = useAvailableCategories();
  const switchable = useMemo(() => {
    if (!availableCategories) return HOME_CATEGORIES;
    return HOME_CATEGORIES.filter(
      (bucket) => availableCategories.includes(bucket.key) || bucket.key === category
    );
  }, [availableCategories, category]);

  const load = useCallback(
    async (targetPage: number, append: boolean) => {
      if (sources.length === 0) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRun = ++runId.current;

      // 第一页先读本地缓存：切换分类不应该再等各源响应一遍。
      // 缓存只是「先给你内容」，请求照样发，回来后覆盖。
      if (targetPage === 1 && !append) {
        const cached = cachedItems(sources, adultFilter, category);
        if (cached && cached.length > 0) {
          setGroups(groupSearchResults(cached));
          setOutcomes([]);
          setPage(1);
          setHasMore(false);
          setFromCache(true);
        } else {
          setGroups([]);
          setOutcomes([]);
          setPage(1);
          setFromCache(false);
        }
      } else if (!append) {
        setGroups([]);
        setOutcomes([]);
        setPage(1);
      }

      setLoading(true);

      try {
        const result = await browseCategory({
          sources,
          key: category,
          http,
          // 追加模式只抓这一页：以前传 pages=targetPage 会让第 N 页把 1..N 全重下一遍
          pages: 1,
          startPage: targetPage,
          filterAdult: adultFilter,
          timeoutMs: 12_000,
          signal: controller.signal,
          // 边收边渲染：4 个源各回一次，首个源通常 1~3 秒就有内容，
          // 等全部回来才渲染会让用户盯着骨架屏 5 秒以上。
          // 回调给的是「目前为止的全部条目」，直接整体替换，不用自己做增量合并。
          onPartial: (partialItems) => {
            if (myRun !== runId.current || append || partialItems.length === 0) return;
            setGroups(groupSearchResults(partialItems));
            setFromCache(false);
            setLoading(false);
          },
        });
        if (myRun !== runId.current) return;

        // 追加模式：只保留本次新增页的结果，与已有结果合并去重
        const incoming = groupSearchResults(result.items);
        setGroups((prev) => {
          if (append) {
            const map = new Map(prev.map((g) => [g.key, g]));
            for (const group of incoming) {
              const existing = map.get(group.key);
              if (!existing) {
                map.set(group.key, group);
                continue;
              }
              const seen = new Set(existing.items.map((i) => `${i.sourceKey}:${i.vodId}`));
              const merged = [...existing.items];
              for (const item of group.items) {
                if (!seen.has(`${item.sourceKey}:${item.vodId}`)) merged.push(item);
              }
              map.set(group.key, { ...existing, items: merged });
            }
            // 有硬上限才敢无限续页：到顶就截断（新页里多出来的丢掉），
            // 否则连点「加载更多」能把上千张卡片全塞进 DOM。
            return [...map.values()].slice(0, MAX_GRID_GROUPS);
          }
          // 空结果不清屏：磁盘缓存里还有内容，界面上却把 240 条换成空白，
          // 用户再点一次刷新内容又回来，表现成「分类忽有忽无」。
          // 真正该保留的是「上一轮已经显示的东西」，哪怕是缓存。
          return incoming.length === 0 ? prev : incoming.slice(0, MAX_GRID_GROUPS);
        });
        setOutcomes(result.outcomes);
        setPage(targetPage);
        // 内容为空时界面留住的是缓存内容，就别再说「已是最新」：
        // 标题继续标「本地缓存」，用户才知道看到的是上次抓到的结果。
        if (result.items.length > 0) setFromCache(false);
        // 任一源还有下一页就允许继续加载（真正的停止条件在渲染处叠加网格硬上限判断）
        setHasMore(result.outcomes.some((o) => o.supported && o.count > 0) && targetPage < 8);
        // 第一页拿到就落盘：下次切回这个分类是 0 延迟
        if (targetPage === 1 && result.items.length > 0) {
          rememberItems(sources, adultFilter, category, result.items);
        }
        if (result.items.length === 0 && !append) {
          // 界面上还留着上一轮（通常是磁盘缓存）的内容：说「没有内容」会自相矛盾
          const kept = groupsRef.current.length > 0;
          toast.push(
            kept
              ? `「${label}」这次没抓到新内容，先显示上次缓存`
              : `当前源没有返回「${label}」内容`
          );
        }
      } catch (err) {
        // bridge 取消时抛的是 `new Error('请求已取消')`、core 抛 `HttpError(408)`，
        // 都不带 AbortError 名字，所以只能用 signal 自身判断本轮是否已被取消。
        // 旧写法判 DOMException 是死代码：离开页面后照样弹一次红色错误提示。
        const cancelled = controller.signal.aborted;
        if (!cancelled && myRun === runId.current) {
          toast.err(err instanceof Error ? err.message : '加载失败');
        }
      } finally {
        if (myRun === runId.current) setLoading(false);
      }
    },
    [adultFilter, category, label, sources, toast]
  );

  useEffect(() => {
    if (sources.length === 0) return;
    void load(1, false);
    return () => {
      abortRef.current?.abort();
      // 只 abort 不够：abort 后核心抛错，catch 里 `myRun === runId.current` 依然成立，
      // 于是还会向已卸载的组件 setState。自增 runId 才能真正让这一轮失效。
      runId.current += 1;
    };
    // 成人过滤开关必须在这里：它是 load 的入参之一，改了却重载旧结果，
    // 用户会看到「关了过滤但列表里还是那些」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, adultFilter, sources.map((s) => s.key).join(',')]);

  const supported = outcomes.filter((o) => o.supported).length;
  const failed = outcomes.filter((o) => !o.ok);
  // 失败原因必须写出来：只显示「N 个源失败」，用户没法判断是网络、限流还是源站改了地址
  const failureDetail = useMemo(() => {
    const tally = new Map<string, number>();
    for (const outcome of failed) {
      const reason = (outcome.error ?? '失败').replace(/^HTTP\s*/i, 'HTTP ');
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([reason, count]) => (count > 1 ? `${reason}×${count}` : reason))
      .join('、');
  }, [failed]);

  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>
        <span>
          {label}
          <span style={{ color: '#8d97a8', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
            {loading && groups.length === 0
              ? '加载中…'
              : fromCache
                ? `${groups.length} 部（本地缓存，正在刷新）`
                : `${groups.length} 部`}
          </span>
        </span>
        <span className="hint" title={failed.map((o) => `${o.sourceName}：${o.error ?? '失败'}`).join('\n')}>
          {outcomes.length > 0
            ? `${supported} 个源有此分类${failed.length > 0 ? ` · ${failed.length} 个源失败（${failureDetail}）` : ''}`
            : ''}
        </span>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {/* 只列出有内容的分类：与首页保持一致，避免把用户带到空分类页 */}
        {switchable.map((bucket) => (
          <button
            key={bucket.key}
            className={`chip${bucket.key === category ? ' on' : ''}`}
            style={{ cursor: 'pointer', padding: '6px 14px', fontSize: 12.5 }}
            onClick={() => onCategoryChange(bucket.key)}
          >
            {bucket.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn ghost" onClick={() => void load(1, false)} disabled={loading}>
          <Icon name="refresh" size={15} />
          刷新
        </button>
      </div>

      {sources.length === 0 ? (
        <div className="empty">
          <Icon name="film" size={28} />
          <h3>还没有点播源</h3>
          <div style={{ fontSize: 12.5 }}>添加采集站后即可按分类浏览</div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={onOpenSettings}>
            前往设置
          </button>
        </div>
      ) : groups.length > 0 ? (
        <>
          <div className="grid">
            {groups.map((group) => {
              const first = group.items[0];
              return (
                <button key={group.key} className="card" onClick={() => setSelected(group)}>
                  <Poster src={first.pic} alt={group.name} />
                  {group.items.length > 1 ? <span className="badge right">{group.items.length} 个源</span> : null}
                  <div className="card-body">
                    <div className="card-title" title={group.name}>
                      {group.name}
                    </div>
                    <div className="card-meta">
                      {first.typeName ? <span>{first.typeName}</span> : null}
                      {first.year ? <span>· {first.year}</span> : null}
                      {first.remarks ? <span>· {first.remarks}</span> : null}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {hasMore && groups.length < MAX_GRID_GROUPS ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 22 }}>
              <button className="btn" onClick={() => void load(page + 1, true)} disabled={loading}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            </div>
          ) : hasMore ? (
            // 到顶了就别再放个「点了也不会有新内容」的按钮
            <div className="hint" style={{ textAlign: 'center', marginTop: 22 }}>
              已显示 {groups.length} 部，继续浏览请换分类或用搜索
            </div>
          ) : null}
        </>
      ) : loading ? (
        <div className="grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="card" style={{ opacity: 0.35 }}>
              <div className="poster-fallback" />
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <Icon name="film" size={26} />
          <h3>{failed.length === outcomes.length && outcomes.length > 0 ? '所有源都没能返回内容' : '这个分类暂时没有内容'}</h3>
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            {failed.length === outcomes.length && outcomes.length > 0 ? (
              <>
                请求全部失败（{failureDetail}），通常是网络不通或采集站限流。
                <br />
                稍后点「刷新」重试。
              </>
            ) : (
              <>
                各源对分类的命名与编排不同，部分源可能没有「{label}」分类；
                <br />
                也可以直接搜索片名。
              </>
            )}
          </div>
        </div>
      )}

      {selected ? <DetailPanel group={selected} onClose={() => setSelected(null)} onPlay={onPlay} /> : null}
    </>
  );
}

export type { CategoryKey };
/** 供首页复用的分类按钮行：只显示真的抓得到内容的分类 */
export function CategoryButtons({ onSelect }: { onSelect: (key: CategoryKey) => void }) {
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const available = useAvailableCategories();

  if (allSources.length === 0) {
    // 「一个源都没有」和「源没有这个分类」是两件事：前者要去设置里加源，
    // 说成「暂未返回任何分类内容」会把用户引到错误的方向
    return (
      <div className="category-bar">
        <span className="hint">还没有点播源，先在「设置 → 点播源」里添加一个采集站</span>
      </div>
    );
  }

  if (allSources.every((s) => !selectedKeys.includes(s.key))) {
    // 同上：源都在，但全被停用了。这也不是「源没有内容」
    return (
      <div className="category-bar">
        <span className="hint">所有点播源都已停用，在「设置 → 点播源」里打开开关即可</span>
      </div>
    );
  }

  if (available === undefined) {
    // 探测中先摆全部（避免布局跳动），完成后收敛到有内容的那些
    return (
      <HScrollRow fixedItemWidth={false}>
        {HOME_CATEGORIES.map((bucket) => (
          <button key={bucket.key} className="category-btn" onClick={() => onSelect(bucket.key)}>
            <span className="category-dot" />
            {bucket.label}
          </button>
        ))}
      </HScrollRow>
    );
  }

  const shown = HOME_CATEGORIES.filter((b) => available.includes(b.key));
  if (shown.length === 0) {
    return (
      <div className="category-bar">
        <span className="hint">所选源暂未返回任何分类内容，可直接搜索片名</span>
      </div>
    );
  }

  return (
    <HScrollRow fixedItemWidth={false}>
      {shown.map((bucket) => (
        <button key={bucket.key} className="category-btn" onClick={() => onSelect(bucket.key)}>
          <span className="category-dot" />
          {bucket.label}
        </button>
      ))}
    </HScrollRow>
  );
}
