import { describe, expect, it } from 'vitest';
import {
  SOURCE_HEALTH_LADDER_MS,
  SOURCE_HEALTH_PERMANENT,
  SOURCE_HEALTH_STALE_MS,
  clearSourceHealth,
  describeDisabledRemaining,
  describeSourceDisable,
  isSourceDisabled,
  pruneSourceHealth,
  recordSourceFailure,
  recordSourceSuccess,
  type SourceHealthMap,
} from './health';

const NOW = 1_700_000_000_000;

describe('source health 基础状态', () => {
  it('首次失败只累计，不暂停', () => {
    const { entry, event } = recordSourceFailure(undefined, NOW);
    expect(event).toBeNull();
    expect(entry.failStreak).toBe(1);
    expect(entry.disableCount).toBe(0);
    expect(isSourceDisabled(entry, NOW)).toBe(false);
  });

  it('连续第二次失败暂停 30 分钟，并发出事件', () => {
    const first = recordSourceFailure(undefined, NOW).entry;
    const { entry, event } = recordSourceFailure(first, NOW + 1000);
    expect(event).toMatchObject({ level: 1, permanent: false, ttlMs: SOURCE_HEALTH_LADDER_MS[0] });
    expect(entry.disableCount).toBe(1);
    expect(entry.disabledUntil).toBe(NOW + 1000 + SOURCE_HEALTH_LADDER_MS[0]);
    expect(isSourceDisabled(entry, NOW + 1000)).toBe(true);
  });

  it('暂停期内重复失败不重复累计', () => {
    const paused = recordSourceFailure(recordSourceFailure(undefined, NOW).entry, NOW).entry;
    const again = recordSourceFailure(paused, NOW + 1000);
    expect(again.event).toBeNull();
    expect(again.entry).toBe(paused);
  });

  it('暂停到期后从第 1 次重新累计', () => {
    const paused = recordSourceFailure(recordSourceFailure(undefined, NOW).entry, NOW).entry;
    const later = NOW + SOURCE_HEALTH_LADDER_MS[0] + 1;
    const { entry, event } = recordSourceFailure(paused, later);
    expect(event).toBeNull();
    expect(entry.failStreak).toBe(1);
    // 上一级停用等级保留，成功一次才有得降
    expect(entry.disableCount).toBe(1);
    expect(entry.disabledUntil).toBe(0);
  });

  it('第二次暂停 30 分钟，第三次永久', () => {
    const disableOnce = () => recordSourceFailure(recordSourceFailure(undefined, NOW).entry, NOW).entry;

    const first = disableOnce();
    const afterFirst = recordSourceFailure(
      recordSourceFailure(first, NOW + SOURCE_HEALTH_LADDER_MS[0] + 1).entry,
      NOW + SOURCE_HEALTH_LADDER_MS[0] + 2
    );
    expect(afterFirst.event).toMatchObject({ level: 2, permanent: false, ttlMs: SOURCE_HEALTH_LADDER_MS[1] });

    const afterSecond = recordSourceFailure(
      recordSourceFailure(afterFirst.entry, NOW + SOURCE_HEALTH_LADDER_MS[0] + SOURCE_HEALTH_LADDER_MS[1] + 3).entry,
      NOW + SOURCE_HEALTH_LADDER_MS[0] + SOURCE_HEALTH_LADDER_MS[1] + 4
    );
    expect(afterSecond.event).toMatchObject({ level: 3, permanent: true });
    expect(afterSecond.entry.disabledUntil).toBe(SOURCE_HEALTH_PERMANENT);
    expect(isSourceDisabled(afterSecond.entry, NOW + 10 * 365 * 24 * 3600_000)).toBe(true);
  });

  it('成功一次降一级并清掉暂停与连续失败', () => {
    const paused = recordSourceFailure(recordSourceFailure(undefined, NOW).entry, NOW).entry;
    const success = recordSourceSuccess(paused, NOW + 1000);
    expect(success.disableCount).toBe(0);
    expect(success.disabledUntil).toBe(0);
    expect(success.failStreak).toBe(0);
    expect(isSourceDisabled(success, NOW + 1000)).toBe(false);

    const level2 = { failStreak: 0, disableCount: 2, disabledUntil: 0, updatedAt: NOW };
    expect(recordSourceSuccess(level2, NOW).disableCount).toBe(1);
  });
});

describe('source health 清理与提示', () => {
  it('清理 7 天未参与搜索的普通条目，保留永久停用', () => {
    const map: SourceHealthMap = {
      stale: { failStreak: 0, disableCount: 0, disabledUntil: 0, updatedAt: NOW - SOURCE_HEALTH_STALE_MS - 1 },
      fresh: { failStreak: 0, disableCount: 0, disabledUntil: 0, updatedAt: NOW },
      permanent: { failStreak: 0, disableCount: 3, disabledUntil: SOURCE_HEALTH_PERMANENT, updatedAt: NOW - SOURCE_HEALTH_STALE_MS - 1 },
    };
    const pruned = pruneSourceHealth(map, NOW);
    expect(Object.keys(pruned).sort()).toEqual(['fresh', 'permanent']);
    expect(pruneSourceHealth(map, NOW)).not.toBe(map);
  });

  it('仍在暂停期的条目即使 updatedAt 很旧也保留', () => {
    const map: SourceHealthMap = {
      paused: { failStreak: 0, disableCount: 2, disabledUntil: NOW + 3600_000, updatedAt: NOW - SOURCE_HEALTH_STALE_MS - 1 },
    };
    expect(pruneSourceHealth(map, NOW)).toBe(map);
  });

  it('没有可清理项时返回原对象（避免无意义 re-render）', () => {
    const map: SourceHealthMap = {
      fresh: { failStreak: 0, disableCount: 0, disabledUntil: 0, updatedAt: NOW },
    };
    expect(pruneSourceHealth(map, NOW)).toBe(map);
  });

  it('手动恢复直接删除条目', () => {
    const map: SourceHealthMap = {
      a: { failStreak: 1, disableCount: 0, disabledUntil: 0, updatedAt: NOW },
    };
    expect(clearSourceHealth(map, 'a')).toEqual({});
    expect(clearSourceHealth(map, 'missing')).toBe(map);
  });

  it('停用提示文案', () => {
    expect(describeSourceDisable(1)).toContain('30 分钟');
    expect(describeSourceDisable(2)).toContain('30 分钟');
    expect(describeSourceDisable(3)).toContain('永久');
    expect(describeDisabledRemaining(undefined, NOW)).toBe('');
    expect(describeDisabledRemaining({ failStreak: 0, disableCount: 1, disabledUntil: NOW + 5 * 60000, updatedAt: NOW }, NOW)).toBe('剩 5 分钟');
    expect(describeDisabledRemaining({ failStreak: 0, disableCount: 1, disabledUntil: NOW + 2 * 3600_000, updatedAt: NOW }, NOW)).toBe('剩 2 小时');
    expect(describeDisabledRemaining({ failStreak: 0, disableCount: 3, disabledUntil: SOURCE_HEALTH_PERMANENT, updatedAt: NOW }, NOW)).toBe('已暂停');
  });
});
