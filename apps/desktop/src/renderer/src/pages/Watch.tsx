import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  candidateLabel,
  candidateKey,
  clampEpisodeIndex,
  discoverCandidates,
  episodeLabel,
  fetchDetail,
  findSkipTarget,
  formatTime,
  historyId,
  initialStallState,
  nextStallState,
  pickEpisodeIndex,
  skipMarkKey,
  type PlaybackCandidate,
  type SkipMarks,
  type StallState,
} from '@librextv/core';
import { http, prefetchSegments, proxify } from '../lib/bridge';
import { attachVolumeBoost, type VolumeBoostHandle } from '../lib/volume-boost';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/toast-context';
import { CastDialog } from '../components/CastDialog';
import { Icon } from '../components/Icons';

/** 正在播放的源；autoFailover 时播放失败会自动切到 candidates 里的下一个 */
export interface WatchTarget {
  source: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  vodId: string;
  title: string;
  /** 年份：同名不同年的翻拍片靠它区分观看记录 */
  year?: string;
  cover?: string;
  episodes: string[];
  startIndex: number;
  /** 同片源候选链（含当前源，当前源排第一）；缺省时退化为「不自动换源」 */
  candidates?: PlaybackCandidate[];
}

const SKIP_SECONDS = 10;
/** 连按两次「↓」切下一集的判定窗口；再慢就当成两次单独的音量调整 */
const DOUBLE_DOWN_MS = 700;
/** 同一集内允许的自动重试次数（分片抖动通常一次就好，再失败就换源） */
const MAX_RECOVERIES = 2;
/** 同一集内允许的 hls.js 就地媒体恢复次数（recoverMediaError 有内部状态，次数要单独记） */
const MAX_MEDIA_RECOVERIES = 2;
/** 同一集内允许的 hls.js 网络错误就地续传次数（startLoad 比换源便宜得多） */
const MAX_NETWORK_RECOVERIES = 2;
/**
 * 缓冲看门狗的采样间隔（毫秒）。
 *
 * 判定本身交给 core 的 `nextStallState`：跳转中不算卡死，缓冲/位置有进展也不算，
 * 只有「既没跳转又完全没有进展」持续满 `STALL_FATAL_MS` 才换源。
 * 连续快进时会不断 seek，因此这里几乎永远判不到 fatal。
 */
const STALL_POLL_MS = 3_000;
/** 跳转本身卡住的兜底窗口（毫秒）：连 seek 都完不成就说明数据一点都取不到 */
const SEEK_FATAL_MS = 60_000;

