import { describe, expect, it } from 'vitest';
import {
  buildPlaybackCandidates,
  candidateKey,
  candidateLabel,
  discoverCandidates,
  firstPlayableCandidate,
  nextUntriedCandidate,
  pickEpisodeIndex,
  resolveCandidateSource,
  MAX_PLAYBACK_CANDIDATES,
  type PlaybackCandidate,
} from './failover';
import type { HttpClient, HttpResponse } from './http';
import type { SearchResultItem, SourceConfig } from './types';

const sources: SourceConfig[] = [
  { key: 'a', name: '甲源', url: 'https://a.example.com/api.php/provide/vod' },
  { key: 'b', name: '乙源', url: 'https://b.example.com/api.php/provide/vod' },
];

const item = (sourceKey: string, vodId: string, name = sourceKey): SearchResultItem => ({
  sourceKey,
  sourceName: name,
  vodId,
  name: '影片',
});

/** 只回固定文本的 HttpClient，用来验证请求了哪个源 */
function fakeHttp(handlers: Record<string, () => HttpResponse>): HttpClient & { hits: string[] } {
  const hits: string[] = [];
  return {
    hits,
    async request(url: string): Promise<HttpResponse> {
      hits.push(url);
      const host = new URL(url).host;
      const handler = handlers[host];
      if (!handler) throw new Error(`unexpected host ${host}`);
      return handler();
    },
  };
}

const jsonResponse = (body: unknown, url = 'https://a.example.com/x'): HttpResponse => ({
  ok: true,
  status: 200,
  url,
  headers: {},
  bytes: new Uint8Array(),
  text: JSON.stringify(body),
});

/** Apple CMS 详情响应 */
const detailBody = (playUrls: string[]) => ({
  list: [
    {
      vod_id: 1,
      vod_name: '影片',
      vod_play_url: playUrls.map((u, i) => `第${i + 1}集$${u}`).join('#'),
    },
  ],
});

describe('buildPlaybackCandidates：候选链构造', () => {
  it('去重并保持原顺序', () => {
    const list = [item('a', '1'), item('b', '2'), item('a', '1')];
    const out = buildPlaybackCandidates(list, sources);
    expect(out.map(candidateKey)).toEqual(['a:1', 'b:2']);
  });

  it('当前播放的候选被提到第一位', () => {
    const list = [item('a', '1'), item('b', '2'), item('c', '3')];
    const withC: SourceConfig[] = [
      ...sources,
      { key: 'c', name: '丙源', url: 'https://c.example.com/api.php/provide/vod' },
    ];
    const out = buildPlaybackCandidates(list, withC, { active: { sourceKey: 'b', vodId: '2' } });
    expect(out.map(candidateKey)).toEqual(['b:2', 'a:1', 'c:3']);
  });

  it('当前候选不在列表里时不会凭空插入', () => {
    const list = [item('a', '1')];
    const out = buildPlaybackCandidates(list, sources, { active: { sourceKey: 'b', vodId: '2' } });
    expect(out.map(candidateKey)).toEqual(['a:1']);
  });

  it('跳过无法解析出源配置的条目', () => {
    const out = buildPlaybackCandidates([item('gone', '9'), item('a', '1')], sources);
    expect(out.map(candidateKey)).toEqual(['a:1']);
  });

  it('源被删除但条目自带 sourceUrl 时仍可播放', () => {
    const orphan: SearchResultItem = { ...item('gone', '9'), sourceUrl: 'https://x.example.com/api' };
    const out = buildPlaybackCandidates([orphan], sources);
    expect(out).toHaveLength(1);
    expect(out[0].source.url).toBe('https://x.example.com/api');
  });

  it('源地址非法（非 http）时跳过', () => {
    const bad: SourceConfig = { key: 'z', name: '坏源', url: 'ftp://x' };
    const out = buildPlaybackCandidates([item('z', '1')], [...sources, bad]);
    expect(out).toHaveLength(0);
  });

  it('默认上限生效', () => {
    const many = Array.from({ length: 20 }, (_, i) => item('a', String(i)));
    const out = buildPlaybackCandidates(many, sources);
    expect(out).toHaveLength(MAX_PLAYBACK_CANDIDATES);
  });

  it('limit 可覆盖默认上限', () => {
    const many = Array.from({ length: 20 }, (_, i) => item('a', String(i)));
    expect(buildPlaybackCandidates(many, sources, { limit: 3 })).toHaveLength(3);
  });

  it('按源轮转：同一站有多个版本时也要先覆盖别的源', () => {
    // 真实场景：搜「沙丘」在量子资源命中 8 个版本（沙丘/沙丘2/国语…）。
    // 若按原顺序装满 8 条，整条链全来自同一个站 —— 而这个站整体挂掉正是换源要解决的场景。
    const list = [
      item('a', '1'),
      item('a', '2'),
      item('a', '3'),
      item('a', '4'),
      item('b', '5'),
      item('c', '6'),
    ];
    const withC: SourceConfig[] = [
      ...sources,
      { key: 'c', name: '丙源', url: 'https://c.example.com/api.php/provide/vod' },
    ];
    const out = buildPlaybackCandidates(list, withC);
    expect(out.map(candidateKey)).toEqual(['a:1', 'b:5', 'c:6', 'a:2', 'a:3', 'a:4']);
  });

  it('被上限截断时优先铺满不同的源', () => {
    const list = [
      ...Array.from({ length: 6 }, (_, i) => item('a', `a${i}`)),
      item('b', 'b0'),
      item('c', 'c0'),
    ];
    const out = buildPlaybackCandidates(list, sources, { limit: 2 });
    expect(out.map(candidateKey)).toEqual(['a:a0', 'b:b0']);
  });

  it('轮转不会打乱「当前候选置顶」', () => {
    const list = [item('a', '1'), item('a', '2'), item('b', '3'), item('c', '4')];
    const out = buildPlaybackCandidates(list, sources, { active: { sourceKey: 'b', vodId: '3' } });
    expect(out[0].sourceKey).toBe('b');
  });
});

