import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSeedForTest,
  containsSeed,
  installSeedForTest,
  lookupSeed,
  mergeSeed,
  seedReady,
  seedSize,
} from './seed-titles';

/**
 * 种子表的行为契约。
 *
 * 这里刻意**不**去读仓库里那份 1.8MB 的真实 `seed-titles.txt.gz`：内容会随爬取更新，
 * 断言具体片名会在下次重新生成时变成假失败。真实数据的回归由 `tools/gen-seed-index.mjs`
 * 跑完后的抽样自检负责。
 */
describe('seed-titles', () => {
  afterEach(() => {
    clearSeedForTest();
  });

  it('按拼音首字母前缀查片名', () => {
    installSeedForTest(['奇妙萌可大电影', '奇妙萌可之闪耀流星', '斗罗大陆']);
    expect(lookupSeed('qmmk')).toEqual(['奇妙萌可大电影', '奇妙萌可之闪耀流星']);
    expect(lookupSeed('dldl')).toEqual(['斗罗大陆']);
    // 前缀逐级向下都要能命中（用户是一个字母一个字母敲的）
    expect(lookupSeed('q')).toHaveLength(2);
    expect(lookupSeed('qm')).toHaveLength(2);
  });

  it('查不到时返回空表而不是抛错', () => {
    installSeedForTest(['斗罗大陆']);
    expect(lookupSeed('zzzz')).toEqual([]);
    expect(lookupSeed('')).toEqual([]);
    expect(lookupSeed('   ')).toEqual([]);
  });

  it('limit 生效，避免一次把上万条推给界面', () => {
    installSeedForTest(['奇妙萌可1', '奇妙萌可2', '奇妙萌可3']);
    expect(lookupSeed('qmmk', 2)).toEqual(['奇妙萌可1', '奇妙萌可2']);
  });

  it('中文包含匹配（用户直接打中文时）', () => {
    installSeedForTest(['奇妙萌可大电影', '斗罗大陆']);
    expect(containsSeed('萌可')).toEqual(['奇妙萌可大电影']);
    expect(containsSeed('不存在')).toEqual([]);
  });

  it('未加载时查询是安全的空值，不崩', () => {
    expect(seedReady()).toBe(false);
    expect(seedSize()).toBe(0);
    expect(lookupSeed('qmmk')).toEqual([]);
    expect(containsSeed('奇妙')).toEqual([]);
  });

  it('数字开头的片名照样进前缀表（键盘上有 0-9），纯符号的不进但仍能中文命中', () => {
    // `pinyinInitials('2024春节联欢晚会')` = `2024cjlhwh` —— 数字原样保留，
    // 而键盘本来就有数字行，用户可能直接敲 2024。
    installSeedForTest(['2024春节联欢晚会', '★★★★★']);
    expect(lookupSeed('2024')).toEqual(['2024春节联欢晚会']);
    // 纯符号算不出首字母，不进前缀表；但按中文/原文字符串包含仍能找到
    expect(containsSeed('★')).toEqual(['★★★★★']);
  });

  it('每日增量合并去重，并返回真实新增条数', () => {
    installSeedForTest(['亮剑', '斗罗大陆']);
    // 两条新的 + 一条已有的 + 一条空白：只应新增 2 条
    expect(mergeSeed(['新生片名甲', '新生片名乙', '亮剑', '   '])).toBe(2);
    expect(seedSize()).toBe(4);
    // 同一批再合一次不应再涨：每日增量跑几次不能把内存表撑爆
    expect(mergeSeed(['新生片名甲', '新生片名乙'])).toBe(0);
    expect(seedSize()).toBe(4);
  });

  it('增量里的新片名能被拼音前缀和中文包含两条路找到', () => {
    installSeedForTest(['亮剑']);
    mergeSeed(['庆余年第三季']);
    expect(lookupSeed('qyn')).toEqual(['庆余年第三季']);
    expect(containsSeed('庆余年')).toEqual(['庆余年第三季']);
  });

  it('未就绪时合并是安全的空操作', () => {
    clearSeedForTest();
    expect(mergeSeed(['随便一条'])).toBe(0);
    expect(seedReady()).toBe(false);
  });
});
