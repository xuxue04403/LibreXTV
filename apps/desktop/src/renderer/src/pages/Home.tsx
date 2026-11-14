import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildPlaybackCandidates,
  clampEpisodeIndex,
  fetchDetail,
  formatRelativeTime,
  normalizeHistoryEntry,
  type HistoryEntry,
} from '@librextv/core';
import { http } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { Poster } from '../components/Poster';
import { HScrollRow } from '../components/HScrollRow';
import { RecommendSection } from '../components/RecommendSection';
import { useToast } from '../components/toast-context';
import { CategoryButtons, type CategoryKey } from './Category';
import type { WatchTarget } from './Watch';

/**
 * 历史/收藏里只存了单个源，没有聚合结果可用。
 * 这里先给出「只有当前源」的候选链，播放页会按片名在后台补齐其它源。
 */
function soloCandidate(source: { key: string; name: string; url: string; isAdult?: boolean }, vodId: string) {
  return buildPlaybackCandidates(
    [{ sourceKey: source.key, sourceName: source.name, vodId, name: '', sourceUrl: source.url }],
    [source]
  );
}

export function HomePage({
  onPlay,
  onSearch,
  onCategory,
}: {
  onPlay: (target: WatchTarget) => void;
  onSearch: (keyword: string) => void;
  onCategory: (key: CategoryKey) => void;
}) {
  const sources = useAppStore((s) => s.sources);
  const history = useAppStore((s) => s.history);
  const favorites = useAppStore((s) => s.favorites);
  const settings = useAppStore((s) => s.settings);
  const toast = useToast();
  // 用 Set 而不是单个 id：连着点两张卡时，两张都该有转圈，
  // 先完成的那张也不能把后一张的状态抹掉
  const [opening, setOpening] = useState<ReadonlySet<string>>(() => new Set());
  /** 正在取详情的卡片 id：同一张不重复发请求，不同卡片互不影响 */
  const openingRef = useRef<Set<string>>(new Set());
  /**
   * 页面级取消信号：离开首页就 abort。
   *
   * 点历史卡/收藏卡要先取详情，最长 12 秒。这期间用户完全可以按返回、
   * 去搜索或者改设置；旧实现不管这些，详情一回来就无条件调 onPlay，
   * 把界面硬切进播放页——用户正在输入的搜索词、刚翻到的分类全被冲掉。
   * 传 signal 进去，卸载即取消；再补一道 mounted 判断兜住「取消前已返回」的竞态。
   */
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, []);

  const openHistory = useCallback(
    async (entry: HistoryEntry) => {
      const record = normalizeHistoryEntry(entry);
      // 「点了没反应」的根源之一：取详情要串两次请求（接口 + 详情页兜底），
      // 最长能等 20 秒，而卡片只是被 disabled——没有转圈、没有文字变化，
      // 用户看到的就是「点不动」。所以这里既要有可见状态，也要能重复点。
      if (openingRef.current.has(record.id)) return;
      const source = sources.find((s) => s.key === record.sourceKey);
      if (!source) {
        toast.err('该片源已被删除，可在设置里重新添加');
        return;
      }
      openingRef.current.add(record.id);
      setOpening((set) => new Set(set).add(record.id));
      try {
        const detail = await fetchDetail(source, record.vodId, http, {
          timeoutMs: 12_000,
          signal: abortRef.current?.signal,
        });
        // 详情回来时用户可能已经离开首页了：此时不该再把界面切进播放页
        if (!mountedRef.current) return;
        if (detail.episodes.length === 0) {
          toast.err('该片源暂无可用播放地址');
          return;
        }
        // 集数以刚取回来的列表为准：历史里存的可能是另一份列表的长度
        onPlay({
          source,
          vodId: record.vodId,
          title: detail.videoInfo.title ?? record.title,
          year: record.year,
          cover: detail.videoInfo.cover ?? record.cover,
          episodes: detail.episodes,
          startIndex: clampEpisodeIndex(record.episodeIndex, detail.episodes.length),
          candidates: soloCandidate(source, record.vodId),
        });
      } catch (err) {
        toast.err(err instanceof Error ? err.message : '打开失败');
      } finally {
        openingRef.current.delete(record.id);
        // 只去掉自己那一个：同时点开两张卡时，先完成的那张不能把后一张的转圈抹掉
        setOpening((set) => {
          if (!set.has(record.id)) return set;
          const next = new Set(set);
          next.delete(record.id);
          return next;
        });
      }
    },
    [onPlay, sources, toast]
  );

  const playFavorite = useCallback(
    async (fav: { sourceKey: string; vodId: string; title: string; year?: string; cover?: string; id: string }) => {
      if (openingRef.current.has(fav.id)) return;
      const source = sources.find((s) => s.key === fav.sourceKey);
      if (!source) {
        toast.err('该片源已被删除，可在设置里重新添加');
        return;
      }
      openingRef.current.add(fav.id);
      setOpening((set) => new Set(set).add(fav.id));
      try {
        const detail = await fetchDetail(source, fav.vodId, http, {
          timeoutMs: 12_000,
          signal: abortRef.current?.signal,
        });
        if (!mountedRef.current) return;
        if (detail.episodes.length === 0) {
          toast.err('该片源暂无可用播放地址');
          return;
        }
        const saved = useAppStore.getState().history.find((h) => h.id === fav.id);
        onPlay({
          source,
          vodId: fav.vodId,
          title: detail.videoInfo.title ?? fav.title,
          year: fav.year,
          cover: detail.videoInfo.cover ?? fav.cover,
          episodes: detail.episodes,
          startIndex: saved ? clampEpisodeIndex(saved.episodeIndex, detail.episodes.length) : 0,
          candidates: soloCandidate(source, fav.vodId),
        });
      } catch (err) {
        toast.err(err instanceof Error ? err.message : '打开失败');
      } finally {
        openingRef.current.delete(fav.id);
        setOpening((set) => {
          if (!set.has(fav.id)) return set;
          const next = new Set(set);
          next.delete(fav.id);
          return next;
        });
      }
    },
    [onPlay, sources, toast]
  );

  return (
    <>
      {/* 冷启动（没有续播记录）时推荐流置顶：内容发现不该依赖「配了几个源」 */}
      {settings.homeRecommend && history.length === 0 ? (
        <RecommendSection source={settings.recommendSource} onSearch={onSearch} />
      ) : null}

      <div className="section-title">
        <span>按分类浏览</span>
        <span className="hint">只显示所选源有内容的分类</span>
      </div>
      <CategoryButtons onSelect={onCategory} />

      <div className="section-title">
        <span>继续观看</span>
        <span className="hint">{history.length > 0 ? `最近 ${Math.min(history.length, 12)} 条` : ''}</span>
      </div>

      {history.length === 0 ? (
        <div className="empty" style={{ padding: 34 }}>
          <div style={{ fontSize: 12.5 }}>还没有观看记录。搜索影片并播放后，这里会出现续播入口。</div>
        </div>
      ) : (
        <HScrollRow>
          {history.slice(0, 12).map((raw) => {
            const h = normalizeHistoryEntry(raw);
            const progress = h.duration > 0 ? Math.min(100, (h.position / h.duration) * 100) : 0;
            const busy = opening.has(h.id);
            return (
              <button
                key={h.id}
                className={`card${busy ? ' loading' : ''}`}
                onClick={() => void openHistory(h)}
                title={busy ? '正在打开…' : h.title}
              >
                <Poster src={h.cover} alt={h.title} />
                <span className="badge">
                  {busy ? '正在打开…' : `第 ${h.episodeIndex + 1} / ${h.episodeCount > 0 ? h.episodeCount : '?'} 集`}
                </span>
                <div className="card-body">
                  <div className="card-title" title={h.title}>
                    {h.title}
                  </div>
                  <div className="card-meta">
                    <span>{h.sourceName}</span>
                    <span>· {formatRelativeTime(h.updatedAt)}</span>
                  </div>
                  <div className="progress" style={{ height: 4, marginTop: 8, marginBottom: 0, cursor: 'default' }}>
                    <div className="played" style={{ width: `${progress}%` }} />
                  </div>
                </div>
                {busy ? (
                  <div className="card-busy">
                    <div className="spinner" style={{ width: 22, height: 22 }} />
                  </div>
                ) : null}
              </button>
            );
          })}
        </HScrollRow>
      )}

      {/* 有续播记录时推荐位放在「继续观看」之后：先看自己的进度，再看发现 */}
      {settings.homeRecommend && history.length > 0 ? (
        <RecommendSection source={settings.recommendSource} onSearch={onSearch} />
      ) : null}

      <div className="section-title">
        <span>我的收藏</span>
        <span className="hint">{favorites.length} 部</span>
      </div>

      {favorites.length === 0 ? (
        <div className="empty" style={{ padding: 34 }}>
          <div style={{ fontSize: 12.5 }}>在影片详情里点击「收藏」，方便下次直接打开。</div>
        </div>
      ) : (
        <HScrollRow>
          {favorites.slice(0, 18).map((f) => {
            const busy = opening.has(f.id);
            return (
              <button
                key={f.id}
                className={`card${busy ? ' loading' : ''}`}
                onClick={() => void playFavorite(f)}
                title={busy ? '正在打开…' : f.title}
              >
                <Poster src={f.cover} alt={f.title} />
                <div className="card-body">
                  <div className="card-title" title={f.title}>
                    {f.title}
                  </div>
                  <div className="card-meta">
                    {busy ? '正在打开…' : `收藏于 ${formatRelativeTime(f.createdAt)}`}
                  </div>
                </div>
                {busy ? (
                  <div className="card-busy">
                    <div className="spinner" style={{ width: 22, height: 22 }} />
                  </div>
                ) : null}
              </button>
            );
          })}
        </HScrollRow>
      )}
    </>
  );
}