describe('resolveCandidateSource', () => {
  it('优先用已配置的源', () => {
    expect(resolveCandidateSource(item('a', '1'), sources)?.url).toContain('a.example.com');
  });

  it('没有 sourceUrl 时返回 null', () => {
    expect(resolveCandidateSource(item('missing', '1'), sources)).toBeNull();
  });
});

describe('pickEpisodeIndex：换源时的集数对齐', () => {
  it('正常范围原样返回', () => {
    expect(pickEpisodeIndex(3, 10)).toBe(3);
  });

  it('超出目标源集数时夹到最后一集', () => {
    expect(pickEpisodeIndex(30, 5)).toBe(4);
  });

  it('负数归零', () => {
    expect(pickEpisodeIndex(-3, 5)).toBe(0);
  });

  it('空列表返回 0', () => {
    expect(pickEpisodeIndex(3, 0)).toBe(0);
  });

  it('小数向下取整', () => {
    expect(pickEpisodeIndex(2.9, 5)).toBe(2);
  });

  it('NaN 归零', () => {
    expect(pickEpisodeIndex(Number.NaN, 5)).toBe(0);
  });
});

describe('nextUntriedCandidate', () => {
  const candidates: PlaybackCandidate[] = [
    { sourceKey: 'a', sourceName: '甲', vodId: '1', source: sources[0] },
    { sourceKey: 'b', sourceName: '乙', vodId: '2', source: sources[1] },
  ];

  it('跳过已试过的候选', () => {
    expect(nextUntriedCandidate(candidates, new Set(['a:1']))).toBe(candidates[1]);
  });

  it('全部试过返回 undefined', () => {
    expect(nextUntriedCandidate(candidates, new Set(['a:1', 'b:2']))).toBeUndefined();
  });
});

