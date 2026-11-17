/**
 * 缓冲看门狗：判断「播放器卡住了」到底该不该换源。
 *
 * 起因：连续快进时播放器会不停丢弃在途分片、按新位置重新取数据，`waiting`
 * 事件会反复触发。旧实现只要 buffering 满 12 秒就立刻换源，于是「源明明还能
 * 正常加载」也被判死——用户连着按十几次方向键，最后那条数据还没到就被换走了。
 *
 * 这里把「卡住」的判据收窄成两件事：
 *
 * 1. **跳转中不算**。seek 期间播放器本来就没有可用数据，没有任何进展是正常的。
 * 2. **有进展就不算**。片头位置前移、缓冲末尾增长，都说明数据还在来——慢不是死。
 *
 * 只有「既没跳转、又完全没有进展」持续到 `fatalMs`，才认定这个源真的加载不出来。
 * 到这里之前最多只出提示（`hint`），不换源。
 */

/** 连续多久没有进展就开始提示「网络较慢」（毫秒） */
export const STALL_HINT_MS = 12_000;
/** 连续多久一次进展都没有，才认定源确实加载不出来（毫秒） */
export const STALL_FATAL_MS = 45_000;

export interface StallSample {
  /** 采样时间，单调递增即可（performance.now / Date.now 同一来源） */
  at: number;
  /** 播放位置（秒） */
  currentTime: number;
  /** 已缓冲到的位置（秒）；没有缓冲时为 0 */
  bufferedEnd: number;
  /** 是否正在跳转 */
  seeking: boolean;
  /** 是否处于暂停状态 */
  paused: boolean;
}

export interface StallState {
  /** 本轮「毫无进展」的起点；null 表示尚未进入卡死候选状态 */
  since: number | null;
  /** 上一次判定为「有进展」时的基准快照 */
  mark: { currentTime: number; bufferedEnd: number } | null;
  /** 是否已经提示过「网络较慢」 */
  hinted: boolean;
}

export type StallVerdict =
  /** 暂停或跳转：本次计时作废，调用方应清掉定时器 */
  | 'reset'
  /** 还在等，继续观察 */
  | 'wait'
  /** 已经等太久，提示用户「仍在缓冲」，但仍然不换源 */
  | 'hint'
  /** 持续毫无进展，可以换源了 */
  | 'fatal';

export const initialStallState: StallState = Object.freeze({ since: null, mark: null, hinted: false });

export interface StallOptions {
  hintMs?: number;
  fatalMs?: number;
}

/**
 * 纯函数：喂一个采样，得到新的状态与判定。
 *
 * 调用方按固定间隔（例如 3 秒）采样即可；`hint`/`fatal` 都是幂等的，
 * 重复采样不会把状态改回去。
 */
export function nextStallState(
  state: StallState,
  sample: StallSample,
  options: StallOptions = {}
): { state: StallState; verdict: StallVerdict } {
  const hintMs = Math.max(0, options.hintMs ?? STALL_HINT_MS);
  // 致命阈值不得小于提示阈值，否则配置写反会出现「先换源再提示」
  const fatalMs = Math.max(hintMs, options.fatalMs ?? STALL_FATAL_MS);

  if (sample.paused || sample.seeking) {
    return { state: initialStallState, verdict: 'reset' };
  }

  const mark = state.mark;
  // 缓冲末尾只认「往后长」：seek 后回退缓冲、或播放器回收了 back buffer，
  // 都会让 bufferedEnd 变小，那不是进展。
  const progressed =
    mark !== null && (sample.currentTime !== mark.currentTime || sample.bufferedEnd > mark.bufferedEnd);

  if (state.since === null || progressed) {
    return {
      state: {
        since: sample.at,
        mark: { currentTime: sample.currentTime, bufferedEnd: sample.bufferedEnd },
        hinted: false,
      },
      verdict: 'wait',
    };
  }

  const waited = Math.max(0, sample.at - state.since);
  if (waited >= fatalMs) {
    return { state, verdict: 'fatal' };
  }
  if (waited >= hintMs) {
    return { state: state.hinted ? state : { ...state, hinted: true }, verdict: 'hint' };
  }
  return { state, verdict: 'wait' };
}
