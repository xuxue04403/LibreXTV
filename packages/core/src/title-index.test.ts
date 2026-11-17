import { describe, expect, it } from 'vitest';
import type { SearchResultItem, SourceConfig } from './types';
import {
  INDEX_DEEP_TARGET_PAGES,
  INDEX_HOT_PAGES,
  INDEX_HOT_TTL_MS,
  INDEX_SWEEP_INTERVAL_MS,
  INDEX_SWEEP_PAGES,
  allEntries,
  applyScan,
  deepProgress,
  emptyIndex,
  indexSignature,
  isIndexUsable,
  mergeEntries,
  needsWork,
  normalizeQuery,
  planScan,
  pruneIndex,
  remotePinyinSearch,
  remotePinyinSources,
  suggestFromIndex,
  suggestionToItems,
  toIndexEntry,
  type TitleIndexEntry,
} from './title-index';

const sources: SourceConfig[] = [
  { key: 'builtin_0', name: '非凡资源', url: 'https://cj.ffzyapi.com/api.php/provide/vod' },
  { key: 'builtin_1', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
];

function item(name: string, vodId: string, sourceKey = 'builtin_0'): SearchResultItem {
  return {
    sourceKey,
    sourceName: sourceKey === 'builtin_0' ? '非凡资源' : '量子资源',
    vodId,
    name,
    sourceUrl: 'https://cj.ffzyapi.com/api.php/provide/vod',
  };
}

function entry(name: string, vodId = name, sourceKey = 'builtin_0'): TitleIndexEntry {
  return {
    name,
    initials: 'stub',
    sourceKey,
    sourceName: sourceKey === 'builtin_0' ? '非凡资源' : '量子资源',
    vodId,
  };
}

describe('toIndexEntry（搜索结果 → 索引条目）', () => {
  it('保留片名与首字母，丢掉检索不到的条目', () => {
    const e = toIndexEntry(item('斗罗大陆', '1'));
    expect(e).not.toBeNull();
    expect(e!.name).toBe('斗罗大陆');
    expect(e!.initials).toBe('dldl');

    expect(toIndexEntry(item('   ', '2'))).toBeNull();
    // 纯符号：pinyinInitials 为空，进了索引也永远匹配不上
    expect(toIndexEntry(item('***', '3'))).toBeNull();
  });

  it('可选字段为空时不写入（省体积）', () => {
    const e = toIndexEntry(item('庆余年', '1'))!;
    expect('pic' in e).toBe(false);
    expect('year' in e).toBe(false);
  });
});

describe('mergeEntries（去重合并）', () => {
  it('同源同 id 覆盖，跨源同名保留两条', () => {
    const merged = mergeEntries(
      [entry('斗罗大陆', '1'), entry('斗罗大陆', '9', 'builtin_1')],
      [entry('斗罗大陆', '1')]
    );
    expect(merged).toHaveLength(2);
    expect(merged.filter((e) => e.sourceKey === 'builtin_0')).toHaveLength(1);
  });
});

describe('pruneIndex（超限裁剪）', () => {
  it('不超限时原样返回副本', () => {
    const input = [entry('A', '1')];
    const out = pruneIndex(input, 10);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('超限时每个首字母都留底，不会把冷门字母清空', () => {
    const many: TitleIndexEntry[] = [];
    for (let i = 0; i < 400; i++) {
      many.push({ ...entry(`z${i}`, `z${i}`), initials: `z${i}` });
    }
    for (let i = 0; i < 40; i++) {
      many.push({ ...entry(`s${i}`, `s${i}`), initials: `s${i}` });
    }
    const out = pruneIndex(many, 100, 20);
    // 虽然 s 只占 40 条且都在末尾之前，留底策略会让它留下至少 20 条
    expect(out.filter((e) => e.initials.startsWith('s')).length).toBeGreaterThanOrEqual(20);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  // 回归：`remaining === 0` 时 `entries.slice(-remaining)` 等价于 `slice(0)`，
  // 会把整个数组都塞进 keep，裁剪彻底失效。字母覆盖率高时（每个首字母都够留底条数）
  // 就会踩到。
  it('留底条目已经占满上限时仍然真的裁剪', () => {
    const many: TitleIndexEntry[] = [];
    for (const letter of ['a', 'b']) {
      for (let i = 0; i < 20; i++) {
        many.push({ ...entry(`${letter}${i}`, `${letter}${i}`), initials: `${letter}${i}` });
      }
    }
    // 2 个字母 × 留底 10 条 = 20 条，正好等于上限，没有余量给「最新条目」。
    // 修之前这里会因为 `slice(-0)` 把 40 条全留下，等于完全没裁。
    const out = pruneIndex(many, 20, 10);
    expect(out.length).toBe(20);
  });
});

describe('suggestFromIndex（查询 → 建议列表）', () => {
  const entries: TitleIndexEntry[] = [
    { ...entry('斗罗大陆', '1'), initials: 'dldl' },
    { ...entry('斗罗大陆之绝世唐门', '2'), initials: 'dldlzjstm' },
    { ...entry('斗破苍穹', '3'), initials: 'dpcq' },
    { ...entry('庆余年', '4', 'builtin_1'), initials: 'qyn' },
    { ...entry('庆余年', '5'), initials: 'qyn' },
  ];

  it('一位输入就能出建议（TVBox 式实时建议要求从第一个字母开始）', () => {
    const out = suggestFromIndex(entries, 'd');
    expect(out.map((g) => g.name)).toEqual(['斗罗大陆', '斗破苍穹', '斗罗大陆之绝世唐门']);
  });

  it('输入越具体收窄越明显', () => {
    expect(suggestFromIndex(entries, 'dl').map((g) => g.name)).toEqual([
      '斗罗大陆',
      '斗罗大陆之绝世唐门',
    ]);
    expect(suggestFromIndex(entries, 'dldl')).toHaveLength(2);
    expect(suggestFromIndex(entries, 'dpcq').map((g) => g.name)).toEqual(['斗破苍穹']);
    expect(suggestFromIndex(entries, 'zzz')).toHaveLength(0);
  });

  it('同名跨源合成一组，点选后能拿到全部源', () => {
    const out = suggestFromIndex(entries, 'qyn');
    expect(out).toHaveLength(1);
    expect(out[0].entries).toHaveLength(2);
    expect(suggestionToItems(out[0]).map((i) => i.vodId).sort()).toEqual(['4', '5']);
  });

  it('排序：完全相等 > 前缀 > 中段，同分时源多的优先', () => {
    const ranked = suggestFromIndex(
      [
        { ...entry('大斗罗', '1'), initials: 'xadldl' }, // 中段
        { ...entry('斗罗', '2'), initials: 'dldl' }, // 完全相等
        { ...entry('斗罗纪', '3'), initials: 'dldlj' }, // 前缀
      ],
      'dldl'
    );
    expect(ranked.map((g) => g.name)).toEqual(['斗罗', '斗罗纪', '大斗罗']);
  });

  it('空查询不出建议', () => {
    expect(suggestFromIndex(entries, '')).toHaveLength(0);
    expect(suggestFromIndex(entries, '   ')).toHaveLength(0);
  });

  it('limit 生效', () => {
    expect(suggestFromIndex(entries, 'd', { limit: 1 })).toHaveLength(1);
  });
});

describe('normalizeQuery', () => {
  it('转小写并去掉空白', () => {
    expect(normalizeQuery('  DLDl ')).toBe('dldl');
    expect(normalizeQuery('斗 罗')).toBe('斗罗');
  });
});

describe('签名与可用性', () => {
  it('源或成人开关变化时签名不同', () => {
    const a = indexSignature(sources, false);
    expect(indexSignature(sources, false)).toBe(a);
    expect(indexSignature(sources, true)).not.toBe(a);
    expect(indexSignature([sources[0]], false)).not.toBe(a);
  });

  it('过期不等于不可用（继续拿旧索引出建议）', () => {
    const sig = indexSignature(sources, false);
    const snapshot = { ...emptyIndex(sig), hot: [entry('斗罗大陆', '1')] };
    expect(isIndexUsable(snapshot, sig)).toBe(true);
    // 签名不符（换源了）才作废
    expect(isIndexUsable(snapshot, indexSignature([sources[0]], false))).toBe(false);
    expect(isIndexUsable(emptyIndex(sig), sig)).toBe(false);
  });
});

describe('planScan（三档调度）', () => {
  const sig = indexSignature(sources, false);

  it('初次：每个源先排热区，预算有剩才接着排冷区', () => {
    const tasks = planScan(emptyIndex(sig), sources, { budgetPages: 100 });
    // 预算宽松时两档都会排：先 2 个热区任务，再 2 个冷区任务
    expect(tasks.map((t) => `${t.source.key}:${t.tier}`)).toEqual([
      'builtin_0:hot',
      'builtin_1:hot',
      'builtin_0:deep',
      'builtin_1:deep',
    ]);
    expect(tasks[0].pages).toEqual([1, 2, 3, 4, 5]);
    expect(tasks[2].pages[0]).toBe(INDEX_HOT_PAGES + 1);
    // 预算只够热区时不会越界去排冷区
    const tight = planScan(emptyIndex(sig), sources, { budgetPages: 10 });
    expect(tight.every((t) => t.tier === 'hot')).toBe(true);
  });

  it('热区新鲜后转冷区推进，进度少的源优先', () => {
    const now = Date.now();
    const snapshot = {
      ...emptyIndex(sig),
      cursors: {
        builtin_0: { hotAt: now, deepPages: INDEX_HOT_PAGES + 20, deepDone: false },
        builtin_1: { hotAt: now, deepPages: INDEX_HOT_PAGES, deepDone: false },
      },
    };
    const tasks = planScan(snapshot, sources, { budgetPages: 20, now });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].source.key).toBe('builtin_1');
    expect(tasks[0].tier).toBe('deep');
    expect(tasks[0].pages[0]).toBe(INDEX_HOT_PAGES + 1);
  });

  // 回归：`deepPages` 是「已扫到第几页」，下一轮必须从它的下一页起，
  // 否则每轮把上一轮末页重扫一遍（6..25 → 25..44 → 44..60 浪费两页/源/轮）。
  it('冷区续扫从上一轮末页的下一页开始，不重复末页', () => {
    const now = Date.now();
    const done = INDEX_HOT_PAGES + 20;
    const snapshot = {
      ...emptyIndex(sig),
      cursors: {
        builtin_0: { hotAt: now, deepPages: done, deepDone: false },
        builtin_1: { hotAt: now, deepPages: INDEX_DEEP_TARGET_PAGES, deepDone: true, sweepAt: now },
      },
    };
    const tasks = planScan(snapshot, sources, { budgetPages: 20, now, tiers: ['deep'] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].pages[0]).toBe(done + 1);
    expect(tasks[0].pages).not.toContain(done);
  });

  it('冷区扫满后进入巡检，按游标轮转取一小段', () => {
    const now = Date.now();
    const snapshot = {
      ...emptyIndex(sig),
      cursors: {
        builtin_0: {
          hotAt: now,
          deepPages: INDEX_DEEP_TARGET_PAGES,
          deepDone: true,
          sweepAt: now - INDEX_SWEEP_INTERVAL_MS - 1,
          sweepPage: INDEX_HOT_PAGES + 1,
        },
        builtin_1: { hotAt: now, deepPages: INDEX_DEEP_TARGET_PAGES, deepDone: true, sweepAt: now },
      },
    };
    const tasks = planScan(snapshot, sources, { budgetPages: 20, now });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].source.key).toBe('builtin_0');
    expect(tasks[0].tier).toBe('sweep');
    expect(tasks[0].pages).toHaveLength(INDEX_SWEEP_PAGES);
  });

  it('三档互斥：热区过期时先只做热区', () => {
    const now = Date.now();
    const snapshot = {
      ...emptyIndex(sig),
      cursors: {
        builtin_0: { hotAt: now - INDEX_HOT_TTL_MS - 1, deepPages: 30, deepDone: false },
        builtin_1: { hotAt: now - INDEX_HOT_TTL_MS - 1, deepPages: 30, deepDone: false },
      },
    };
    // 预算刚好够两个源的热区，冷区排不进来
    const tasks = planScan(snapshot, sources, { budgetPages: INDEX_HOT_PAGES * 2, now });
    expect(tasks.map((t) => t.tier)).toEqual(['hot', 'hot']);
  });

  // 回归：预算不够把热区 5 页扫完时，宁可这一轮不排，也不能只扫 1~2 页——
  // 那会让 `applyScan` 误判成「热区已刷新」，剩下的页要么进不来要么被清掉。
  it('预算不足以扫完整个热区时留到下一轮，不排半截任务', () => {
    const tasks = planScan(emptyIndex(sig), sources, {
      budgetPages: INDEX_HOT_PAGES - 1,
      tiers: ['hot'],
    });
    expect(tasks).toEqual([]);
    // 到够扫完一个源的预算就正常排，且页数固定是完整热区
    const ok = planScan(emptyIndex(sig), sources, { budgetPages: INDEX_HOT_PAGES, tiers: ['hot'] });
    expect(ok).toHaveLength(1);
    expect(ok[0].pages).toEqual([1, 2, 3, 4, 5]);
  });

  it('tiers 过滤只做指定的档', () => {
    const now = Date.now();
    const snapshot = {
      ...emptyIndex(sig),
      cursors: { builtin_0: { hotAt: now, deepPages: 30, deepDone: false } },
    };
    const tasks = planScan(snapshot, sources, { budgetPages: 40, now, tiers: ['deep'] });
    expect(tasks.every((t) => t.tier === 'deep')).toBe(true);
  });
});

describe('needsWork（是否还有后台活）', () => {
  const sig = indexSignature(sources, false);

  it('全新索引需要干活', () => {
    expect(needsWork(emptyIndex(sig), sources)).toBe(true);
  });

  it('三档都到位才停', () => {
    const now = Date.now();
    const full = {
      ...emptyIndex(sig),
      cursors: {
        builtin_0: { hotAt: now, deepPages: INDEX_DEEP_TARGET_PAGES, deepDone: true, sweepAt: now },
        builtin_1: { hotAt: now, deepPages: INDEX_DEEP_TARGET_PAGES, deepDone: true, sweepAt: now },
      },
    };
    expect(needsWork(full, sources, now)).toBe(false);
    // 巡检到期又该干活了
    expect(needsWork(full, sources, now + INDEX_SWEEP_INTERVAL_MS)).toBe(true);
    // 热区到期也该干活
    expect(needsWork(full, sources, now + INDEX_HOT_TTL_MS)).toBe(true);
  });
});

describe('deepProgress', () => {
  it('统计补齐进度', () => {
    const sig = indexSignature(sources, false);
    const snapshot = {
      ...emptyIndex(sig),
      cursors: { builtin_0: { hotAt: 0, deepPages: INDEX_DEEP_TARGET_PAGES, deepDone: true } },
    };
    const p = deepProgress(snapshot, sources);
    expect(p.done).toBe(1);
    expect(p.total).toBe(2);
    expect(p.pages).toBe(INDEX_DEEP_TARGET_PAGES - INDEX_HOT_PAGES);
  });
});

describe('applyScan（写回快照）', () => {
  const sig = indexSignature(sources, false);
  const now = 1_700_000_000_000;

  it('热区整段扫完才整批替换该源旧条目', () => {
    const before = { ...emptyIndex(sig), hot: [entry('旧片', '1')] };
    const after = applyScan(
      before,
      {
        pages: INDEX_HOT_PAGES,
        failures: [],
        results: [
          {
            sourceKey: 'builtin_0',
            tier: 'hot',
            pages: [1, 2, 3, 4, 5],
            entries: [entry('新片', '2')],
          },
        ],
      },
      now
    );
    expect(after.hot.map((e) => e.name)).toEqual(['新片']);
    expect(after.cursors.builtin_0.hotAt).toBe(now);
  });

  // 回归：热区某页失败时 `runScan` 会停在失败页，`result.pages` 只剩前几页。
  // 这时若仍按「整批替换 + hotAt=now」处理，失败页的旧条目被清掉且 12 小时不再重试
  // ——一次网络抖动被放大成数据丢失。部分成功必须改成合并，并且不刷新 hotAt。
  it('热区只扫了一部分时合并而不是整批替换，hotAt 不刷新', () => {
    const before = { ...emptyIndex(sig), hot: [entry('旧片', '1')] };
    const after = applyScan(
      before,
      {
        pages: 2,
        failures: [{ sourceKey: 'builtin_0', page: 3, error: 'HTTP 502' }],
        results: [{ sourceKey: 'builtin_0', tier: 'hot', pages: [1, 2], entries: [entry('新片', '2')] }],
      },
      now
    );
    // 旧条目保住，新条目照收
    expect(after.hot.map((e) => e.name).sort()).toEqual(['新片', '旧片'].sort());
    // 仍是「过期」状态，下一轮继续重试
    expect(after.cursors.builtin_0.hotAt).toBe(0);
  });

  it('冷区增量追加并推进游标', () => {
    const after = applyScan(
      emptyIndex(sig),
      {
        pages: 3,
        failures: [],
        results: [
          { sourceKey: 'builtin_0', tier: 'deep', pages: [6, 7, 8], entries: [entry('深片', '9')] },
        ],
      },
      now
    );
    expect(after.deep.map((e) => e.name)).toEqual(['深片']);
    expect(after.cursors.builtin_0.deepPages).toBe(8);
    expect(after.cursors.builtin_0.deepDone).toBe(false);
  });

  it('冷区推进到目标页后置 deepDone', () => {
    const after = applyScan(
      emptyIndex(sig),
      {
        pages: 1,
        failures: [],
        results: [
          {
            sourceKey: 'builtin_0',
            tier: 'deep',
            pages: [INDEX_DEEP_TARGET_PAGES],
            entries: [entry('深片', '9')],
          },
        ],
      },
      now
    );
    expect(after.cursors.builtin_0.deepDone).toBe(true);
  });

  it('巡检只推巡检游标与时间，不改补齐状态', () => {
    const before = {
      ...emptyIndex(sig),
      cursors: {
        builtin_0: { hotAt: now, deepPages: INDEX_DEEP_TARGET_PAGES, deepDone: true },
      },
    };
    const after = applyScan(
      before,
      {
        pages: 1,
        failures: [],
        results: [{ sourceKey: 'builtin_0', tier: 'sweep', pages: [6, 7], entries: [entry('巡检', '3')] }],
      },
      now
    );
    expect(after.cursors.builtin_0.deepDone).toBe(true);
    expect(after.cursors.builtin_0.sweepAt).toBe(now);
    // 巡到第 7 页，下一段从第 8 页起
    expect(after.cursors.builtin_0.sweepPage).toBe(8);
  });

  it('空结果不动快照', () => {
    const before = emptyIndex(sig);
    expect(applyScan(before, { pages: 0, failures: [], results: [] }, now)).toBe(before);
  });

  // 回归：源站分页会随新片上线漂移，同一条目可能同时落在 hot 与 deep 里。
  // 拆分时必须去重，否则同键两条都进 hot，建议组里重复计数。
  it('热区与冷区含有同一部片时，拆分后不产生重复键', () => {
    const same = entry('漂移片', '77');
    const before = { ...emptyIndex(sig), deep: [same], cursors: {} };
    const after = applyScan(
      before,
      {
        pages: 1,
        failures: [],
        results: [{ sourceKey: 'builtin_0', tier: 'hot', pages: [1], entries: [same] }],
      },
      now
    );
    const all = allEntries(after);
    const keys = all.map((e) => `${e.sourceKey}:${e.vodId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 归入热区（新扫到的位置更「热」）
    expect(after.hot.map((e) => e.name)).toEqual(['漂移片']);
    expect(after.deep).toHaveLength(0);
  });
});

describe('allEntries', () => {
  it('冷区在前、热区在后（裁剪时先丢老片）', () => {
    const sig = indexSignature(sources, false);
    const snapshot = {
      ...emptyIndex(sig),
      hot: [entry('热', '1')],
      deep: [entry('冷', '2')],
    };
    expect(allEntries(snapshot).map((e) => e.name)).toEqual(['冷', '热']);
  });
});

describe('远端拼音检索（补本地索引装不下的老片）', () => {
  const pinyinSources: SourceConfig[] = [
    { key: 'builtin_1', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
    { key: 'builtin_8', name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod' },
    { key: 'builtin_0', name: '非凡资源', url: 'https://cj.ffzyapi.com/api.php/provide/vod' },
  ];

  it('只挑确认支持拼音的源，不按源名猜', () => {
    expect(remotePinyinSources(pinyinSources).map((s) => s.key)).toEqual(['builtin_1', 'builtin_8']);
    // 换域名后仍按 URL 片段认出
    const moved: SourceConfig[] = [
      { key: 'x', name: '任意名字', url: 'https://new.lziapi.com/api.php/provide/vod' },
    ];
    expect(remotePinyinSources(moved)).toHaveLength(1);
    // 完全不相干的源不进名单
    expect(
      remotePinyinSources([
        { key: 'y', name: '量子资源', url: 'https://example.com/api.php/provide/vod' },
      ])
    ).toHaveLength(0);
  });

  it('没有支持拼音的源时零请求直接返回', async () => {
    let calls = 0;
    const http = {
      request: async () => {
        calls++;
        throw new Error('不该被调用');
      },
    } as unknown as Parameters<typeof remotePinyinSearch>[2];
    const out = await remotePinyinSearch('dldl', [pinyinSources[2]], http);
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('空查询零请求', async () => {
    let calls = 0;
    const http = {
      request: async () => {
        calls++;
        throw new Error('不该被调用');
      },
    } as unknown as Parameters<typeof remotePinyinSearch>[2];
    expect(await remotePinyinSearch('', pinyinSources, http)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('只收首字母真正命中的条目（过滤源站的关键词语义噪声）', async () => {
    const http = {
      request: async (url: string) => {
        // 模拟量子资源：wd=dl 会带出「两个人的车站」这种不相干条目
        const list = [
          { vod_id: '1', vod_name: '斗罗大陆2：绝世唐门' },
          { vod_id: '2', vod_name: '两个人的车站' },
        ];
        return {
          ok: true,
          status: 200,
          url,
          headers: {},
          bytes: new Uint8Array(),
          text: JSON.stringify({ list }),
        };
      },
    } as unknown as Parameters<typeof remotePinyinSearch>[2];

    const out = await remotePinyinSearch('dldl', pinyinSources, http);
    // 两个拼音源各返回一条同名 → 各留一条（同名不同源要给用户换源余地）
    expect(out.map((e) => e.name)).toEqual(['斗罗大陆2：绝世唐门', '斗罗大陆2：绝世唐门']);
    expect(new Set(out.map((e) => e.sourceKey)).size).toBe(2);
    // 「两个人的车站」(lgrdcz) 不含 dldl，被过滤掉
    expect(out.some((e) => e.name.includes('两个人'))).toBe(false);
  });

  // 中文查询不该打远端：首字母串永远 ASCII，`initials.includes('庆余年')` 必为假，
  // 白白跑两个源的请求（「最近搜索」里点一个中文片名就会触发）。
  it('非 ASCII 查询零请求（点最近搜索的中文片名不该白跑远端）', async () => {
    let calls = 0;
    const http = {
      request: async () => {
        calls++;
        throw new Error('不该被调用');
      },
    } as unknown as Parameters<typeof remotePinyinSearch>[2];
    expect(await remotePinyinSearch('庆余年', pinyinSources, http)).toEqual([]);
    expect(await remotePinyinSearch('庆余年 qyn', pinyinSources, http)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('单个源失败不影响另一个源', async () => {
    let first = true;
    const http = {
      request: async (url: string) => {
        if (first) {
          first = false;
          throw new Error('fetch failed');
        }
        return {
          ok: true,
          status: 200,
          url,
          headers: {},
          bytes: new Uint8Array(),
          text: JSON.stringify({ list: [{ vod_id: '9', vod_name: '庆余年 第一季' }] }),
        };
      },
    } as unknown as Parameters<typeof remotePinyinSearch>[2];

    const out = await remotePinyinSearch('qyn', pinyinSources, http);
    expect(out.map((e) => e.name)).toEqual(['庆余年 第一季']);
  });

  // 源地址自带查询串（订阅里很常见：`.../provide/vod?key=abc`）时，
  // 手工拼 `?ac=videolist&wd=…` 会得到 `?key=abc?ac=…`，参数全落在 key 里，
  // 该源的索引永远为空，而且每轮都要再打一次必败的请求。
  it('源地址已带查询串时仍能正确拼出请求参数', async () => {
    const urls: string[] = [];
    const http = {
      request: async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          url,
          headers: {},
          bytes: new Uint8Array(),
          text: JSON.stringify({ list: [{ vod_id: '9', vod_name: '庆余年' }] }),
        };
      },
    } as unknown as Parameters<typeof remotePinyinSearch>[2];
    const keyed: SourceConfig[] = [
      {
        key: 'builtin_1',
        name: '量子资源',
        url: 'https://cj.lziapi.com/api.php/provide/vod?key=abc',
      },
    ];
    await remotePinyinSearch('qyn', keyed, http);
    expect(urls).toHaveLength(1);
    const parsed = new URL(urls[0]);
    expect(parsed.searchParams.get('key')).toBe('abc');
    expect(parsed.searchParams.get('ac')).toBe('videolist');
    expect(parsed.searchParams.get('wd')).toBe('qyn');
    expect(parsed.searchParams.get('pg')).toBe('1');
  });
});
