import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import {
  channelAt,
  collectGroups,
  dedupeChannels,
  filterAdultChannels,
  filterChannels,
  fetchLivePlaylist,
  indexOfChannel,
  stepChannelIndex,
  type LiveChannel,
} from '@librextv/core';
import { http, proxify } from '../lib/bridge';
import { loadChannelEpg } from '../lib/live-epg';
import { flushLiveCacheWrite, liveCacheKey, readLiveCache, writeLiveCache } from '../lib/live-cache';
import { useAppStore } from '../lib/store';
import { Icon } from '../components/Icons';
import { useToast } from '../components/toast-context';

interface ChannelItem extends LiveChannel {
  sourceKey: string;
  sourceName: string;
  epg?: string;
}

interface PlaylistState {
  sourceKey: string;
  sourceName: string;
  ok: boolean;
  pending: boolean;
  channels: number;
  error?: string;
}

/** 频道列表每批挂载的数量，见下方增量揭示的说明 */
const PAGE_SIZE = 240;
// 直播流的 fatal 错误先自救这么多次，超过才把错误显示给用户。
const MAX_RECOVERY = 2;
/**
 * 起播死线。
 *
 * 直播里「点了个台一直转圈」是最高频的抱怨。代理层已经给每一跳加了「等响应头
 * 12 秒」的死线，这里再补一条兜底：15 秒还没出画面就直接给结论，让用户换台，
 * 而不是盯着转圈等下去。这个值要略大于 manifest 死线（8s + 1 次重试 ≈ 16s）
 * 与首片死线（14s），否则会在正常但偏慢的台上误报。
 */
const LIVE_START_TIMEOUT_MS = 15_000;

