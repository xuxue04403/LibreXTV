import { describe, expect, it } from 'vitest';
import {
  initialStallState,
  nextStallState,
  STALL_FATAL_MS,
  STALL_HINT_MS,
  type StallSample,
  type StallState,
} from './stall-watchdog';

/** 造一个采样；默认「正在播放、位置与缓冲都没动」 */
function sample(patch: Partial<StallSample> & { at: number }): StallSample {
  return {
    currentTime: 30,
    bufferedEnd: 60,
    seeking: false,
    paused: false,
    ...patch,
  };
}

/** 按固定间隔喂采样，返回最后一次判定与沿途判定序列 */
function feed(
  samples: StallSample[],
  start: StallState = initialStallState,
  options?: { hintMs?: number; fatalMs?: number }
) {
  let state = start;
  const verdicts: string[] = [];
  for (const s of samples) {
    const out = nextStallState(state, s, options);
    state = out.state;
    verdicts.push(out.verdict);
  }
  return { state, verdicts, last: verdicts[verdicts.length - 1] };
}

/** 生成从 from 到 to（含）每隔 step 毫秒的采样 */
function ticks(from: number, to: number, step: number, patch: (at: number) => Partial<StallSample> = () => ({})) {
  const out: StallSample[] = [];
  for (let at = from; at <= to; at += step) out.push(sample({ at, ...patch(at) }));
  return out;
}

describe('nextStallState', () => {
  it('暂停时计时作废，不会判成卡死', () => {
    const out = nextStallState(initialStallState, sample({ at: 1_000, paused: true }));
    expect(out.verdict).toBe('reset');
    expect(out.state.since).toBeNull();
  });

  it('跳转中计时作废', () => {
    const armed: StallState = { since: 0, mark: { currentTime: 30, bufferedEnd: 60 }, hinted: true };
    const out = nextStallState(armed, sample({ at: 20_000, seeking: true }));
    expect(out.verdict).toBe('reset');
    expect(out.state).toEqual(initialStallState);
  });

  it('连续快进（waiting 与 seeking 交替）永远不会判成卡死', () => {
    // 用户按住方向键：每 2 秒 seek 一次，中间 waiting 挂着
    const events: StallSample[] = [];
    for (let i = 0; i < 60; i++) {
      const at = i * 2_000;
      const seeking = i % 2 === 0;
      events.push(sample({ at, seeking, currentTime: 30 + i * 10, bufferedEnd: 60 }));
    }
    const { verdicts } = feed(events);
    expect(verdicts).not.toContain('fatal');
    expect(verdicts.every((v) => v === 'reset' || v === 'wait')).toBe(true);
  });

  it('起播后一直没有进展，先提示再换源，中间不会提前换', () => {
    const step = 3_000;
    const { verdicts } = feed(ticks(0, STALL_FATAL_MS + step, step));
    expect(verdicts.at(-1)).toBe('fatal');
    // 提示阈值之前必须都是 wait：这段时间换源就是这次要修的 bug
    const hintAt = verdicts.findIndex((v) => v === 'hint');
    expect(hintAt).toBeGreaterThan(0);
    expect(verdicts.slice(0, hintAt).every((v) => v === 'wait')).toBe(true);
    // hint 出现在提示阈值之后、致命阈值之前
    expect(verdicts.indexOf('hint') * step).toBeGreaterThanOrEqual(STALL_HINT_MS);
    expect(verdicts.indexOf('fatal') * step).toBeGreaterThanOrEqual(STALL_FATAL_MS);
  });

  it('缓冲末尾在增长（数据还在来）就不换源，计时重新开始', () => {
    const armed: StallState = { since: 0, mark: { currentTime: 30, bufferedEnd: 60 }, hinted: false };
    // 60 秒里位置不动，但每 3 秒缓冲多 2 秒
    const out = feed(
      ticks(3_000, 60_000, 3_000, (at) => ({ bufferedEnd: 60 + (at / 3_000) * 2 })),
      armed
    );
    expect(out.verdicts).not.toContain('fatal');
    expect(out.state.since).toBe(60_000);
  });

  it('有进展之后从最后一次进展重新计时', () => {
    // 0~30s 毫无进展（已在提示区间），30s 时缓冲动了一下，之后继续不动
    const events = [
      ...ticks(0, 30_000, 3_000),
      sample({ at: 33_000, bufferedEnd: 90 }),
      ...ticks(36_000, 40_000, 3_000),
    ];
    const { state, verdicts } = feed(events);
    expect(verdicts).not.toContain('fatal');
    expect(state.since).toBe(33_000);
  });

  it('致命判定幂等：换个采样继续喂仍然是 fatal，不会退回 wait', () => {
    const armed: StallState = { since: 0, mark: { currentTime: 30, bufferedEnd: 60 }, hinted: true };
    const first = nextStallState(armed, sample({ at: STALL_FATAL_MS }));
    expect(first.verdict).toBe('fatal');
    const again = nextStallState(first.state, sample({ at: STALL_FATAL_MS + 3_000 }));
    expect(again.verdict).toBe('fatal');
  });

  it('阈值可配置，且致命阈值不会小于提示阈值', () => {
    const armed: StallState = { since: 0, mark: { currentTime: 30, bufferedEnd: 60 }, hinted: false };
    const out = nextStallState(armed, sample({ at: 5_000 }), { hintMs: 4_000, fatalMs: 1_000 });
    // fatalMs 被抬到 hintMs：此时既够提示也够致命
    expect(out.verdict).toBe('fatal');
  });

  it('播放进度前进（currentTime 变化）视为有进展', () => {
    const armed: StallState = { since: 0, mark: { currentTime: 30, bufferedEnd: 60 }, hinted: true };
    const out = nextStallState(armed, sample({ at: 40_000, currentTime: 40 }));
    expect(out.verdict).toBe('wait');
    expect(out.state.since).toBe(40_000);
    expect(out.state.hinted).toBe(false);
  });
});