export function WatchPage({ target, onClose }: { target: WatchTarget; onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const recordHistory = useAppStore((s) => s.recordHistory);
  const toast = useToast();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  /** 音量增强的 Web Audio 句柄；只随设置开关变化，不参与 hls 重建 */
  const boostRef = useRef<VolumeBoostHandle | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef(0);
  const triedRef = useRef<Set<string>>(new Set());
  /** 本集已尝试恢复的次数（不进 state，避免每次报错都触发重渲染） */
  const recoverRef = useRef(0);
  /** 本集已用掉的 hls.js 就地媒体恢复次数（与整集重载配额分开记） */
  const mediaRecoverRef = useRef(0);
  /** 本集已用掉的 hls.js 网络错误续传次数 */
  const networkRecoverRef = useRef(0);
  /** 缓冲看门狗状态（是否跳转、缓冲有没有前进都在这里判） */
  const stallStateRef = useRef<StallState>(initialStallState);
  /** 「网络较慢，仍在缓冲」这类软提示：只安慰用户，不换源 */
  const [stallHint, setStallHint] = useState<string | null>(null);
  /** 已经发过预取的地址：effect 会因错误恢复重跑，同一条不必再抢一次带宽 */
  const prefetchedRef = useRef<string | null>(null);
  /**
   * 上一次按「↓」的时间戳（ms）。
   *
   * 「↓」本来是调音量，但连按两次在遥控器/键盘上是电视那套「切下一集」的手感，
   * 而桌面上按 N 也能切集却没人知道。窗口内连按两次就切集，单击仍然是音量。
   */
  const lastDownRef = useRef(0);
  /** 是否已经按片名反查过补充候选（只查一次） */
  const discoveredRef = useRef(false);
  /** 进行中的换源任务：同一时刻只跑一轮，避免并发换源互相覆盖状态 */
  const failoverRef = useRef<Promise<boolean> | null>(null);
  /**
   * 组件级取消信号：卸载时 abort。
   *
   * 换源里的 discoverCandidates(≤8s) 与 fetchDetail(≤8s) 是串行两跳，
   * 用户按 Esc 退出后它们还会跑完，然后对着已卸载的组件 setActive/setEpisodes。
   * React 18 不再警告，但请求、解析、内存都白烧；用户马上重进同一部片时
   * 还会多一次重复的上游请求。传同一个 signal 进去，退出即取消。
   *
   * 控制器在 effect 里建：开发期 StrictMode 会「挂载→卸载→再挂载」，
   * 挂在渲染期创建的话第一次卸载就把它 abort 了，重挂载后拿到的仍是已取消的
   * signal，请求会立刻全部失败。
   */
  const abortRef = useRef<AbortController | null>(null);
  const sources = useAppStore((s) => s.sources);
  const updateSkipMarks = useAppStore((s) => s.updateSkipMarks);
  /** 跳过标记按「剧名 + 年份」聚合：换集、换同名片源都复用同一份 */
  const skipKey = skipMarkKey(target.title, target.year);

  /** 当前播放的候选（换源后指向新源） */
  const [active, setActive] = useState<PlaybackCandidate | null>(null);
  const [episodes, setEpisodes] = useState(target.episodes);
  const [index, setIndex] = useState(Math.max(0, Math.min(target.startIndex, target.episodes.length - 1)));
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  /** 倍速的 ref 镜像：媒体加载 effect 不依赖 rate（否则调一次倍速就整集重载），
   * 但 loadedmetadata 回填时要读最新值 */
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  /** 全屏真实状态（ref 供事件回调与卸载清理读取，避免闭包拿到旧值） */
  const fullscreenRef = useRef(false);
  /** 进播放页时窗口是否已经全屏（决定退出时要不要还原） */
  const fullscreenBeforeRef = useRef(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);
  const [failoverNote, setFailoverNote] = useState<string | null>(null);
  // 递增即重载当前集：本集恢复失败后重来一次，而不是干等
  const [reloadToken, setReloadToken] = useState(0);
  /** 自动跳过后给 8 秒撤销窗口 */
  const [skipHint, setSkipHint] = useState<{ label: string; from: number } | null>(null);
  const skipHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Shift+S 记下的中段起点，等 Shift+E 收尾 */
  const midStartRef = useRef<number | null>(null);
  /** 进度条拖拽时挂在 window 上的监听，卸载/退出时要摘掉 */
  const dragRef = useRef<(() => void) | null>(null);
  /** 跳过标记面板（标记列表 / 按剧开关 / 清除） */
  const [skipPanelOpen, setSkipPanelOpen] = useState(false);
  const marks = useAppStore((s) => s.skipMarks[skipKey]);

  /** 候选链：换源时可能按片名反查追加，所以放 state；ref 供回调读取最新值 */
  const [candidates, setCandidates] = useState<PlaybackCandidate[]>(target.candidates ?? []);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const currentSource = active?.source ?? target.source;
  const currentSourceName = active?.sourceName ?? target.source.name;
  const episodeUrl = episodes[index];

  // 首次进入时把当前源记为「已试过」，避免换源又切回刚失败的源
  useEffect(() => {
    triedRef.current.add(candidateKey({ sourceKey: target.source.key, vodId: target.vodId }));
  }, [target.source.key, target.vodId]);

  /**
   * 保存进度（同一影片去重置顶）。
   *
   * `finished = true` 表示这一集看完了：位置写 0、集数推到下一集，
   * 这样首页进度条归零、「继续观看」直接从下一集开始。
   * 不能靠传 0 位置来表达「看完」，那会被位置守卫当成无效写入丢掉。
   */
  const persistProgress = useCallback(
    (position: number, epIndex: number, total: number, finished = false) => {
      if (!settings.resumePlayback) return;
      if (!finished && (!Number.isFinite(position) || position <= 0)) return;
      // 集数必须留在列表范围内：最后一集看完若写成 episodes.length，
      // 首页卡片就会出现「第 17 / 16 集」这种自相矛盾的数字
      const nextIndex = clampEpisodeIndex(finished ? epIndex + 1 : epIndex, episodes.length);
      recordHistory({
        id: historyId(currentSource.key, active?.vodId ?? target.vodId),
        sourceKey: currentSource.key,
        vodId: active?.vodId ?? target.vodId,
        title: target.title,
        year: target.year,
        cover: target.cover,
        sourceName: currentSourceName,
        episodeIndex: nextIndex,
        episodeCount: episodes.length,
        episodeUrl: episodes[nextIndex] ?? episodes[epIndex],
        position: finished ? 0 : position,
        duration: Number.isFinite(total) ? total : 0,
      });
      savedRef.current = finished ? 0 : position;
    },
    [active?.vodId, currentSource, currentSourceName, episodes, recordHistory, settings.resumePlayback, target.cover, target.title, target.vodId, target.year]
  );

  /**
   * 自动换源：把当前集数对齐到下一个候选源，重新加载。
   *
   * 候选链试完之后，只要还有其它源，就按片名反查一轮补充候选
   * （从历史/收藏进来的场景手里只有一个源，不补就无路可走）。
   * 补出来的候选也全部试完才认输，避免无限循环。
   */
  const failover = useCallback(
    (reason: string): Promise<boolean> => {
      // 同一时刻只允许一轮换源：看门狗、hls 致命错误、用户按 S 可能几乎同时触发，
      // 两轮并行会各挑一个候选、互相覆盖 active/episodes，还会同时建两个 Hls 实例。
      if (failoverRef.current) return failoverRef.current;
      const task = (async (): Promise<boolean> => {
      for (;;) {
        const untried = candidatesRef.current.filter((candidate) => !triedRef.current.has(candidateKey(candidate)));
        if (untried.length === 0) {
          // 没有候选可试：必须把错误面板放出来，否则用户只剩黑屏 + 一条
          // 永不消失的「正在切换…」提示，连重试入口都没有（RPL-01）
          if (discoveredRef.current) {
            setFailoverNote(null);
            setLoading(false);
            setError(`${reason}，且没有其它可用片源。可以按 S 手动换源或返回重选。`);
            return false;
          }
          discoveredRef.current = true;
          setFailoverNote(`${reason}，正在查找其它片源…`);
          const extra = await discoverCandidates(target.title, sources, http, {
            exclude: triedRef.current,
            timeoutMs: 8_000,
            signal: abortRef.current?.signal,
          }).catch(() => [] as PlaybackCandidate[]);
          if (extra.length === 0) {
            setFailoverNote(null);
            setLoading(false);
            setError(`${reason}，且没有找到其它片源。可以按 S 手动换源或返回重选。`);
            return false;
          }
          candidatesRef.current = [...candidatesRef.current, ...extra];
          setCandidates(candidatesRef.current);
          continue;
        }

        const next = untried[0];
        triedRef.current.add(candidateKey(next));
        setFailoverNote(`${reason}，正在切换到「${candidateLabel(next)}」…`);
        setError(null);
        setLoading(true);
        try {
          const parsed = await fetchDetail(next.source, next.vodId, http, {
            timeoutMs: 8_000,
            signal: abortRef.current?.signal,
          });
          if (parsed.episodes.length === 0) throw new Error('该源无可用地址');
          setActive(next);
          setEpisodes(parsed.episodes);
          // 用函数式更新读最新集数：await 期间用户可能已切集，
          // 闭包里的 index 是换源开始那一刻的旧值（RPL-02）
          setIndex((cur) => pickEpisodeIndex(cur, parsed.episodes.length));
          setFailoverNote(`已切换到「${candidateLabel(next)}」`);
          setTimeout(() => setFailoverNote(null), 2600);
          return true;
        } catch {
          setLoading(false);
          // 这个源拿不到详情，继续试下一个
        }
      }
      })();
      failoverRef.current = task.finally(() => {
        failoverRef.current = null;
      });
      return failoverRef.current;
    },
    [sources, target.title]
  );

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, []);

  // —— 初始化/切换集数 ——
  // 换集或换源时重置恢复计数；reloadToken 触发的重载不算新尝试
  useEffect(() => {
    recoverRef.current = 0;
    mediaRecoverRef.current = 0;
    networkRecoverRef.current = 0;
  }, [episodeUrl, active]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !episodeUrl) return;
    setError(null);
    setLoading(true);
    setCurrent(0);
    setDuration(0);

    const isHls = /\.m3u8(\?|$)/i.test(episodeUrl);
    const src = proxify(episodeUrl, { ad: settings.adFilter });
    // HLS 起播要串两跳：先等 m3u8，再等首个分片。真流交给 hls.js 之前，
    // 先让主进程把接下来的分片抓进内存缓存，播放器随后直接命中——这是「点开就播」的关键。
    //
    // 同一个地址只预取一次：这个 effect 会因 `reloadToken`（错误恢复）与
    // StrictMode 开发期双跑而重入，重发请求只会在网络本来就不好的时候再抢一次带宽。
    if (isHls && prefetchedRef.current !== episodeUrl) {
      prefetchedRef.current = episodeUrl;
      prefetchSegments(episodeUrl, { ad: settings.adFilter });
    }
    let hls: Hls | null = null;
    let disposed = false;

    /**
     * 出错时先在本集上重载恢复，恢复不了再换源。
     *
     * 必须真的重新加载：hls.js 报出致命网络错误后自身已停止加载，
     * 光把计数加一、弹个提示，是等不到第二个错误事件的，界面会永久卡住。
     */
    const handleFatal = (message: string) => {
      if (disposed) return;
      if (recoverRef.current < MAX_RECOVERIES) {
        recoverRef.current += 1;
        setError(`${message}（第 ${recoverRef.current} 次尝试恢复）`);
        setLoading(true);
        setReloadToken((token) => token + 1);
        return;
      }
      setError(message);
      setLoading(false);
      void failover(message);
    };

    if (isHls) {
      if (Hls.isSupported()) {
        hls = new Hls({
          // 播放更顺的关键：起播只要 2 个分片，往前多看 30 秒
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 30,
          maxMaxBufferLength: 90,
          backBufferLength: 30,
          maxBufferSize: 60 * 1000 * 1000,
          // 分片失败先就地重试几次，再交给换源：连续快进时在途分片会被主动丢弃，
          // 2 次重试、间隔 500ms 太紧，正常源也会被判成网络错误。
          manifestLoadingMaxRetry: 3,
          levelLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 4,
          fragLoadingRetryDelay: 800,
          startLevel: -1,
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          // hls.js 自己主动中止在途加载（快进换位时会大量出现）不是源的问题
          if (data.details === Hls.ErrorDetails.INTERNAL_ABORTED) return;
          // 跳转中报出来的致命网络错误不能算源失效：这时在途分片本来就会被反复
          // 丢弃重取，直接换源等于把能播的源换掉（用户反馈的正是这件事）。改成
          // 就地续传，并且不消耗「本集可续传次数」的配额。
          const seeking = video.seeking;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // 解码类致命错误有官方就地恢复手段 recoverMediaError()：它会在
            // 同一个 Hls 实例上重建 MediaSource 并保留已缓冲的清单与分片。
            // 旧实现调完 recoverMediaError() 又走 handleFatal()，后者会 setReloadToken
            // 重建整个 Hls 实例 —— 刚做的就地恢复立刻被丢掉，还白白消耗了一次
            // 「本集可恢复次数」的配额，多码率源反而更容易被判定为整源失效。
            if (hls && mediaRecoverRef.current < MAX_MEDIA_RECOVERIES) {
              mediaRecoverRef.current += 1;
              try {
                hls.recoverMediaError();
                setError(null);
                setLoading(true);
                return;
              } catch {
                /* 恢复调用本身抛错就走下面的兜底 */
              }
            }
            handleFatal('解码错误');
            return;
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // 致命网络错误通常还能就地救：`startLoad()` 让 hls.js 从当前位置重新
            // 开始取分片，清单、已缓冲内容全部保留。比整集重载便宜，更比换源便宜，
            // 而多数「分片超时」本身只是抖动，重新取就回来了。
            // 跳转中不设次数上限：此时次数容易被连续快进迅速耗光，从而误判整源失效。
            if (hls && (seeking || networkRecoverRef.current < MAX_NETWORK_RECOVERIES)) {
              if (!seeking) networkRecoverRef.current += 1;
              try {
                hls.startLoad();
                setError(null);
                setLoading(true);
                return;
              } catch {
                /* 续传失败就落到换源 */
              }
            }
            handleFatal('网络错误：分片加载失败');
            return;
          }
          handleFatal('播放失败：该片源可能已失效');
        });
        hlsRef.current = hls;
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
      } else {
        setError('当前环境不支持 HLS 播放');
        setLoading(false);
      }
    } else {
      video.src = src;
    }

    // 直链没有 hls.js 的错误事件，靠 video 元素自己的 error 事件触发换源
    const onVideoError = () => {
      if (disposed) return;
      const code = video.error?.code;
      handleFatal(code === MediaError.MEDIA_ERR_DECODE ? '解码错误' : '网络错误：无法加载视频');
    };
    video.addEventListener('error', onVideoError);

    const resume = settings.resumePlayback
      ? useAppStore.getState().history.find((h) => h.id === historyId(currentSource.key, active?.vodId ?? target.vodId))
      : undefined;
    const onLoaded = () => {
      if (disposed) return;
      setLoading(false);
      setDuration(video.duration || 0);
      // 换集/换源后重新挂载媒体，playbackRate 会跟着新元素/新源回到默认值；
      // 这里按用户选的倍速再落一次（default 也写，下次 load 才不会被复位）。
      if (rateRef.current !== 1) {
        video.playbackRate = rateRef.current;
        video.defaultPlaybackRate = rateRef.current;
      }
      // 续播阈值：看到 5 秒以上才续（片头几秒通常只是台标，续了反而奇怪），
      // 离结尾不足 5 秒也不续（那基本已经看完了，再从尾巴播等于直接结束）。
      //
      // 旧条件是 `> 15 && < duration - 15`，两头各留 15 秒：一集 25 秒的短剧
      // 永远落在「不许续」的区间里，把进度丢得干干净净；而片头 10 秒的剧
      // 也永远从头开始。改成固定的 5 秒边界后，长短片都按同一语义处理。
      const resumeFrom = resume && resume.episodeIndex === index ? resume.position : 0;
      const nearEnd = video.duration > 0 && resumeFrom > video.duration - 5;
      if (resumeFrom >= 5 && !nearEnd) {
        video.currentTime = resumeFrom;
        toast.push(`已从 ${formatTime(resumeFrom)} 继续播放`);
      }
      void video.play().catch(() => {
        /* 自动播放被拦截时保留暂停态，用户点击即可 */
      });
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });

    return () => {
      disposed = true;
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onVideoError);
      // 退出/切集前先把进度落盘：紧接着的 pause()/removeAttribute('src')/load()
      // 会把 currentTime 归零，等到别的 cleanup 再读就永远是 0（RPL-04）
      //
      // 但**看完触发的那次 cleanup 必须跳过**：onEnded 已经写过「看完 → 下一集」，
      // 这里再用旧 index 和片尾的 currentTime 写一遍同一条记录（按 id 覆盖），
      // 会把「已完成」改回「第 N 集看到结尾」——首页进度条恒 100%，
      // 点继续观看又从刚看完那集的开头重放。
      if (!video.ended && video.currentTime > 0) persistProgress(video.currentTime, index, video.duration);
      hls?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeUrl, index, settings.adFilter, active, reloadToken]);

  // —— 音量增强 ——
  // 独立于 hls 媒体加载链路：只接管音频，不因开关切换重建播放器。
  // 切集后 currentSrc 会变，等 loadedmetadata 再挂一次（MSE 的 blob 源此时才可用）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const attach = () => {
      if (!settings.volumeBoost) return;
      const handle = attachVolumeBoost(video);
      if (!handle) return;
      boostRef.current = handle;
      handle.setBoost(true);
    };
    attach();
    video.addEventListener('loadedmetadata', attach);
    if (!settings.volumeBoost) boostRef.current?.setBoost(false);
    return () => video.removeEventListener('loadedmetadata', attach);
  }, [settings.volumeBoost, episodeUrl, reloadToken]);

  useEffect(
    () => () => {
      boostRef.current?.dispose();
      boostRef.current = null;
      if (skipHintTimer.current) clearTimeout(skipHintTimer.current);
    },
    [],
  );

  // —— 视频事件 ——
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const showSkipHint = (label: string, from: number) => {
      if (skipHintTimer.current) clearTimeout(skipHintTimer.current);
      setSkipHint({ label, from });
      skipHintTimer.current = setTimeout(() => setSkipHint(null), 8000);
    };
    const onTime = () => {
      setCurrent(video.currentTime);
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
      // 15 秒一次：太久会丢进度，太密会让 zustand persist 反复全量序列化写盘。
      // 暂停/切集/结束/退出都有独立落盘点，这里只是「播放中」的兜底。
      if (Math.abs(video.currentTime - savedRef.current) >= 15) persistProgress(video.currentTime, index, video.duration);
      // 跳过标记：命中片头/中段就 seek 到区间末尾；片尾直接按「看完本集」处理，
      // 这样自动连播与进度落盘的语义和自然播完完全一致。
      if (settings.autoSkip && !video.paused) {
        const marks = useAppStore.getState().skipMarks[skipKey];
        const target = findSkipTarget(marks, video.currentTime, video.duration);
        if (target) {
          const from = video.currentTime;
          if (target.kind === 'outro') {
            video.pause();
            showSkipHint('已跳过片尾', from);
            onEnded();
            return;
          }
          video.currentTime = target.end;
          showSkipHint(target.kind === 'intro' ? '已跳过片头' : '已跳过中段', from);
          return;
        }
      }
    };
    const onPlay = () => setPlaying(true);
    const clearStall = () => {
      if (stallTimer.current) {
        clearTimeout(stallTimer.current);
        stallTimer.current = null;
      }
      stallStateRef.current = initialStallState;
      setStallHint(null);
    };
    /** 已缓冲到的位置；没有缓冲时按当前播放位置算 */
    const bufferedEnd = () =>
      video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0;
    /** 本轮跳转的起点（ms）；0 表示当前没在跳转 */
    let seekSince = 0;
    /**
     * 起一个采样定时器。
     *
     * 判定全部交给 core 的 `nextStallState`：跳转中、或者缓冲/位置有进展，都只
     * 会让它「重新计时」，绝不会换来换源。只有连续 `STALL_FATAL_MS` 毫无进展，
     * 才说明这个源确实什么都取不到。
     */
    const scheduleStallCheck = () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      stallTimer.current = setTimeout(() => {
        stallTimer.current = null;
        const outcome = nextStallState(stallStateRef.current, {
          at: Date.now(),
          currentTime: video.currentTime,
          bufferedEnd: bufferedEnd(),
          seeking: video.seeking,
          paused: video.paused,
        });
        stallStateRef.current = outcome.state;
        switch (outcome.verdict) {
          case 'reset': {
            setStallHint(null);
            // 暂停：没有后续事件可等，停表
            if (video.paused) {
              seekSince = 0;
              return;
            }
            if (video.seeking) {
              if (!seekSince) seekSince = Date.now();
              // 跳转本身也可能是「卡死在跳转中」：数据一个都取不到时 seek 永远
              // 完不成，不会再等到 waiting。这里给一个更长的兜底窗口。
              if (Date.now() - seekSince > SEEK_FATAL_MS) {
                setLoading(false);
                setError('加载超时');
                void failover('跳转后无数据');
                return;
              }
              scheduleStallCheck();
              return;
            }
            seekSince = 0;
            scheduleStallCheck();
            return;
          }
          case 'hint':
            // 只提示，绝不换源：慢不等于源坏了
            setStallHint('网络较慢，仍在缓冲…');
            scheduleStallCheck();
            return;
          case 'fatal':
            // 到这里是真的连续几十秒一个字节都没进来，才认定这个源不可用
            setStallHint(null);
            setLoading(false);
            setError('加载超时');
            void failover('连续无数据');
            return;
          default:
            scheduleStallCheck();
        }
      }, STALL_POLL_MS);
    };
    const onPause = () => {
      setPlaying(false);
      // 暂停后不会再有 playing 事件，卡死定时器必须在这里清掉，
      // 否则「暂停中拖进度条」会被误判成加载超时并自动换源
      clearStall();
      setLoading(false);
      persistProgress(video.currentTime, index, video.duration);
    };
    const onDuration = () => setDuration(video.duration || 0);
    const onEnded = () => {
      setPlaying(false);
      clearStall();
      setLoading(false);
      persistProgress(video.currentTime, index, video.duration, true);
      if (settings.autoplayNext && index + 1 < episodes.length) {
        setIndex((i) => i + 1);
      }
    };
    /**
     * 缓冲中：起看门狗。
     *
     * 旧实现是「buffering 满 12 秒直接换源」，连续快进时必然误判——每次 seek
     * 都会先丢弃在途分片、再按新位置重新取数据，12 秒里没有任何进展完全正常。
     * 现在跳转期间只计时不判死，有进展就重新计时，只有长时间零进展才换源。
     */
    const onWaiting = () => {
      // 暂停时本来就没有数据要等；暂停状态下的 seeking 也会派发 waiting
      if (video.paused) return;
      setLoading(true);
      clearStall();
      scheduleStallCheck();
    };
    const onPlaying = () => {
      setLoading(false);
      clearStall();
      seekSince = 0;
    };
    const onSeeking = () => {
      seekSince = Date.now();
    };
    // 跳转结束：播放器已经按新位置重新取数据，从这里重新开始计时
    const onSeeked = () => {
      seekSince = 0;
      if (video.paused) return;
      setLoading(true);
      clearStall();
      scheduleStallCheck();
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    return () => {
      clearStall();
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('seeked', onSeeked);
    };
  }, [episodes.length, failover, index, persistProgress, settings.autoSkip, settings.autoplayNext, skipKey]);

  // —— 退出时兜底保存进度 ——
  // 正常路径已在上面的播放 effect cleanup 里落盘；这里只兜「组件被卸载但播放
  // effect 没有 cleanup」的极端情况（例如父级整树卸载顺序异常）。
  // 注意不要依赖它读 currentTime：此时 src 可能已被清掉，读到的是 0。
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video && video.currentSrc && video.currentTime > 0) {
        persistProgress(video.currentTime, index, video.duration);
      }
    };
  }, [index, persistProgress]);

  // —— 控制条自动隐藏 ——
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3200);
  }, []);

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [revealControls]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
    revealControls();
  }, [revealControls]);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(video.currentTime + delta, video.duration || 0));
      revealControls();
    },
    [revealControls]
  );

  const changeEpisode = useCallback(
    (next: number) => {
      if (next < 0 || next >= episodes.length) return;
      persistProgress(videoRef.current?.currentTime ?? 0, index, videoRef.current?.duration ?? 0);
      // 换集不算失败：重置已试过的源，让新一集仍可以从当前源开始
      triedRef.current.clear();
      triedRef.current.add(candidateKey({ sourceKey: currentSource.key, vodId: active?.vodId ?? target.vodId }));
      setError(null);
      setIndex(next);
      setDrawerOpen(false);
    },
    [active?.vodId, currentSource.key, episodes.length, index, persistProgress, target.vodId]
  );

  /** 手动换源（用户点错误面板上的按钮，或选集抽屉里的源徽章） */
  const manualSwitch = useCallback(async () => {
    const ok = await failover('手动切换');
    if (!ok) toast.err('已经没有其它可用片源了');
  }, [failover, toast]);

  /** 把窗口全屏切换到指定状态（同时更新 ref / state） */
  const applyFullscreen = useCallback(
    async (value: boolean): Promise<void> => {
      fullscreenRef.current = value;
      setFullscreen(value);
      if (window.librextv) {
        await window.librextv.setFullscreen(value);
        return;
      }
      // 浏览器里预览时的兜底：Electron 走窗口全屏，网页版只能走元素全屏
      try {
        if (value && !document.fullscreenElement) await document.documentElement.requestFullscreen();
        else if (!value && document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // 浏览器拒绝全屏（非用户手势等）时保持原状即可
      }
    },
    []
  );

  const toggleFullscreen = useCallback(async () => {
    await applyFullscreen(!fullscreenRef.current);
  }, [applyFullscreen]);

  // 进播放页先对齐一次真实状态，并订阅主进程回推（F11 / 菜单栏的全屏不经过这里的按钮）
  useEffect(() => {
    let alive = true;
    void window.librextv?.isFullscreen().then((on) => {
      if (!alive) return;
      // 进页面那一刻的状态就是「用户原本的状态」，退出时据此决定要不要还原
      fullscreenBeforeRef.current = on;
      fullscreenRef.current = on;
      setFullscreen(on);
    });
    const off = window.librextv?.onFullscreenChange((on) => {
      fullscreenRef.current = on;
      setFullscreen(on);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // 退出播放页时把窗口还原：全屏通常是在播放页里开的，退出播放还停在满屏
  // 会让人找不到窗口边框（也关不掉），只能在首页再按一次 F11。
  //
  // 但如果进播放页之前窗口就已经全屏（用户自己按 F11 或系统记忆的窗口状态），
  // 那就不是「播放页开的」，不能替他退出去。

  useEffect(
    () => () => {
      // 拖进度条时按 Esc 退出播放页：不摘监听的话这两个 window 监听会永久残留，
      // 闭包还持有整个 Watch 组件树（播放器、HLS 实例都在里面）。
      dragRef.current?.();
    },
    []
  );

  useEffect(
    () => () => {
      if (!fullscreenRef.current || fullscreenBeforeRef.current) return;
      fullscreenRef.current = false;
      if (window.librextv) void window.librextv.setFullscreen(false);
      else if (document.fullscreenElement) void document.exitFullscreen();
    },
    []
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const changeRate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate >= 2 ? 1 : rate + 0.25;
    // 两个都要写：媒体元素的 load 算法会把 playbackRate 复位成 defaultPlaybackRate，
    // 只写 playbackRate 的话换集/换源/错误重建后就会悄悄回到 1×，而按钮还显示旧倍速。
    video.playbackRate = next;
    video.defaultPlaybackRate = next;
    rateRef.current = next;
    setRate(next);
  }, [rate]);

  // —— 键盘快捷键 ——
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入框/滑块里打字时不抢快捷键，但 Esc 要例外：
      // 拖完音量滑块焦点会留在 input 上，那时按 Esc 用户就是想退出播放。
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (inField && e.key !== 'Escape') return;
      // Shift + I/O/S/E 给当前剧打点；带 Shift 时先截走，避免 S 与「手动换源」冲突
      if (e.shiftKey && !e.repeat) {
        const video = videoRef.current;
        if (video) {
          const at = video.currentTime;
          const marks = useAppStore.getState().skipMarks[skipKey];
          if (e.key === 'I' || e.key === 'i') {
            e.preventDefault();
            updateSkipMarks(skipKey, { introEnd: at });
            toast.ok(`片头结束点：${formatTime(at)}`);
            return;
          }
          if (e.key === 'O' || e.key === 'o') {
            e.preventDefault();
            updateSkipMarks(skipKey, { outroStart: at });
            toast.ok(`片尾开始点：${formatTime(at)}`);
            return;
          }
          if (e.key === 'S' || e.key === 's') {
            e.preventDefault();
            midStartRef.current = at;
            toast.push(`中段起点：${formatTime(at)}，再按 Shift+E 收尾`);
            return;
          }
          if (e.key === 'E' || e.key === 'e') {
            e.preventDefault();
            const start = midStartRef.current;
            if (start === null || at - start < 1) {
              toast.err('先按 Shift+S 标记起点（间隔至少 1 秒）');
              return;
            }
            updateSkipMarks(skipKey, { segments: [...(marks?.segments ?? []), { start, end: at }] });
            midStartRef.current = null;
            toast.ok(`中段区间：${formatTime(start)} – ${formatTime(at)}`);
            return;
          }
        }
      }
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seekBy(-SKIP_SECONDS);
          break;
        case 'ArrowRight':
          seekBy(SKIP_SECONDS);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (videoRef.current) {
            videoRef.current.volume = Math.min(1, videoRef.current.volume + 0.1);
            setVolume(videoRef.current.volume);
          }
          break;
        case 'ArrowDown': {
          e.preventDefault();
          // 按住不放时浏览器会连发 keydown（e.repeat === true）：那不是「又按了一次」，
          // 不排掉的话按住 ↓ 会被当成连按，音量没减下去反而一路跳集。
          const now = performance.now();
          if (!e.repeat && lastDownRef.current > 0 && now - lastDownRef.current <= DOUBLE_DOWN_MS) {
            lastDownRef.current = 0;
            changeEpisode(index + 1);
            break;
          }
          if (!e.repeat) lastDownRef.current = now;
          if (videoRef.current) {
            videoRef.current.volume = Math.max(0, videoRef.current.volume - 0.1);
            setVolume(videoRef.current.volume);
          }
          break;
        }
        case 'f':
        case 'F':
          void toggleFullscreen();
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 's':
        case 'S':
          void manualSwitch();
          break;
        case 'Escape':
          // 顺序很重要：弹层先关，再退全屏，最后才退播放页。
          // 以前只看全屏，投屏弹窗/选集抽屉开着时按 Esc 会把整个播放页卸掉，
          // 视频直接中断，用户还得重新搜索再进来。
          if (castOpen) {
            setCastOpen(false);
            break;
          }
          if (skipPanelOpen) {
            setSkipPanelOpen(false);
            break;
          }
          if (drawerOpen) {
            setDrawerOpen(false);
            break;
          }
          // 全屏下按 Esc 的直觉是「退出全屏」，
          // 原来直接关播放页会把窗口留在全屏里。
          if (fullscreenRef.current || document.fullscreenElement) void applyFullscreen(false);
          else onClose();
          break;
        case 'n':
        case 'N':
          changeEpisode(index + 1);
          break;
        default:
          break;
      }
      revealControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyFullscreen, castOpen, changeEpisode, drawerOpen, index, manualSwitch, onClose, revealControls, seekBy, skipKey, skipPanelOpen, toast, toggleFullscreen, toggleMute, togglePlay, updateSkipMarks]);

  const playedPercent = duration > 0 ? (current / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;
  // 拖动进度条时的草稿位置（0~1）：只更新界面，松手才真正 seek 一次
  const shownPercent = dragRatio !== null ? dragRatio * 100 : playedPercent;
  /** 进度条上的跳过区间色带：片头/片尾琥珀色，中段青色 */
  const skipBands = (() => {
    if (!marks || duration <= 0) return [] as { start: number; end: number; kind: string }[];
    const bands: { start: number; end: number; kind: string }[] = [];
    if (marks.introEnd && marks.introEnd > 0) bands.push({ start: 0, end: marks.introEnd, kind: 'intro' });
    for (const segment of marks.segments) bands.push({ start: segment.start, end: segment.end, kind: 'mid' });
    if (marks.outroStart && marks.outroStart < duration) bands.push({ start: marks.outroStart, end: duration, kind: 'outro' });
    return bands;
  })();

  /** 面板里的打点：以当前进度为准 */
  const markNow = (patch: Partial<SkipMarks>) => {
    if (!Number.isFinite(current) || current <= 0) return;
    updateSkipMarks(skipKey, patch);
  };
  const toggleDramaSkip = () => {
    updateSkipMarks(skipKey, { enabled: marks?.enabled === false });
  };
  const clearDramaMarks = () => {
    updateSkipMarks(skipKey, null);
    toast.ok('已清除本剧的跳过标记');
  };

  const seekToRatio = (ratio: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.duration * ratio));
  };

  const remainingCandidates = candidates.filter((candidate) => !triedRef.current.has(candidateKey(candidate))).length;

  return (
    <div
      className="player-page"
      onMouseMove={revealControls}
      onDoubleClick={(event) => {
        // 双击全屏只对画面生效：进度条（用户习惯双击快速定位）、按钮、抽屉里的
        // 双击不该顺带切窗口全屏——那会让布局和控件重新排布。
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, input, .progress, .player-controls, .drawer, .skip-hint, .player-loading')) return;
        void toggleFullscreen();
      }}
    >
      <div className="player-stage">
        <video
          ref={videoRef}
          playsInline
          crossOrigin="anonymous"
          onClick={togglePlay}
          onVolumeChange={(e) => {
            const v = e.currentTarget;
            setVolume(v.volume);
            setMuted(v.muted);
          }}
        />

        {loading && !error && (
          <div className="player-loading">
            <div className="spinner" />
            <div>正在加载 {episodeLabel(index)}…</div>
            {stallHint && <div style={{ marginTop: 8, color: '#8d97a8', fontSize: 12 }}>{stallHint}</div>}
          </div>
        )}
        {failoverNote && (
          <div className="player-loading" style={{ background: 'transparent', pointerEvents: 'none' }}>
            <div className="chip on" style={{ padding: '8px 14px', fontSize: 13 }}>
              {failoverNote}
            </div>
          </div>
        )}
        {error && (
          <div className="player-loading player-error">
            <div style={{ maxWidth: 480, textAlign: 'center', lineHeight: 1.7 }}>
              <div style={{ fontSize: 15, marginBottom: 6 }}>{error}</div>
              <div style={{ color: '#8d97a8', fontSize: 12 }}>
                {remainingCandidates > 0
                  ? `还有 ${remainingCandidates} 个片源可尝试`
                  : '可用片源都试过了，可切换集数或返回列表'}
              </div>
              <div className="row" style={{ justifyContent: 'center', gap: 10, marginTop: 14 }}>
                <button className="btn primary" onClick={() => void manualSwitch()} disabled={remainingCandidates === 0}>
                  换一个片源（S）
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    // 重试等于从头再来：忘了试过哪些源，可重新走一遍候选链。
                    // vodId 必须与换集/换源时的口径一致（active?.vodId ?? target.vodId）：
                    // 换过源之后 currentSource 已是新源，用 target.vodId 记账会写进一个
                    // 不在候选列表里的键，当前源反而仍算「未试」（RPL-12）
                    triedRef.current.clear();
                    triedRef.current.add(
                      candidateKey({ sourceKey: currentSource.key, vodId: active?.vodId ?? target.vodId })
                    );
                    discoveredRef.current = false;
                    recoverRef.current = 0;
                    mediaRecoverRef.current = 0;
                    networkRecoverRef.current = 0;
                    setReloadToken((token) => token + 1);
                  }}
                >
                  重试
                </button>
              </div>
            </div>
          </div>
        )}

        {skipHint && (
          <div className="skip-hint">
            <span>{skipHint.label}</span>
            <button
              className="chip on"
              onClick={() => {
                const video = videoRef.current;
                if (video) video.currentTime = skipHint.from;
                setSkipHint(null);
                toast.push('已回到跳过前的位置');
              }}
            >
              撤销
            </button>
          </div>
        )}

        <div className="player-top" style={{ opacity: controlsVisible ? 1 : 0 }}>
          <button className="ctrl" onClick={onClose} title="返回（Esc）">
            <Icon name="left" size={20} />
          </button>
          <div>
            <div className="player-title">{target.title}</div>
            <div className="player-sub">
              {currentSourceName} · {episodeLabel(index)} · 共 {episodes.length} 集
              {candidates.length > 1 ? ` · ${candidates.length} 个片源` : ''}
            </div>
          </div>
          <div className="spacer" />
          <button className="ctrl" onClick={() => setSkipPanelOpen(true)} title="跳过标记（Shift+I/O/S/E）">
            <Icon name="sliders" size={20} />
          </button>
          <button className="ctrl" onClick={() => setCastOpen(true)} title="投屏到电视（DLNA）">
            <Icon name="tv" size={20} />
          </button>
          <button className="ctrl" onClick={() => setDrawerOpen(true)} title="选集（N 切下一集）">
            <Icon name="list" size={20} />
          </button>
        </div>

        <div className="player-controls" style={{ opacity: controlsVisible ? 1 : 0 }}>
          <div
            className="progress"
            onMouseDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratioAt = (clientX: number) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
              // 拖动中只更新草稿位置，**松手才 seek 一次**。
              // 每帧都写 video.currentTime 会让 hls 不停丢弃在途分片并重新发请求，
              // 松手瞬间压着一串刚中止的请求，「拖完停几秒才出画面」就是这么来的。
              let latest = ratioAt(e.clientX);
              setDragRatio(latest);
              const onMove = (ev: MouseEvent) => {
                latest = ratioAt(ev.clientX);
                setDragRatio(latest);
              };
              const cleanup = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                dragRef.current = null;
              };
              const onUp = () => {
                cleanup();
                seekToRatio(latest);
                setDragRatio(null);
              };
              // 拖到一半被打断（换集/卸载）时不能丢掉草稿态
              dragRef.current?.();
              dragRef.current = () => {
                cleanup();
                setDragRatio(null);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          >
            <div className="buffered" style={{ width: `${bufferedPercent}%` }} />
            <div className="played" style={{ width: `${shownPercent}%` }} />
            {skipBands.map((band, i) => (
              <div
                key={`${band.kind}-${i}`}
                className={`skip-band ${band.kind}`}
                style={{
                  left: `${(band.start / duration) * 100}%`,
                  width: `${Math.max(0.4, ((band.end - band.start) / duration) * 100)}%`,
                }}
              />
            ))}
            <div className="knob" style={{ left: `${shownPercent}%` }} />
          </div>
          <div className="controls-row">
            <button className="ctrl" onClick={togglePlay} title="播放/暂停（空格）">
              <Icon name={playing ? 'pause' : 'play'} size={20} filled={!playing} />
            </button>
            <button className="ctrl" onClick={() => changeEpisode(index - 1)} disabled={index === 0} title="上一集">
              <Icon name="left" size={18} />
            </button>
            <button
              className="ctrl"
              onClick={() => changeEpisode(index + 1)}
              disabled={index + 1 >= episodes.length}
              title="下一集（N 或连按两次 ↓）"
            >
              <Icon name="right" size={18} />
            </button>
            <span className="time">
              {formatTime(current)} / {formatTime(duration)}
            </span>
            <div className="spacer" />
            <button className="ctrl" onClick={toggleMute} title="静音（M）">
              <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={18} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const video = videoRef.current;
                if (!video) return;
                video.volume = Number(e.target.value);
                video.muted = Number(e.target.value) === 0;
              }}
              style={{ width: 92, accentColor: '#ff6b3d' }}
              aria-label="音量"
            />
            <button className="btn ghost" onClick={changeRate} title="倍速">
              {rate.toFixed(2).replace(/0$/, '')}x
            </button>
            <button
              className="ctrl"
              onClick={() => void toggleFullscreen()}
              title={fullscreen ? '退出全屏（F）' : '全屏（F）'}
            >
              <Icon name={fullscreen ? 'minimize' : 'maximize'} size={18} />
            </button>
          </div>
        </div>
      </div>

      {castOpen && episodeUrl ? (
        <CastDialog
          url={episodeUrl}
          title={`${target.title} · ${episodeLabel(index)}`}
          onClose={() => setCastOpen(false)}
          onCast={(deviceName) => toast.ok(`已投屏到「${deviceName}」`)}
        />
      ) : null}

      {drawerOpen && (
        <>
          <div className="drawer-mask" onClick={() => setDrawerOpen(false)} />
          <div className="drawer">
            <div className="drawer-head">
              <div>
                <div style={{ fontWeight: 600 }}>选集</div>
                <div style={{ color: '#8d97a8', fontSize: 12 }}>
                  {currentSourceName} · 共 {episodes.length} 集
                </div>
              </div>
              <button className="ctrl" onClick={() => setDrawerOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            {candidates.length > 1 ? (
              <div className="row" style={{ flexWrap: 'wrap', gap: 8, padding: '0 18px 10px' }}>
                <span style={{ color: '#8d97a8', fontSize: 12 }}>片源</span>
                {candidates.map((candidate) => {
                  const isCurrent = candidateKey(
                    active ?? { sourceKey: target.source.key, vodId: target.vodId }
                  ) === candidateKey(candidate);
                  const tried = triedRef.current.has(candidateKey(candidate));
                  return (
                    <button
                      key={candidateKey(candidate)}
                      className={`chip${isCurrent ? ' on' : ''}`}
                      style={{ cursor: 'pointer', opacity: tried && !isCurrent ? 0.55 : 1 }}
                      title={tried && !isCurrent ? '这一集已经试过，失败了' : '切换到这个片源'}
                      onClick={async () => {
                        if (isCurrent) return;
                        // 带 signal：请求未返回时退出播放页，回调不再 setState 到已卸载的组件
                        const parsed = await fetchDetail(candidate.source, candidate.vodId, http, {
                          timeoutMs: 8_000,
                          signal: abortRef.current?.signal,
                        });
                        if (parsed.episodes.length === 0) {
                          toast.err('该片源暂无可用地址');
                          return;
                        }
                        triedRef.current.delete(candidateKey(candidate));
                        setActive(candidate);
                        setEpisodes(parsed.episodes);
                        setIndex(Math.max(0, Math.min(index, parsed.episodes.length - 1)));
                        setError(null);
                        setDrawerOpen(false);
                      }}
                    >
                      {candidateLabel(candidate)}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="drawer-body">
              <div className="episodes" style={{ maxHeight: 'none' }}>
                {episodes.map((url, i) => (
                  <button
                    key={`${url}-${i}`}
                    className={`ep${i === index ? ' active' : ''}`}
                    onClick={() => changeEpisode(i)}
                  >
                    {episodeLabel(i)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {skipPanelOpen && (
        <>
          <div className="drawer-mask" onClick={() => setSkipPanelOpen(false)} />
          <div className="drawer skip-panel">
            <div className="drawer-head">
              <div>
                <div style={{ fontWeight: 600 }}>跳过标记</div>
                <div style={{ color: '#8d97a8', fontSize: 12 }}>
                  按剧保存，同名各集共用 · Shift+I 片头结束 / Shift+O 片尾开始 / Shift+S+E 中段
                </div>
              </div>
              <button className="ctrl" onClick={() => setSkipPanelOpen(false)} aria-label="关闭">
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="drawer-body">
              <div className="skip-row">
                <div>
                  <div style={{ fontWeight: 600 }}>自动跳过</div>
                  <div style={{ color: '#8d97a8', fontSize: 12 }}>只影响本剧；关闭后保留标记</div>
                </div>
                <button
                  className={`switch${marks?.enabled !== false ? ' on' : ''}`}
                  onClick={toggleDramaSkip}
                  aria-label="自动跳过"
                />
              </div>
              <div className="skip-actions">
                <button className="btn ghost" onClick={() => markNow({ introEnd: current })}>
                  片头结束 {formatTime(current)}
                </button>
                <button className="btn ghost" onClick={() => markNow({ outroStart: current })}>
                  片尾开始 {formatTime(current)}
                </button>
                <button
                  className="btn ghost"
                  onClick={() =>
                    markNow({
                      segments: [
                        ...(marks?.segments ?? []),
                        { start: midStartRef.current ?? current, end: Math.max(current, (midStartRef.current ?? current) + 1) },
                      ],
                    })
                  }
                >
                  记录中段
                </button>
              </div>
              {!marks ? (
                <div style={{ color: '#8d97a8', fontSize: 13, padding: '10px 2px' }}>
                  还没有标记。播放到片头结束处按 Shift+I，或点上面的按钮直接记录。
                </div>
              ) : (
                <div className="skip-list">
                  {typeof marks.introEnd === 'number' && (
                    <div className="skip-item">
                      <span>片头结束 · {formatTime(marks.introEnd)}</span>
                      <button
                        className="ctrl"
                        onClick={() => updateSkipMarks(skipKey, { introEnd: undefined })}
                        aria-label="删除片头标记"
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  )}
                  {typeof marks.outroStart === 'number' && (
                    <div className="skip-item">
                      <span>片尾开始 · {formatTime(marks.outroStart)}</span>
                      <button
                        className="ctrl"
                        onClick={() => updateSkipMarks(skipKey, { outroStart: undefined })}
                        aria-label="删除片尾标记"
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  )}
                  {marks.segments.map((segment, i) => (
                    <div className="skip-item" key={`${segment.start}-${i}`}>
                      <span>
                        中段 {i + 1} · {formatTime(segment.start)} - {formatTime(segment.end)}
                      </span>
                      <button
                        className="ctrl"
                        onClick={() =>
                          updateSkipMarks(skipKey, {
                            segments: marks.segments.filter((_, j) => j !== i),
                          })
                        }
                        aria-label="删除中段标记"
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button className="btn ghost" style={{ marginTop: 10 }} onClick={clearDramaMarks}>
                清除本剧全部标记
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
