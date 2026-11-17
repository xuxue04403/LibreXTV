/**
 * 片名索引的后台预热器。
 *
 * 设计要点（与 `catalog-warmer.ts` 同构，但调度更保守）：
 *
 * 1. **只占空闲**：每次只推一轮很小的工作量（`ROUND_BUDGET_PAGES`），跑完就等
 *    `ROUND_INTERVAL_MS` 再来，绝不连续打请求。用户正在别的页面操作时，索引扫描
 *    不该跟分类浏览抢那 12 个全局槽位。
 * 2. **页面隐藏时优先跑**：`visibilitychange` 到 hidden 时反而加快一轮——用户没在看，
 *    正是补历史库的窗口期。
 * 3. **每轮都落盘**：扫完立刻 `writeIndex`，进程被强杀也只丢这一轮。
 * 4. **只扫 `hot`/`deep`**：`sweep` 巡检要等冷区补齐后才排（`planScan` 已经这么排了，
 *    这里不用额外判断），且每 7 天 4 页的开销可以忽略。
 */
import {
  applyScan,
  indexSignature,
  needsWork,
  planBackgroundScan,
  runScan,
  type TitleIndexSnapshot,
} from '@librextv/core';
import { http } from './bridge';
import { readIndex, prepareForWrite, writeIndex } from './title-index-cache';
import { useAppStore } from './store';

/** 每轮最多打多少页（15 个源 × 热区 5 页 = 75 页要分 8 轮左右） */
const ROUND_BUDGET_PAGES = 10;
/** 两轮之间的间隔：给分类浏览/搜索让路 */
const ROUND_INTERVAL_MS = 20_000;
/** 页面隐藏时的间隔（更快推进历史库） */
const HIDDEN_INTERVAL_MS = 5_000;
/** 启动后等多久再开始第一轮（首屏渲染 + 分类预热都先走） */
const BOOT_DELAY_MS = 8_000;
/** 单页超时。索引是后台任务，慢源不值得等太久，失败下轮自然重试 */
const PAGE_TIMEOUT_MS = 10_000;
/**
 * 落盘最小间隔。
 *
 * 传内存里的快照给订阅者是每轮都做的事（UI 要实时），但**写 localStorage 不能每轮都做**：
 * 一轮 10 页大概 20 秒，索引能到 1.5MB，`JSON.stringify` + 同步写盘每 20 秒跑一次，
 * 会在主线程上造成明显卡顿——这正是用户 m00915 说「缓存频率可以不需要那么高」的场景。
 * 所以攒够 3 分钟再落一次；`stopIndexWarmup` 与「活干完了」时强制补一次。
 */
const WRITE_INTERVAL_MS = 3 * 60_000;

interface WarmerState {
  timer: number | null;
  boot: number | null;
  running: boolean;
  stopped: boolean;
  /** 上一轮扫描的取消句柄：`stopIndexWarmup` 时用它掐掉在途请求 */
  inflight: AbortController | null;
  /** 上次落盘时间（0 = 还没写过） */
  writtenAt: number;
  /** 内存里有比磁盘更新的内容（被节流挡住、还没落盘） */
  dirty: boolean;
}

const state: WarmerState = {
  timer: null,
  boot: null,
  running: false,
  stopped: false,
  inflight: null,
  writtenAt: 0,
  dirty: false,
};

const listeners = new Set<(snapshot: TitleIndexSnapshot) => void>();

