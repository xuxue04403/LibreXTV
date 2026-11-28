import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildPlaybackCandidates,
  clampEpisodeIndex,
  fetchDetail,
  findResumeByTitle,
  historyId,
  type AggregatedGroup,
  type SearchResultItem,
  type SourceConfig,
  type VideoDetail,
} from '@librextv/core';
import { http, qualityCancel, qualityProbe, type QualityProbeResult } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { useToast } from './toast-context';
import { Icon } from './Icons';
import { Poster } from './Poster';
import type { WatchTarget } from '../pages/Watch';

/**
 * 画质探测的编号。
 *
 * 主进程用 `webContents.id:probeId` 做键记住在途的探测，渲染层这边只要保证
 * 同一时刻派出去的编号不重复即可。模块级计数就够了——probeId 只需在
 * 「一个窗口的一次会话」内唯一。
 */
let probeIdSeq = 0;
function nextProbeId(): number {
  probeIdSeq += 1;
  return probeIdSeq;
}

interface ProbeInfo {
  probing: boolean;
  /** 详情接口耗时（同片源横向比较用） */
  speedMs?: number;
  speedError?: string;
  quality?: QualityProbeResult;
}

function probeKeyOf(item: SearchResultItem): string {
  return `${item.sourceKey}:${item.vodId}`;
}