describe('firstPlayableCandidate：依次尝试', () => {
  it('第一个源就成功时不打第二个', async () => {
    const http = fakeHttp({
      'a.example.com': () => jsonResponse(detailBody(['https://cdn/a.m3u8'])),
      'b.example.com': () => jsonResponse(detailBody(['https://cdn/b.m3u8'])),
    });
    const candidates = buildPlaybackCandidates([item('a', '1'), item('b', '2')], sources);
    const out = await firstPlayableCandidate(candidates, http);
    expect(out.candidate.sourceKey).toBe('a');
    expect(out.detail.episodes).toEqual(['https://cdn/a.m3u8']);
    expect(http.hits).toHaveLength(1);
  });

  it('第一个源失败时自动落到第二个，并回调失败原因', async () => {
    const http = fakeHttp({
      'a.example.com': () => {
        throw new Error('连接超时');
      },
      'b.example.com': () => jsonResponse(detailBody(['https://cdn/b.m3u8', 'https://cdn/b2.m3u8'])),
    });
    const candidates = buildPlaybackCandidates([item('a', '1'), item('b', '2')], sources);
    const skipped: string[] = [];
    const out = await firstPlayableCandidate(candidates, http, {
      onSkip: (candidate) => skipped.push(candidate.sourceKey),
    });
    expect(out.candidate.sourceKey).toBe('b');
    expect(skipped).toEqual(['a']);
  });

  it('集数按目标源夹紧', async () => {
    const http = fakeHttp({
      'b.example.com': () => jsonResponse(detailBody(['https://cdn/1.m3u8', 'https://cdn/2.m3u8'])),
    });
    const candidates = buildPlaybackCandidates([item('b', '2')], sources);
    const out = await firstPlayableCandidate(candidates, http, { episodeIndex: 9 });
    expect(out.index).toBe(1);
  });

  it('全部失败时抛出最后一个错误', async () => {
    const http = fakeHttp({
      'a.example.com': () => {
        throw new Error('甲源挂了');
      },
      'b.example.com': () => {
        throw new Error('乙源也挂了');
      },
    });
    const candidates = buildPlaybackCandidates([item('a', '1'), item('b', '2')], sources);
    await expect(firstPlayableCandidate(candidates, http)).rejects.toThrow('乙源也挂了');
  });

  it('源返回 0 集也算失败，继续下一个', async () => {
    const http = fakeHttp({
      'a.example.com': () => jsonResponse(detailBody([])),
      'b.example.com': () => jsonResponse(detailBody(['https://cdn/b.m3u8'])),
    });
    const candidates = buildPlaybackCandidates([item('a', '1'), item('b', '2')], sources);
    const out = await firstPlayableCandidate(candidates, http);
    expect(out.candidate.sourceKey).toBe('b');
  });

  it('空候选链直接报错', async () => {
    const http = fakeHttp({});
    await expect(firstPlayableCandidate([], http)).rejects.toThrow('没有可用的播放源');
  });
});

describe('candidateLabel', () => {
  it('短名原样返回', () => {
    expect(candidateLabel({ sourceName: '甲源' })).toBe('甲源');
  });

  it('超长名截断加省略号', () => {
    const label = candidateLabel({ sourceName: '一二三四五六七八九十甲乙丙' }, 6);
    expect(label).toBe('一二三四五…');
  });

  it('空名回退', () => {
    expect(candidateLabel({ sourceName: '   ' })).toBe('未知来源');
  });
});