export function LivePage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const allLiveSources = useAppStore((s) => s.liveSources);
  const liveSelectedKeys = useAppStore((s) => s.liveSelectedKeys);
  const liveSources = useMemo(
    () => allLiveSources.filter((s) => liveSelectedKeys.includes(s.key)),
    [allLiveSources, liveSelectedKeys]
  );
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const toggleLiveFavorite = useAppStore((s) => s.toggleLiveFavorite);
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const toast = useToast();

  const [channels, setChannels] = useState<ChannelItem[]>([]);
  /** 当前频道列表的镜像：load() 是 useCallback，读 state 会拿到过期闭包 */
  const channelsRef = useRef<ChannelItem[]>([]);
  channelsRef.current = channels;
  const [status, setStatus] = useState<PlaylistState[]>([]);
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [progress, setProgress] = useState<{ bytes: number; channels: number } | null>(null);
  const [group, setGroup] = useState('全部');
  const [keyword, setKeyword] = useState('');
  const [playing, setPlaying] = useState<ChannelItem | null>(null);
  const runId = useRef(0);
  /** 当前在跑的这一轮下载；重新加载或卸载时 abort，避免多份全量下载叠加 */
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * 直播列表加载：缓存优先 + 渐进渲染。
   *
   * 实测 iptv-org 的 index.m3u 为 2.46MB、服务器只给 ~35KB/s，整串下载要 70 秒。
   * 原实现是 `Promise.allSettled` 全下完才 setChannels，用户要盯着一分钟空列表。
   * 现在三件事同时做：
   * 1. 先读本地缓存，命中就立刻渲染（进直播页从 70 秒降到 0）；
   * 2. 网络请求走流式，每解析出一批频道就 append（第一批约 1 秒上屏）；
   * 3. 全部完成后落盘，下次直接命中。
   */
  const load = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (liveSources.length === 0) return;
      // 上一轮还没结束就再点「重新加载」/进出页面时，必须真正中断网络与 IPC 流：
      // runId 只能丢弃过期的 setState，播放列表仍会继续下载（每个源 2.5MB+）。
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRun = ++runId.current;
      const cacheKey = liveCacheKey(
        liveSources.map((s) => s.url),
        adultFilter
      );

      const cached = opts.force ? undefined : readLiveCache(cacheKey);
      if (cached && cached.length > 0) {
        // 缓存命中：立刻可交互，后台继续刷新
        setChannels(cached);
        setFromCache(true);
        setLoading(false);
        setProgress(null);
        setStatus(
          liveSources.map((s) => ({
            sourceKey: s.key,
            sourceName: s.name,
            ok: true,
            pending: true,
            channels: cached.filter((c) => c.sourceKey === s.key).length,
          }))
        );
      } else {
        // 刷新失败时不要把已有列表清空：只有「首次加载（当前没有频道）」才清。
        // 旧写法无条件 setChannels([])，用户点「重新加载」后一旦网络失败，
        // 屏幕上原本正常播放的频道全都消失，只剩一句错误提示——比不刷新更糟。
        if (channelsRef.current.length === 0) {
          setChannels([]);
          setFromCache(false);
        }
        setLoading(true);
        setProgress({ bytes: 0, channels: 0 });
        setStatus(
          liveSources.map((s) => ({ sourceKey: s.key, sourceName: s.name, ok: true, pending: true, channels: 0 }))
        );
      }

      // 每个源的累加缓冲：渐进渲染时不断 append，最终再整体去重排序
      const buffers = new Map<string, ChannelItem[]>();
      let downloaded = 0;

      // 缓存命中的频道先塞进缓冲区：万一这次网络彻底失败，也不该把已有列表清空
      if (cached && cached.length > 0) {
        for (const ch of cached) {
          const list = buffers.get(ch.sourceKey) ?? [];
          list.push(ch);
          buffers.set(ch.sourceKey, list);
        }
      }

      const append = (sourceKey: string, items: ChannelItem[]): void => {
        if (items.length === 0 || myRun !== runId.current) return;
        const list = buffers.get(sourceKey) ?? [];
        list.push(...items);
        buffers.set(sourceKey, list);
      };

      let flushTimer: number | undefined;
      // 渐进渲染用的累积数组：只把**新**频道追加进去，不每 120ms 从 buffers
      // 重新拼一遍全量。旧写法每次 flush 都 `for (const list of buffers.values())
      // merged.push(...list)` 造一个新数组再 setChannels，一万多条频道时每 120ms
      // 一次全量拷贝 + 全量重渲染（分组、计数、可见集合全部重算），
      // 低配机器上表现为「滚动直播页一直掉帧」。
      const rendered: ChannelItem[] = [];
      const renderedKeys = new Set<string>();
      const scheduleFlush = (): void => {
        // 缓存已经铺满界面时不做渐进刷新：缓存里本来就是全量列表，
        // 再把流式回来的重复项 append 上去只会让人看到重影。
        if (cached && cached.length > 0) return;
        if (flushTimer !== undefined) return;
        // 120ms 合批：流式回调一次只给几十个频道，全量列表一万多条时
        // 逐次 setState 会让 React 反复重排网格。120ms 既保证首批 1 秒内上屏，
        // 又把一万次回调压到几十次渲染。
        flushTimer = window.setTimeout(() => {
          flushTimer = undefined;
          if (myRun !== runId.current) return;
          let added = false;
          for (const list of buffers.values()) {
            for (const ch of list) {
              const key = `${ch.sourceKey}:${ch.url}`;
              if (renderedKeys.has(key)) continue;
              renderedKeys.add(key);
              rendered.push(ch);
              added = true;
            }
          }
          if (!added && rendered.length === 0) return;
          // 传新数组引用是因为 React 需要引用变化才会重渲染；但内容只多不减，
          // 已挂载的卡片拿到的是同一批对象，React 可以直接跳过它们的子树。
          setChannels([...rendered]);
          setProgress({ bytes: downloaded, channels: rendered.length });
          setLoading(false);
        }, 120);
      };

      const results = await Promise.allSettled(
        liveSources.map(async (source) => {
          const playlist = await fetchLivePlaylist(source.url, http, {
            onChannels: (added, p) => {
              if (myRun !== runId.current) return;
              downloaded = Math.max(downloaded, p.bytes);
              const safe = filterAdultChannels(added, adultFilter).map((ch) => ({
                ...ch,
                sourceKey: source.key,
                sourceName: source.name,
                epg: source.epg,
              }));
              append(source.key, safe);
              scheduleFlush();
            },
            signal: controller.signal,
            timeoutMs: 90_000,
            // 大列表合法地要下很久，只限制「多久没数据」
            idleTimeoutMs: 20_000,
          });
          return { source, playlist };
        })
      );
      if (myRun !== runId.current) return;
      // 被主动中断（重新加载/离开页面）不是失败：不要落盘、不要弹错误
      if (controller.signal.aborted) return;
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);

      const states: PlaylistState[] = [];
      results.forEach((result, i) => {
        const source = liveSources[i];
        if (result.status === 'fulfilled') {
          const { playlist } = result.value;
          const safe = filterAdultChannels(playlist.channels, adultFilter).map((ch) => ({
            ...ch,
            sourceKey: source.key,
            sourceName: source.name,
            epg: source.epg || playlist.epgUrl,
          }));
          buffers.set(source.key, safe);
          states.push({
            sourceKey: source.key,
            sourceName: source.name,
            ok: true,
            pending: false,
            channels: safe.length,
          });
        } else {
          const fallback = buffers.get(source.key)?.length ?? 0;
          states.push({
            sourceKey: source.key,
            sourceName: source.name,
            ok: fallback > 0,
            pending: false,
            channels: fallback,
            error:
              fallback > 0
                ? `下载中断，已显示 ${fallback} 个`
                : result.reason instanceof Error
                  ? result.reason.message
                  : '加载失败',
          });
        }
      });

      const all: ChannelItem[] = [];
      for (const list of buffers.values()) all.push(...list);
      // 先按「源 + 地址」去掉同一源内部的重复，再跨源按台名去重：
      // 两个源都提供 CCTV5 时只留排在前面的那条（源顺序即优先级），
      // 否则列表里会出现几张一模一样的卡片，点哪张都各有一半概率是死台。
      const seenUrl = new Set<string>();
      const deduped = dedupeChannels(
        all.filter((c) => {
          const k = `${c.sourceKey}:${c.url}`;
          if (seenUrl.has(k)) return false;
          seenUrl.add(k);
          return true;
        })
      );

      setChannels(deduped);
      setStatus(states);
      setLoading(false);
      setProgress(null);
      setFromCache(false);

      if (deduped.length > 0) {
        writeLiveCache(cacheKey, deduped, adultFilter);
      } else {
        toast.err('所有直播源都没有解析到频道');
      }
    },
    [liveSources, toast, adultFilter]
  );

  useEffect(() => {
    void load();
    return () => {
      // 离开直播页：中断在跑的下载，别让它们在后台继续吃带宽与 IPC 流
      abortRef.current?.abort();
      abortRef.current = null;
      runId.current += 1;
      // 写缓存被推迟到空闲时，这里补一次同步落盘，避免刚刷新完就退出导致白下
      flushLiveCacheWrite();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSources.map((s) => `${s.key}=${s.url}`).join(','), adultFilter]);

  /** 分组 + 计数一次算完：原来每个分组各 filter 一遍，上千个分组时明显卡 */
  const { groups, counts } = useMemo(() => {
    const tally = new Map<string, number>();
    for (const ch of channels) {
      const g = ch.group || '未分组';
      tally.set(g, (tally.get(g) ?? 0) + 1);
    }
    return { groups: ['全部', ...collectGroups(channels)], counts: tally };
  }, [channels]);

  const visible = useMemo(
    () => filterChannels(channels, { group: group === '全部' ? undefined : group, keyword }),
    [channels, group, keyword]
  );

  /**
   * 增量揭示：一次只挂载 PAGE_SIZE 张卡片，滚到底部再追加。
   *
   * 实测 iptv-org 全球列表有 11485 个频道，全量挂载会产生 9 万多个 DOM 节点，
   * 首屏和滚动都要几百毫秒，遥控器/方向键换台更是明显掉帧。
   * 用 IntersectionObserver 哨兵而不是给 .content 绑 scroll：滚动容器在
   * App 里，Live.tsx 拿不到它的 ref，而 IO 的隐式 root 会自动考虑祖先裁剪。
   */
  const [renderLimit, setRenderLimit] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 换分组/换关键词后回到第一批，否则上一次滚动留下的上限会让人以为列表只有一半
  useEffect(() => {
    setRenderLimit(PAGE_SIZE);
  }, [group, keyword]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setRenderLimit((n) => n + PAGE_SIZE);
      },
      { rootMargin: '800px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [renderLimit, visible]);

  const shown = renderLimit >= visible.length ? visible : visible.slice(0, renderLimit);

  const pendingCount = status.filter((s) => s.pending).length;

  /**
   * 渐进加载时列表在长，但 status 里的数字要到全部下完才更新。
   * 直接用当前 channels 按源统计，源徽章才不会一直显示「0 频道」。
   */
  const liveCounts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const ch of channels) tally.set(ch.sourceKey, (tally.get(ch.sourceKey) ?? 0) + 1);
    return tally;
  }, [channels]);

  const headline = (() => {
    if (loading && channels.length === 0) {
      return progress && progress.bytes > 0
        ? `下载中 ${(progress.bytes / 1024 / 1024).toFixed(2)} MB…`
        : '连接直播源…';
    }
    const base = `${channels.length} 个频道 · ${groups.length - 1} 个分组`;
    if (pendingCount === 0) return base;
    // 还在下：明确说「仍在读取」，否则用户会以为只有这么几个频道
    const suffix =
      progress && progress.bytes > 0
        ? ` · 仍在读取（${(progress.bytes / 1024 / 1024).toFixed(1)} MB）`
        : ' · 仍在读取…';
    // 缓存命中时列表已经是全量旧数据，语义上叫「刷新」而不是「读取」
    return base + (fromCache ? suffix.replace('仍在读取', '后台刷新') : suffix);
  })();

  /** 徽章上的频道数：渐进加载时 status 里还是旧值，用当前列表实时统计 */
  const countOf = (s: PlaylistState): number =>
    s.pending ? (liveCounts.get(s.sourceKey) ?? 0) : s.channels;

  /** 换台：在当前可见列表里循环，过滤后的顺序才是用户预期 */
  const switchChannel = useCallback(
    (direction: 1 | -1) => {
      if (visible.length === 0) return;
      const current = indexOfChannel(visible, playing?.url);
      const next = channelAt(visible, stepChannelIndex(visible.length, current, direction));
      if (next) setPlaying(next);
    },
    [visible, playing?.url]
  );

  if (liveSources.length === 0) {
    return (
      <div className="empty">
        <Icon name="radio" size={30} />
        <h3>还没有直播源</h3>
        <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          在设置中添加 M3U / M3U8 直播订阅地址（可选填 XMLTV 节目单），
          <br />
          或通过数据源订阅一次导入点播源与直播源。
        </div>
        <button className="btn primary" style={{ marginTop: 14 }} onClick={onOpenSettings}>
          前往设置
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="section-title">
        <span>直播频道</span>
        <span className="hint">{headline}</span>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {status.map((s) => (
          <span key={s.sourceKey} className={`chip ${s.pending ? '' : s.ok ? 'ok' : 'err'}`}>
            {s.ok || countOf(s) > 0
              ? `${s.sourceName} · ${countOf(s)} 频道${s.pending ? '…' : ''}`
              : `${s.sourceName} · ${s.error ?? '失败'}`}
          </span>
        ))}
        <button className="btn ghost" onClick={() => void load({ force: true })} disabled={loading}>
          <Icon name="refresh" size={15} />
          重新加载
        </button>
        <input
          className="input"
          style={{ width: 220, marginLeft: 'auto' }}
          placeholder="搜索频道…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      <div className="live-layout">
        <div className="group-list">
          {groups.map((g) => {
            const count = g === '全部' ? channels.length : (counts.get(g) ?? 0);
            return (
              <button key={g} className={`group-item${group === g ? ' active' : ''}`} onClick={() => setGroup(g)}>
                <span>{g}</span>
                <span style={{ color: '#5f6a7c' }}>{count}</span>
              </button>
            );
          })}
        </div>

        <div ref={listRef}>
          {visible.length === 0 ? (
            loading ? (
              <div className="empty" style={{ padding: 32 }}>
                <div className="spinner" style={{ margin: '0 auto 12px' }} />
                <div>正在下载直播列表，频道会陆续出现…</div>
                <div style={{ fontSize: 12, color: '#8d97a8', marginTop: 6 }}>
                  大列表（上万频道）在限速网络上可能需要一两分钟
                </div>
              </div>
            ) : (
              <div className="empty" style={{ padding: 32 }}>
                <div>这个分组下没有匹配的频道</div>
              </div>
            )
          ) : (
            <div className="channel-grid">
              {shown.map((ch) => {
                const fav = liveFavorites.some((f) => f.url === ch.url);
                return (
                  <div
                    key={`${ch.sourceKey}:${ch.url}`}
                    className="channel"
                    role="button"
                    tabIndex={0}
                    onClick={() => setPlaying(ch)}
                  >
                    {ch.logo ? (
                      <img className="logo" src={proxify(ch.logo, { image: true })} alt="" loading="lazy" />
                    ) : (
                      <div className="logo" style={{ display: 'grid', placeItems: 'center', color: '#4a5464' }}>
                        <Icon name="tv" size={16} />
                      </div>
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="ch-name" title={ch.name}>
                        {ch.name}
                      </div>
                      <div className="ch-group">{ch.group || '未分组'}</div>
                    </div>
                    <button
                      className="ctrl"
                      style={{ width: 28, height: 28, color: fav ? '#ff6b3d' : '#5f6a7c' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleLiveFavorite({ url: ch.url, name: ch.name, logo: ch.logo, group: ch.group });
                      }}
                      title={fav ? '取消收藏' : '收藏频道'}
                    >
                      <Icon name="heart" size={14} filled={fav} />
                    </button>
                  </div>
                );
              })}
              {shown.length < visible.length ? (
                <div
                  ref={sentinelRef}
                  style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '14px 0', color: '#8d97a8', fontSize: 12 }}
                >
                  已显示 {shown.length} / {visible.length}，继续滚动加载更多
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {playing ? (
        <LivePlayer
          channel={playing}
          index={indexOfChannel(visible, playing.url)}
          total={visible.length}
          onSwitch={switchChannel}
          onClose={() => setPlaying(null)}
        />
      ) : null}
    </>
  );
}

function LivePlayer({
  channel,
  index,
  total,
  onSwitch,
  onClose,
}: {
  channel: ChannelItem;
  index: number;
  total: number;
  onSwitch: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [epgText, setEpgText] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [switching, setSwitching] = useState(false);

  // EPG 只按频道变化拉一次会把「正在播出」永久定格在第一次的结果上：
  // 用户在一个台上挂半小时，信息条还在显示半小时前的那一期节目。
  // 这里加一个按分钟对齐的定时器，每 60 秒重算一次当前节目；
  // 节目是本地已有数据算出来的（loadChannelEpg 内部按 xmltv 缓存解析结果），
  // 所以这个刷新不打网络。
  useEffect(() => {
    if (!channel.epg || !channel.tvgId) {
      setEpgText(null);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    // 换台/退出就取消下载：一份 XMLTV 动辄几十 MB，用户在这个台上只待两秒
    // 就换走时，不取消的话请求会继续把整个文件下完再解析。
    const controller = new AbortController();

    const refresh = (): void => {
      loadChannelEpg(channel.epg ?? '', channel.tvgId ?? '', controller.signal)
        .then((epg) => {
          if (!alive) return;
          if (!epg.current) {
            setEpgText(null);
            return;
          }
          const end = new Date(epg.current.stop).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          });
          setEpgText(`正在播出：${epg.current.title}（至 ${end}）`);
          // 节目结束时刻前 2 秒再刷：既不空转，也不会让信息条停在上一期
          const wait = Math.min(Math.max(epg.current.stop - Date.now() + 2_000, 20_000), 60_000);
          timer = window.setTimeout(refresh, wait);
        })
        .catch(() => {
          if (!alive) return;
          // 拉取失败（比如 EPG 地址临时不可达）就退化成按 60 秒重试
          timer = window.setTimeout(refresh, 60_000);
        });
    };

    setEpgText(null);
    refresh();
    return () => {
      alive = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [channel.epg, channel.tvgId]);

  /**
   * 上下键换台。
   *
   * 只挂在 window 上、且在播放页挂载期间生效：直播是全屏覆盖层，没有输入框，
   * 不存在和打字冲突的问题。用方向键而不是 Ctrl+数字，是因为 TV 端遥控器就是
   * 上下键，两端操作语义保持一致。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        onSwitch(-1);
      } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        onSwitch(1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'm' || e.key === 'M') {
        const v = videoRef.current;
        if (v) {
          v.muted = !v.muted;
          setMuted(v.muted);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSwitch, onClose]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const url = channel.url;
    const isHls = /\.m3u8(\?|$)/i.test(url);
    const isFlv = /\.flv(\?|$)/i.test(url);
    setLoading(true);
    setError(null);
    setSwitching(false);
    let hls: Hls | null = null;
    let flv: mpegts.Player | null = null;
    // 直播流出现 fatal 错误时先自救若干次，超过才真的报错。
    let recovery = 0;
    // 这一次换台有没有成功出过画面：没出过画面的 fatal 不该自救（见下面的注释）
    let hasPlayed = false;
    // 换台时要立刻断开上一个流：否则旧流会在后台继续占用带宽/解码器
    const startedAt = Date.now();

    if (isFlv) {
      // FLV 是长连接，必须直连（回环代理会缓冲整个响应）
      if (mpegts.isSupported()) {
        flv = mpegts.createPlayer(
          { type: 'flv', url, isLive: true, cors: true },
          { enableStashBuffer: false, liveBufferLatencyChasing: true }
        );
        flv.attachMediaElement(video);
        flv.load();
        void Promise.resolve(flv.play()).catch(() => setError('自动播放被拦截，点击画面继续'));
        flv.on(mpegts.Events.ERROR, () => setError('直播流加载失败（可能不支持跨域）'));
      } else {
        setError('当前环境不支持 FLV 直播');
      }
    } else if (isHls) {
      const src = proxify(url);
      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          // 直播不追低延迟：LL-HLS 的那套「贴着直播边缘播」在普通 IPTV 流上只会
          // 把缓冲压到最小，网络一抖就卡。这里按常规直播走「落后 3 个切片」，
          // 换来的是换台后不容易反复重新缓冲。
          lowLatencyMode: false,
          maxBufferLength: 20,
          maxMaxBufferLength: 40,
          backBufferLength: 10,
          // 起播位置是这次「换台慢」的主因，不是网络：hls.js 默认从直播边缘
          // 往回 liveSyncDurationCount=3 个切片开始播，而 IPTV 的切片普遍
          // 5~10 秒（实测 Anhui TV target=5s、CCTV+ 1 avg=9.77s），也就是
          // 要先攒 15~30 秒的内容才肯出声。改成落后 1 个切片（最多 4 个），
          // 起播只要 1 个切片；落后太多则靠 maxLiveSyncPlaybackRate 追帧。
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 4,
          maxLiveSyncPlaybackRate: 1.5,
          // 首片就算回放缓冲，别死等 minBufferLength 级的数据量
          maxStarvationDelay: 4,
          // 加载死线必须显式设：默认 manifest 10s / frag 20s，再叠加 2 次重试，
          // 一个死台要转半分钟才出结论。直播是「换台」场景，快点失败比多试有用。
          manifestLoadingTimeOut: 8_000,
          levelLoadingTimeOut: 8_000,
          fragLoadingTimeOut: 14_000,
          // 索引只重试 1 次：重试也救不回来的台（403/地区限制/HTML 错误页）早点报
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 1,
          // 分片保留 2 次重试：播放中偶发 404/502 靠它能自愈，不必整路重连
          fragLoadingMaxRetry: 2,
          manifestLoadingRetryDelay: 500,
          fragLoadingRetryDelay: 500,
          // 窗口只有 1080p 时不必去下 4K 码率：省带宽也省起播时间
          capLevelToPlayerSize: true,
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          // 直播流的「致命」错误大多是临时性抖动：单个分片 404、切片 CDN 换节点、
          // 索引重新签名。hls.js 自己重试 2 次仍失败就判 fatal，但接着 startLoad()
          // 往往立刻恢复。先自救，别急着把错误糊到用户脸上。
          //
          // 但**还没出过画面时不要自救**：这是换台场景，用户就等着结论。死台的
          // 每次自救都是又一轮 8~12 秒的等待，用户只能干看着转圈；宁可立刻报错
          // 让他按 ↓ 换下一个（实测死台给结论从 15 秒降到 1~2 秒）。
          if (hasPlayed && recovery < MAX_RECOVERY) {
            recovery += 1;
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
            else hls?.startLoad();
            return;
          }
          setError('直播流加载失败，可能已下线');
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
      } else {
        setError('当前环境不支持 HLS 直播');
      }
    } else {
      video.src = proxify(url);
    }

    const onPlaying = (): void => {
      hasPlayed = true;
      setLoading(false);
      setSwitching(false);
      // 已经在放了，之前报的错就是过期信息：hls.js 对直播流会把「某一分片
      // 404/超时」也报成 fatal（外层再重试就能恢复），如果不清掉，错误浮层会
      // 一直盖在正常画面上——用户看到的是「黑屏 + 加载失败」，实际后台在播。
      setError(null);
    };
    const onWaiting = (): void => {
      // 换台后短时间内不显示 loading，避免闪烁；超过 300ms 才认为真的在等
      if (Date.now() - startedAt > 300) setLoading(true);
    };
    // 看门狗：有些台返回的是 HTML 错误页（不是 404），hls.js 解析失败后既不
    // 触发播放也不一定报 fatal，界面会永远停在「正在连接直播流…」。超过死线
    // 还没画面就直接给结论，让用户按 ↓ 换台，别让人干等。
    const watchdog = window.setTimeout(() => {
      if (video.readyState >= 2 || Date.now() - startedAt < LIVE_START_TIMEOUT_MS) return;
      setLoading(false);
      setError(`这个频道 ${LIVE_START_TIMEOUT_MS / 1000} 秒内没有出画面，可能已下线或被地区限制`);
    }, LIVE_START_TIMEOUT_MS);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    void video.play().catch(() => undefined);

    return () => {
      window.clearTimeout(watchdog);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      hls?.destroy();
      flv?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [channel.url]);

  const switchTo = (direction: 1 | -1): void => {
    if (total <= 1) return;
    // 先给个「正在换台」的即时反馈：网络差的源要几秒才出画面
    setSwitching(true);
    setLoading(true);
    onSwitch(direction);
  };

  return (
    <div className="live-player-wrap">
      <div className="live-bar">
        <button className="ctrl" onClick={onClose} title="返回（Esc）">
          <Icon name="left" size={20} />
        </button>
        <div>
          <div style={{ fontWeight: 600 }}>
            <span className="chip on" style={{ marginRight: 8 }}>
              LIVE
            </span>
            {channel.name}
          </div>
          <div style={{ color: '#a9b3c3', fontSize: 12 }}>
            {epgText ?? `${channel.group || '未分组'} · ${channel.sourceName}`}
          </div>
        </div>
        <div className="spacer" />
        <span style={{ color: '#8d97a8', fontSize: 12 }}>{index >= 0 ? `${index + 1} / ${total}` : ''}</span>
        <button className="ctrl" onClick={() => switchTo(-1)} title="上一个频道（↑）" disabled={total <= 1}>
          <Icon name="left" size={18} />
        </button>
        <button className="ctrl" onClick={() => switchTo(1)} title="下一个频道（↓）" disabled={total <= 1}>
          <Icon name="right" size={18} />
        </button>
        <button className="ctrl" onClick={() => void window.librextv?.toggleFullscreen()} title="全屏">
          <Icon name="maximize" size={18} />
        </button>
      </div>
      <div className="live-stage">
        <video
          ref={videoRef}
          playsInline
          controls={false}
          onClick={(e) => {
            const v = e.currentTarget;
            if (v.paused) void v.play();
            else v.pause();
          }}
        />
        {loading && !error ? (
          <div className="player-loading">
            <div className="spinner" />
            <div>{switching ? '正在换台…' : '正在连接直播流…'}</div>
          </div>
        ) : null}
        {error ? (
          <div className="player-loading">
            <div style={{ textAlign: 'center' }}>
              <div>{error}</div>
              <div style={{ color: '#8d97a8', fontSize: 12, marginTop: 6 }}>
                部分直播源限制 UA/Referer 或已失效，可用 ↑ / ↓ 换其他频道
              </div>
            </div>
          </div>
        ) : null}
        <div className="player-controls" style={{ opacity: 1, position: 'absolute' }}>
          <div className="controls-row">
            <button
              className="ctrl"
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                v.muted = !v.muted;
                setMuted(v.muted);
              }}
            >
              <Icon name={muted ? 'mute' : 'volume'} size={18} />
            </button>
            <span className="chip">直播</span>
            <span className="hint" style={{ marginLeft: 8 }}>
              ↑ / ↓ 换台 · M 静音 · Esc 退出
            </span>
            <div className="spacer" />
            <span style={{ color: '#8d97a8', fontSize: 11 }}>{channel.url.slice(0, 48)}…</span>
          </div>
        </div>
      </div>
    </div>
  );
}