export function DetailPanel({
  group,
  onClose,
  onPlay,
}: {
  group: AggregatedGroup;
  onClose: () => void;
  onPlay: (target: WatchTarget) => void;
}) {
  const sources = useAppStore((s) => s.sources);
  const history = useAppStore((s) => s.history);
  const favorites = useAppStore((s) => s.favorites);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const toast = useToast();

  const [selected, setSelected] = useState<SearchResultItem>(group.items[0]);
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [episodeIndex, setEpisodeIndex] = useState(0);

  /**
   * 同片源测速 + 画质探测。
   *
   * 打开详情时对每个候选源各拉一次详情（顺带测详情接口耗时），再让主进程探画质；
   * 面板关闭即 abort。只测前 8 个源，避免同片几十个源时把源站打爆。
   */
  const [probes, setProbes] = useState<Record<string, ProbeInfo>>({});
  const [probeNonce, setProbeNonce] = useState(0);

  const resolveSource = useCallback(
    (item: SearchResultItem): SourceConfig => {
      const found = sources.find((s) => s.key === item.sourceKey);
      if (found) return found;
      return {
        key: item.sourceKey,
        name: item.sourceName,
        url: item.sourceUrl ?? '',
        isAdult: item.isAdult,
      };
    },
    [sources]
  );

  /** 同片源候选链（用于播放失败时自动换源），当前选中的源排第一 */
  const candidates = useMemo(
    () =>
      buildPlaybackCandidates(group.items, sources, {
        active: { sourceKey: selected.sourceKey, vodId: selected.vodId },
      }),
    [group.items, sources, selected.sourceKey, selected.vodId]
  );

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const items = group.items.slice(0, 8);
    const initial: Record<string, ProbeInfo> = {};
    for (const item of items) initial[probeKeyOf(item)] = { probing: true };
    setProbes(initial);

    const patch = (item: SearchResultItem, part: Partial<ProbeInfo>) => {
      if (!alive) return;
      setProbes((prev) => ({ ...prev, [probeKeyOf(item)]: { ...prev[probeKeyOf(item)], ...part } }));
    };

    const queue = [...items];
    // 本轮派出去、还没回来的探测编号。换片时要把它们逐个取消——
    // 一次探测要抓 m3u8 + 分片前缀 + AES key，最慢能跑十几秒，
    // 光靠 `alive` 丢弃结果，请求本身仍会一直占着连接拖慢后面那一轮。
    const probing = new Set<number>();
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item || !alive) return;
        const source = resolveSource(item);
        if (!source.url) {
          patch(item, { probing: false, speedError: '缺少接口地址' });
          continue;
        }
        const started = performance.now();
        let speedMs: number | undefined;
        let speedError: string | undefined;
        try {
          await fetchDetail(source, item.vodId, http, { timeoutMs: 8000, signal: controller.signal });
          speedMs = Math.round(performance.now() - started);
        } catch (err) {
          if (!alive) return;
          speedError = err instanceof Error ? err.message : '详情获取失败';
        }
        patch(item, { speedMs, speedError });
        if (!alive) return;
        const probeId = nextProbeId();
        probing.add(probeId);
        try {
          const quality = await qualityProbe(source, item.vodId, probeId);
          // 「已取消」是换片导致的，不该显示成探测失败
          if (!alive || quality.error === '已取消') continue;
          patch(item, { quality });
        } catch (err) {
          if (!alive) continue;
          patch(item, {
            quality: {
              ok: false,
              error: err instanceof Error ? err.message : '探测失败',
              retryable: false,
              cached: false,
            },
          });
        } finally {
          probing.delete(probeId);
        }
        if (!alive) return;
        patch(item, { probing: false });
      }
    };
    void Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()));

    return () => {
      alive = false;
      controller.abort();
      for (const id of probing) qualityCancel(id);
      probing.clear();
    };
  }, [group.items, probeNonce, resolveSource]);

  /** 测速成功的排前面，测不出/失败保持原顺序垫底 */
  const orderedItems = useMemo(
    () =>
      group.items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const sa = probes[probeKeyOf(a.item)]?.speedMs ?? Number.POSITIVE_INFINITY;
          const sb = probes[probeKeyOf(b.item)]?.speedMs ?? Number.POSITIVE_INFINITY;
          if (sa !== sb) return sa - sb;
          return a.index - b.index;
        })
        .map(({ item }) => item),
    [group.items, probes]
  );

  useEffect(() => {
    // 关闭按钮上写着「关闭（Esc）」，但这个面板之前没有任何键盘监听：
    // 在首页/分类/搜索里打开详情后按 Esc 毫无反应，用户只能去点右上角的叉。
    // 面板打开时独占键盘（后面的列表页不该同时响应），所以这里直接 preventDefault。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    // 除了 alive 标志，还要真的把在途请求掐掉：换源/关面板时 alive 只让结果不写回，
    // 请求本身仍会跑完（最长 10 秒超时）。用户来回换几个源就是几条并发慢请求，
    // 在弱网下把后点的那个挤在后面，看起来像「换源后选集加载很慢」。
    const controller = new AbortController();
    // 观看记录每 5 秒就会被播放页写一次，放进依赖会导致详情被反复重拉、
    // 同时还把 detail 置空让选集闪一下——这里现取快照，依赖只留「选了哪个源」。
    const { history: historySnapshot } = useAppStore.getState();
    const source = resolveSource(selected);
    if (!source.url) {
      // 早退时必须把上一次的详情一起清掉：面板是按「同一部片换了源」复用的，
      // 不清 detail/loading 就会残留上一部（或上一个源）的选集列表，
      // 用户点「立即播放」用的还是旧 episodes。loading 不清更糟——
      // 面板会一直转圈，而请求根本没发出去。
      setDetail(null);
      setLoading(false);
      setEpisodeIndex(0);
      setError('该来源缺少接口地址，无法获取详情');
      return;
    }
    setLoading(true);
    setError(null);
    setDetail(null);
    fetchDetail(source, selected.vodId, http, { signal: controller.signal })
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        const resume =
          historySnapshot.find((h) => h.id === historyId(source.key, selected.vodId)) ??
          findResumeByTitle(historySnapshot, selected.name, selected.year);
        setEpisodeIndex(resume ? clampEpisodeIndex(resume.episodeIndex, d.episodes.length) : 0);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // 主动取消不是失败，不要拿它去覆盖错误区
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : '获取详情失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [resolveSource, selected]);

  const favId = `${selected.sourceKey}:${selected.vodId}`;
  const isFav = favorites.some((f) => f.id === favId);
  const resume =
    history.find((h) => h.id === historyId(selected.sourceKey, selected.vodId)) ??
    findResumeByTitle(history, selected.name, selected.year);
  // 按钮文案必须跟着「实际要播的那一集」走。
  // 原来写的是 `resume.episodeIndex + 1`，而点击时播的是 `episodeIndex`（用户刚点的选集），
  // 于是出现「按钮写着继续第 15 集、点下去从第 2 集开始」这种自相矛盾的观感。
  const resumeLabel = resume ? `继续播放 · 第 ${episodeIndex + 1} 集` : '立即播放';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <Poster src={detail?.videoInfo.cover ?? selected.pic} alt={selected.name} className="detail-cover" />
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="chip on">{selected.sourceName}</span>
              {selected.typeName ? <span className="chip">{selected.typeName}</span> : null}
              {selected.year ? <span className="chip">{selected.year}</span> : null}
              {selected.area ? <span className="chip">{selected.area}</span> : null}
              <span className="spacer" />
              <button className="ctrl" onClick={onClose} title="关闭（Esc）">
                <Icon name="x" />
              </button>
            </div>
            <h2>{detail?.videoInfo.title ?? selected.name}</h2>
            {selected.remarks ? (
              <div style={{ color: '#ffb59c', fontSize: 12.5, marginBottom: 8 }}>{selected.remarks}</div>
            ) : null}
            <div className="row" style={{ marginBottom: 10 }}>
              <button
                className="btn primary"
                disabled={!detail || detail.episodes.length === 0}
                onClick={() => {
                  // 换源瞬间 detail 可能还是上一部片的：按钮的 disabled 已挡住，
                  // 这里再兜一次，绝不用旧 episodes 起播
                  if (!detail || detail.episodes.length === 0) return;
                  onPlay({
                    source: resolveSource(selected),
                    vodId: selected.vodId,
                    title: detail.videoInfo.title ?? selected.name,
                    cover: detail.videoInfo.cover ?? selected.pic,
                    episodes: detail.episodes,
                    startIndex: episodeIndex,
                    candidates,
                  });
                }}
              >
                <Icon name="play" size={16} filled />
                {resumeLabel}
              </button>
              <button
                className="btn"
                onClick={() => {
                  toggleFavorite({
                    id: favId,
                    sourceKey: selected.sourceKey,
                    vodId: selected.vodId,
                    title: selected.name,
                    year: selected.year,
                    cover: selected.pic,
                  });
                  toast.push(isFav ? '已取消收藏' : '已加入收藏');
                }}
              >
                <Icon name="heart" size={16} filled={isFav} />
                {isFav ? '已收藏' : '收藏'}
              </button>
              {detail && detail.episodes.length > 1 ? (
                <span className="chip">共 {detail.episodes.length} 集</span>
              ) : null}
            </div>
            <div className="desc">
              {detail?.videoInfo.desc?.replace(/<[^>]+>/g, ' ').trim() || '暂无简介'}
            </div>
            {detail?.videoInfo.actor ? (
              <div style={{ color: '#8d97a8', fontSize: 12, marginTop: 8 }}>
                主演：{detail.videoInfo.actor}
              </div>
            ) : null}
          </div>
        </div>

        <div className="source-row">
          <span style={{ color: '#8d97a8', fontSize: 12, alignSelf: 'center' }}>
            同片源（{group.items.length}）：
          </span>
          {orderedItems.map((item) => {
            const info = probes[probeKeyOf(item)];
            const isCurrent = item.sourceKey === selected.sourceKey && item.vodId === selected.vodId;
            const q = info?.quality;
            const qKind = !q || !q.ok ? 'failed' : q.label ? 'value' : q.error ? 'failed' : 'unknown';
            const qText = q ? (q.label ?? (q.error ? '未测到' : '未知')) : '';
            const qTitle = q
              ? q.label
                ? `画质 ${q.label}${q.cached ? '（缓存）' : ''}`
                : q.error
                  ? `探测失败：${q.error}`
                  : '播放列表与分片里没有画质信息，播放后会记录实测分辨率'
              : '';
            return (
              <button
                key={`${item.sourceKey}:${item.vodId}`}
                className={`chip${isCurrent ? ' on' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelected(item)}
                title={item.sourceUrl}
              >
                {item.sourceName}
                {isCurrent ? (
                  <span className="q-meta">当前</span>
                ) : info?.speedMs !== undefined ? (
                  <span className="q-meta">{info.speedMs}ms</span>
                ) : info?.speedError ? (
                  <span className="q-meta muted">测速失败</span>
                ) : null}
                {info?.probing ? (
                  <span className="q-badge unknown">探测中</span>
                ) : q ? (
                  <span className={`q-badge ${qKind}`} title={qTitle}>
                    {qText}
                    {q.reason ? `·${q.reason}` : ''}
                  </span>
                ) : null}
              </button>
            );
          })}
          <button
            className="btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => {
              setProbes({});
              setProbeNonce((n) => n + 1);
            }}
            title="重新测速并重新探测画质"
          >
            重新测速
          </button>
        </div>

        <div className="section-title" style={{ marginTop: 14 }}>
          <span>选集</span>
          <span className="hint">{loading ? '加载中…' : `${detail?.episodes.length ?? 0} 集`}</span>
        </div>

        {error ? (
          <div className="empty" style={{ padding: 24 }}>
            <div style={{ color: '#ffc9ca' }}>{error}</div>
            <div style={{ fontSize: 12, marginTop: 6 }}>换一个来源试试</div>
          </div>
        ) : (
          <div className="episodes">
            {(detail?.episodes ?? []).map((url, i) => (
              <button
                key={`${url}-${i}`}
                className={`ep${i === episodeIndex ? ' active' : ''}`}
                onClick={() => setEpisodeIndex(i)}
                onDoubleClick={() => {
                  if (!detail) return;
                  onPlay({
                    source: resolveSource(selected),
                    vodId: selected.vodId,
                    title: detail.videoInfo.title ?? selected.name,
                    cover: detail.videoInfo.cover ?? selected.pic,
                    episodes: detail.episodes,
                    startIndex: i,
                    candidates,
                  });
                }}
                title={url}
              >
                第 {i + 1} 集
              </button>
            ))}
            {!loading && (detail?.episodes.length ?? 0) === 0 ? (
              <span style={{ color: '#8d97a8', fontSize: 12 }}>该源没有解析到可播放地址</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