describe('discoverCandidates', () => {
  /** 搜索接口响应：每个源回自己那份列表 */
  const searchBody = (names: { vod_id: number; vod_name: string }[]) => ({
    list: names.map((n) => ({ ...n, vod_play_url: `正片$https://cdn/${n.vod_id}.m3u8` })),
  });

  it('把其它源的同名影片补进候选链', async () => {
    const http = fakeHttp({
      'a.example.com': () => jsonResponse(searchBody([{ vod_id: 1, vod_name: '流浪地球' }])),
      'b.example.com': () => jsonResponse(searchBody([{ vod_id: 7, vod_name: '流浪地球' }])),
    });
    const out = await discoverCandidates('流浪地球', sources, http);
    expect(out.map((c) => candidateKey(c)).sort()).toEqual(['a:1', 'b:7']);
  });

  it('排除已试过的候选', async () => {
    const http = fakeHttp({
      'a.example.com': () => jsonResponse(searchBody([{ vod_id: 1, vod_name: '流浪地球' }])),
      'b.example.com': () => jsonResponse(searchBody([{ vod_id: 7, vod_name: '流浪地球' }])),
    });
    const out = await discoverCandidates('流浪地球', sources, http, { exclude: new Set(['a:1']) });
    expect(out.map((c) => candidateKey(c))).toEqual(['b:7']);
  });

  it('过滤掉名字不相关的搜索结果', async () => {
    const http = fakeHttp({
      'a.example.com': () =>
        jsonResponse(
          searchBody([
            { vod_id: 1, vod_name: '流浪地球' },
            { vod_id: 2, vod_name: '流浪地球2' },
            { vod_id: 3, vod_name: '完全无关的片子' },
          ])
        ),
    });
    const out = await discoverCandidates('流浪地球', [sources[0]], http);
    // 「流浪地球2」是续集，换过去会静默播错内容，不再当候选
    expect(out.map((c) => candidateKey(c)).sort()).toEqual(['a:1']);
  });

  it('带年份/画质说明的同一部片仍可作候选', async () => {
    const http = fakeHttp({
      'a.example.com': () =>
        jsonResponse(
          searchBody([
            { vod_id: 1, vod_name: '流浪地球 4K' },
            { vod_id: 2, vod_name: '流浪地球(2019)' },
            { vod_id: 3, vod_name: '流浪地球2' },
          ])
        ),
    });
    const out = await discoverCandidates('流浪地球', [sources[0]], http);
    expect(out.map((c) => candidateKey(c)).sort()).toEqual(['a:1', 'a:2']);
  });

  it('完全同名的候选排在弱匹配之前', async () => {
    const http = fakeHttp({
      'a.example.com': () =>
        jsonResponse(
          searchBody([
            { vod_id: 1, vod_name: '庆余年 特别篇' },
            { vod_id: 2, vod_name: '庆余年' },
          ])
        ),
    });
    const out = await discoverCandidates('庆余年', [sources[0]], http);
    expect(out.map((c) => candidateKey(c))).toEqual(['a:2', 'a:1']);
  });

  it('空片名不发起搜索', async () => {
    const http = fakeHttp({});
    expect(await discoverCandidates('   ', sources, http)).toEqual([]);
    expect(http.hits).toEqual([]);
  });

  // 回归护栏：比对用的是 normalizeTitle(item.name)，关键字不归一化就会全落空。
  // 带空格/标点的片名（英文片名、带副标题的中文名）以前一个候选都补不到，
  // 而中文无空格标题看起来完全正常，所以这个缺陷很难被手动发现。
  it('带空格与标点的片名也能补源', async () => {
    const en = fakeHttp({
      'a.example.com': () => jsonResponse(searchBody([{ vod_id: 1, vod_name: 'The Matrix' }])),
      'b.example.com': () => jsonResponse(searchBody([{ vod_id: 7, vod_name: 'The-Matrix' }])),
    });
    expect((await discoverCandidates('The Matrix', sources, en)).map((c) => candidateKey(c)).sort()).toEqual([
      'a:1',
      'b:7',
    ]);

    const zh = fakeHttp({
      'a.example.com': () => jsonResponse(searchBody([{ vod_id: 2, vod_name: '流浪地球2' }])),
    });
    // 「流浪地球 2」归一化后是「流浪地球2」，与片库写法一致
    expect((await discoverCandidates('流浪地球 2', [sources[0]], zh)).map((c) => candidateKey(c))).toEqual(['a:2']);
  });

  it('搜索全部失败时返回空数组而不抛错', async () => {
    const http = fakeHttp({
      'a.example.com': () => {
        throw new Error('挂了');
      },
      'b.example.com': () => {
        throw new Error('也挂了');
      },
    });
    expect(await discoverCandidates('流浪地球', sources, http)).toEqual([]);
  });
});