/** 订阅索引更新（搜索页用它拿实时建议） */
export function subscribeIndex(listener: (snapshot: TitleIndexSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let current: TitleIndexSnapshot | null = null;

/** 当前内存里的索引（首次调用时从 localStorage 读） */
export function currentIndex(): TitleIndexSnapshot {
  if (current) return current;
  const sources = useAppStore.getState().sources;
  const selected = useAppStore.getState().selectedKeys;
  const active = sources.filter((s) => selected.includes(s.key));
  const signature = indexSignature(active, useAppStore.getState().settings.adultFilter);
  current = readIndex(
    signature,
    sources.map((s) => s.key)
  );
  return current;
}

/**
 * 把快照推给订阅者；落盘按 `WRITE_INTERVAL_MS` 节流。
 *
 * `force` 用于「要走了」的时机（页面卸载前、活干完时），宁可多写一次也别丢进度。
 */
function publish(snapshot: TitleIndexSnapshot, force = false): void {
  current = snapshot;
  const now = Date.now();
  if (force || now - state.writtenAt >= WRITE_INTERVAL_MS) {
    // 写盘可能因为配额失败（`writeIndex` 会减半重试后返回 false）。
    // 失败时不能把 `dirty` 清掉、也不能推进 `writtenAt`：否则退出时的 flush()
    // 认为无脏数据、什么都不写，这一轮的索引进度就全丢了（表现为「每次启动都重新预热」）。
    if (writeIndex(prepareForWrite(snapshot))) {
      state.writtenAt = now;
      state.dirty = false;
    } else {
      state.dirty = true;
    }
  } else {
    state.dirty = true;
  }
  for (const fn of listeners) fn(snapshot);
}

/** 补写尚未落盘的最新索引（幂等） */
function flush(): void {
  if (!state.dirty || !current) return;
  if (!writeIndex(prepareForWrite(current))) return; // 留着重试，别假装写完
  state.writtenAt = Date.now();
  state.dirty = false;
}

async function runRound(): Promise<void> {
  if (state.running || state.stopped) return;
  state.running = true;
  try {
    const app = useAppStore.getState();
    const active = app.sources.filter((s) => app.selectedKeys.includes(s.key));
    if (active.length === 0) return;

    const signature = indexSignature(active, app.settings.adultFilter);
    // 用当前内存索引，但签名/源可能已经变了（用户刚删了源）
    let snapshot = currentIndex();
    if (snapshot.signature !== signature) {
      // 签名变了：保留仍有效的条目，只是改用新签名继续（不重扫）
      snapshot = { ...snapshot, signature };
    }

    const tasks = planBackgroundScan(snapshot, active, { budgetPages: ROUND_BUDGET_PAGES });
    if (tasks.length === 0) return;

    // 带 signal：`stopIndexWarmup()` 之后仍在跑的那一轮最多排着 10 页 × 10 秒，
    // 没有取消句柄的话退出播放页、切到别的窗口都还会继续发请求。
    const controller = new AbortController();
    state.inflight = controller;
    const scan = await runScan(tasks, http, {
      timeoutMs: PAGE_TIMEOUT_MS,
      signal: controller.signal,
    });
    // 同上：await 之后写模块级字段是意图所在（清掉本轮句柄），
    // 同一时刻只有一轮在跑（`state.running` 早退保证），不存在并发覆盖。
    // eslint-disable-next-line require-atomic-updates
    state.inflight = null;
    if (controller.signal.aborted) return;
    if (scan.pages === 0) return;
    publish(applyScan(snapshot, scan, Date.now()));
  } catch {
    // 后台任务失败无所谓：下一轮会从同一个游标重试
  } finally {
    // 这是模块级互斥锁，在 await 之后释放正是意图所在；
    // 并发靠入口的 `if (state.running) return` 早退保证，不存在原子性问题。
    // eslint-disable-next-line require-atomic-updates
    state.running = false;
  }
}

function schedule(delay: number): void {
  if (state.stopped) return;
  if (state.timer !== null) window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => {
    state.timer = null;
    void runRound().finally(() => {
      // 还有活就继续排；扫满三档后彻底停下，等下次启动或签名变化
      const app = useAppStore.getState();
      const active = app.sources.filter((s) => app.selectedKeys.includes(s.key));
      if (needsWork(currentIndex(), active)) {
        schedule(document.visibilityState === 'hidden' ? HIDDEN_INTERVAL_MS : ROUND_INTERVAL_MS);
      } else {
        // 干完了：把这轮被节流挡下的最新内容补写一次，然后不再定时唤醒
        flush();
      }
    });
  }, delay);
}

let visibilityBound = false;

/**
 * 启动后台预热。幂等：React 严格模式下 effect 会跑两遍。
 */
export function startIndexWarmup(): void {
  if (state.timer !== null || state.boot !== null) return;
  state.stopped = false;
  state.boot = window.setTimeout(() => {
    state.boot = null;
    // 启动时页面可见 → 慢速（`ROUND_INTERVAL_MS`）；已是后台 → 立刻开跑
    schedule(document.visibilityState === 'hidden' ? 0 : ROUND_INTERVAL_MS);
  }, BOOT_DELAY_MS);

  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // 切到后台正是补历史库的时候：提前一轮
        if (state.timer !== null) {
          window.clearTimeout(state.timer);
          state.timer = null;
          schedule(0);
        }
        // 页面转后台时补写一次，别把进度攒到可能不会发生的下次
        flush();
      }
    });
  }
}

export function stopIndexWarmup(): void {
  state.stopped = true;
  if (state.boot !== null) {
    window.clearTimeout(state.boot);
    state.boot = null;
  }
  if (state.timer !== null) {
    window.clearTimeout(state.timer);
    state.timer = null;
  }
  // 掐掉在途那一轮：否则它还会把排着的十来页逐页发完
  state.inflight?.abort();
  state.inflight = null;
  // 停之前补写：用户可能刚扫完一轮就退出了
  flush();
}

/** 用户手动点「立即更新索引」时用 */
export async function refreshIndexNow(): Promise<void> {
  await runRound();
  flush();
}
