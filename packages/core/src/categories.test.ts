import { describe, expect, it } from 'vitest';
import {
  browseCategory,
  bucketOf,
  CATEGORY_BUCKETS,
  categoryLabel,
  classifyCategoryName,
  fetchSourceCategories,
  HOME_CATEGORIES,
  matchTypeId,
  matchTypeIds,
  parseSourceCategories,
  probeCategories,
  clearProbeCache,
  setCachedCategories,
  clearCategoryCache,
} from './categories';
import type { HttpClient, HttpResponse } from './http';
import type { SourceConfig } from './types';

function res(body: unknown, status = 200): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, url: '', headers: {}, text, bytes: new TextEncoder().encode(text) };
}

const source: SourceConfig = { key: 'k1', name: '甲源', url: 'https://a.example.com/api.php/provide/vod' };

describe('classifyCategoryName', () => {
  it('常见分类归类', () => {
    expect(classifyCategoryName('电影')).toBe('movie');
    expect(classifyCategoryName('动作片')).toBe('movie');
    expect(classifyCategoryName('国产剧')).toBe('tv');
    expect(classifyCategoryName('连续剧')).toBe('tv');
    expect(classifyCategoryName('综艺')).toBe('variety');
    expect(classifyCategoryName('动漫')).toBe('anime');
    expect(classifyCategoryName('少儿')).toBe('kids');
    expect(classifyCategoryName('纪录片')).toBe('doc');
    expect(classifyCategoryName('短剧')).toBe('short');
  });

  it('专属桶优先于通用桶（避免被「片」抢走）', () => {
    expect(classifyCategoryName('少儿动画')).toBe('kids');
    expect(classifyCategoryName('纪录电影')).toBe('doc');
    expect(classifyCategoryName('动画电影')).toBe('anime');
  });
  it('无法识别的归入其他', () => {
    expect(classifyCategoryName('福利')).toBe('other');
    expect(classifyCategoryName('')).toBe('other');
  });

  it('首页分类入口不含「其他」，且电影电视剧排在最前', () => {
    expect(HOME_CATEGORIES.map((c) => c.key)).toEqual([
      'movie',
      'tv',
      'kids',
      'variety',
      'anime',
      'doc',
      'short',
      'sports',
    ]);
    expect(categoryLabel('tv')).toBe('电视剧');
    expect(categoryLabel('movie')).toBe('电影');
  });

  it('展示顺序与判定顺序解耦：判定仍让专属桶优先', () => {
    // 展示顺序里电影排第一，但「少儿动画」这类名字仍必须先命中少儿桶
    expect(HOME_CATEGORIES[0]?.key).toBe('movie');
    expect(classifyCategoryName('少儿动画')).toBe('kids');
    expect(classifyCategoryName('纪录电影')).toBe('doc');
    expect(CATEGORY_BUCKETS.findIndex((b) => b.key === 'kids')).toBeLessThan(
      CATEGORY_BUCKETS.findIndex((b) => b.key === 'movie')
    );
  });
});

describe('parseSourceCategories / matchTypeId', () => {
  const payload = {
    class: [
      { type_id: 1, type_name: '电影' },
      { type_id: 2, type_name: '连续剧' },
      { type_id: 3, type_name: '综艺' },
      { type_id: 4, type_name: '动漫' },
      { type_id: 5, type_name: '少儿' },
      { type_id: 6, type_name: '动作片' },
      { type_id: 7, type_name: '喜剧片' },
    ],
  };

  it('解析 type_id/type_name 并去重', () => {
    const categories = parseSourceCategories(payload);
    expect(categories).toHaveLength(7);
    expect(categories[0]).toEqual({ id: '1', name: '电影', parentId: undefined });
    expect(parseSourceCategories({ class: null })).toEqual([]);
    expect(parseSourceCategories(null)).toEqual([]);
  });

  it('按桶匹配 type_id，按 id 升序取叶子分类', () => {
    const categories = parseSourceCategories(payload);
    // 该 payload 里「电影(1)」没有挂子分类，本身就是叶子，因此排在最前
    expect(matchTypeId(categories, 'movie')).toBe('1');
    expect(matchTypeId(categories, 'tv')).toBe('2');
    expect(matchTypeId(categories, 'kids')).toBe('5');
  });

  it('父分类不聚合子分类：优先返回叶子分类', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 1, type_name: '电影片', type_pid: 0 },
        { type_id: 6, type_name: '动作片', type_pid: 1 },
        { type_id: 7, type_name: '喜剧片', type_pid: 1 },
        { type_id: 20, type_name: '记录片', type_pid: 1 },
      ],
    });
    const ids = matchTypeIds(categories, 'movie');
    // 6/7 是「片」结尾的叶子分类；20 归入纪录片桶，因此不应混入
    expect(ids).toEqual(['6', '7']);
  });

  it('只有顶级分类的源回退到父分类', () => {
    const categories = parseSourceCategories({ class: [{ type_id: 1, type_name: '电影' }] });
    expect(matchTypeIds(categories, 'movie')).toEqual(['1']);
  });

  it('没有对应分类时返回空数组', () => {
    const categories = parseSourceCategories({ class: [{ type_id: 9, type_name: '电影' }] });
    expect(matchTypeIds(categories, 'variety')).toEqual([]);
    expect(matchTypeId(categories, 'variety')).toBeUndefined();
  });

  it('支持不同的字段命名', () => {
    const categories = parseSourceCategories({ classes: [{ typeId: '11', typeName: '纪录片', typePid: 0 }] });
    expect(categories).toEqual([{ id: '11', name: '纪录片', parentId: undefined }]);
  });
});

/**
 * 父级继承：真实采集站普遍把题材当子分类挂在「短剧」「体育」「连续剧」下，
 * 名字里完全不含父级关键词。只按名字判桶会让这些分类全部落到 other 而不被展示。
 * 以下 payload 全部取自 2026-10 的真实 `?ac=list` 返回（极速/红牛/电影天堂）。
 */
describe('bucketOf：名字判不出时继承父分类', () => {
  it('「古装仙侠」等题材挂短剧下 -> 短剧桶', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 38, type_name: '短剧' },
        { type_id: 45, type_name: '古装仙侠', type_pid: 38 },
        { type_id: 46, type_name: '现代都市', type_pid: 38 },
        { type_id: 49, type_name: '重生民国', type_pid: 38 },
        { type_id: 54, type_name: 'AI漫剧', type_pid: 38 },
      ],
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    for (const id of ['45', '46', '49', '54']) {
      const category = byId.get(id);
      expect(category).toBeDefined();
      expect(bucketOf(category!, byId), id).toBe('short');
    }
  });

  it('「台球」挂体育赛事下 -> 体育桶', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 29, type_name: '体育赛事' },
        { type_id: 42, type_name: '台球', type_pid: 29 },
      ],
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    expect(bucketOf(byId.get('42')!, byId)).toBe('sports');
  });

  it('「香港剧」挂连续剧下 -> 电视剧桶', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 2, type_name: '连续剧' },
        { type_id: 14, type_name: '香港剧', type_pid: 2 },
      ],
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    expect(bucketOf(byId.get('14')!, byId)).toBe('tv');
  });

  it('名字本身判得出桶时以名字为准，不被父分类覆盖', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 1, type_name: '电影片' },
        { type_id: 20, type_name: '记录片', type_pid: 1 },
      ],
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    // 「记录片」挂在电影下，但它是纪录片，不该跟着变电影
    expect(bucketOf(byId.get('20')!, byId)).toBe('doc');
  });

  it('「未分类」这类兜底分类不跟着父分类混进正经桶', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 1, type_name: '电影' },
        { type_id: 43, type_name: '未分类', type_pid: 1 },
      ],
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    expect(bucketOf(byId.get('43')!, byId)).toBe('other');
  });

  it('父级不存在或形成环时安全返回 other', () => {
    const orphan = parseSourceCategories({ class: [{ type_id: 9, type_name: '神秘分类', type_pid: 999 }] });
    expect(bucketOf(orphan[0], new Map(orphan.map((c) => [c.id, c])))).toBe('other');

    const a = { id: 'a', name: '环甲', parentId: 'b' };
    const b = { id: 'b', name: '环乙', parentId: 'a' };
    const byId = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    expect(bucketOf(a, byId)).toBe('other');
  });

  it('继承后 matchTypeIds 能把题材子分类拉进对应桶', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 1, type_name: '电影' },
        { type_id: 38, type_name: '短剧' },
        { type_id: 45, type_name: '古装仙侠', type_pid: 38 },
        { type_id: 46, type_name: '现代都市', type_pid: 38 },
      ],
    });
    const ids = matchTypeIds(categories, 'short');
    // 45/46 是叶子，38 有子分类所以不参与（避免重复抓同一批内容）
    expect(ids).toEqual(['45', '46']);
  });
});

describe('collect 类题材名：独立顶级分类也能归桶', () => {
  it('红牛/百度把短剧题材摆成顶级分类时按名字归桶', () => {
    // 红牛资源实测：43=古装仙侠 … 51=AI漫剧 全是顶级（没有父分类可继承）
    for (const name of ['古装仙侠', '现代都市', '穿越年代', '言情总裁', '重生民国', '反转爽剧', '脑洞悬疑', 'AI漫剧']) {
      expect(classifyCategoryName(name), name).toBe('short');
    }
  });

  it('按地区拆的剧集分类归电视剧', () => {
    for (const name of ['香港剧', '台湾剧', '韩国剧', '日本剧', '泰国剧', '港澳剧', '大陆剧', '内地剧', '其他剧']) {
      expect(classifyCategoryName(name), name).toBe('tv');
    }
  });

  it('赛事类分类归体育', () => {
    for (const name of ['台球', '网球', '斯诺克', 'NBA']) {
      expect(classifyCategoryName(name), name).toBe('sports');
    }
  });

  it('「爽文短剧」归短剧而不是被「剧」拿到电视剧', () => {
    expect(classifyCategoryName('爽文短剧')).toBe('short');
  });
});

describe('fetchSourceCategories', () => {
  it('请求 ac=list 并解析分类', async () => {
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        return res({ class: [{ type_id: 1, type_name: '电影' }] });
      },
    };
    const categories = await fetchSourceCategories(source, http);
    expect(calls[0]).toBe('https://a.example.com/api.php/provide/vod?ac=list&pg=1');
    expect(categories).toHaveLength(1);
  });

  it('非 JSON 或非 2xx 抛错', async () => {
    await expect(
      fetchSourceCategories(source, { request: async () => res('<html>', 500) })
    ).rejects.toThrow('HTTP 500');
    await expect(
      fetchSourceCategories(source, { request: async () => res('<html>') })
    ).rejects.toThrow('返回内容不是合法 JSON');
  });
});

describe('browseCategory', () => {
  it('按分类聚合多个源，缺该分类的源标记 supported=false', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(url) {
        if (url.includes('/a.example.com')) {
          if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
          return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: '流浪地球', type_name: '电影' }] });
        }
        if (url.includes('ac=list')) return res({ class: [{ type_id: 2, type_name: '连续剧' }] });
        return res({ list: [] });
      },
    };
    const result = await browseCategory({
      sources: [source, { key: 'k2', name: '乙源', url: 'https://b.example.com/api.php/provide/vod' }],
      key: 'movie',
      http,
    });
    expect(result.items.map((i) => i.vodId)).toEqual(['11']);
    expect(result.supportedSources).toBe(1);
    expect(result.outcomes.find((o) => o.sourceKey === 'k2')).toMatchObject({ ok: true, supported: false });
  });

  it('分类表走缓存，第二次不再请求 ac=list', async () => {
    clearCategoryCache();
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
        return res({ pagecount: 1, list: [] });
      },
    };
    await browseCategory({ sources: [source], key: 'movie', http });
    await browseCategory({ sources: [source], key: 'movie', http });
    expect(calls.filter((url) => url.includes('ac=list'))).toHaveLength(1);
  });

  it('切回同一个分类直接读缓存，不再打任何接口', async () => {
    clearCategoryCache();
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
        return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: '流浪地球', type_name: '电影' }] });
      },
    };
    const first = await browseCategory({ sources: [source], key: 'movie', http });
    const before = calls.length;
    const second = await browseCategory({ sources: [source], key: 'movie', http });
    expect(calls.length).toBe(before);
    expect(second.items.map((i) => i.vodId)).toEqual(first.items.map((i) => i.vodId));
  });

  it('换分类不会命中另一个分类的缓存', async () => {
    clearCategoryCache();
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        if (url.includes('ac=list')) {
          return res({ class: [{ type_id: 1, type_name: '电影' }, { type_id: 2, type_name: '连续剧' }] });
        }
        return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: 'x' }] });
      },
    };
    await browseCategory({ sources: [source], key: 'movie', http });
    const afterMovie = calls.length;
    await browseCategory({ sources: [source], key: 'tv', http });
    expect(calls.length).toBeGreaterThan(afterMovie);
  });

  // 回归护栏：duplicated 的 outcome.ok 恒为 true（「本地跳过」不是失败），
  // 一旦把它算进 answered，只要配了重复地址，「全源失败不缓存」就永远失效。
  it('配了重复地址时，全源失败仍然不写缓存', async () => {
    clearCategoryCache();
    const dup = { ...source, key: 'dup', name: '重复源' };
    let attempts = 0;
    const http: HttpClient = {
      async request() {
        attempts += 1;
        throw new Error('采集站挂了');
      },
    };
    await browseCategory({ sources: [source, dup], key: 'movie', http, pages: 1 });
    const afterFirst = attempts;
    await browseCategory({ sources: [source, dup], key: 'movie', http, pages: 1 });
    expect(attempts).toBeGreaterThan(afterFirst);
  });

  it('分页：按 pages 拉取并遵守 pagecount', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [{ id: '1', name: '电影' }]);
    const pages: string[] = [];
    const http: HttpClient = {
      async request(url) {
        const page = /pg=(\d+)/.exec(url)?.[1] ?? '1';
        pages.push(page);
        return res({ pagecount: 2, list: [{ vod_id: Number(page), vod_name: 'x' }] });
      },
    };
    const result = await browseCategory({ sources: [source], key: 'movie', http, pages: 5 });
    expect(pages).toEqual(['1', '2']);
    expect(result.items).toHaveLength(2);
  });

  it('源失败时记录错误但不影响其他源', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(url) {
        if (url.includes('/a.example.com')) {
          if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
          return res({ list: [{ vod_id: 1, vod_name: 'x' }] });
        }
        return res('', 500);
      },
    };
    const result = await browseCategory({
      sources: [source, { key: 'k2', name: '乙源', url: 'https://b.example.com/api.php/provide/vod' }],
      key: 'movie',
      http,
    });
    expect(result.items).toHaveLength(1);
    expect(result.outcomes.find((o) => o.sourceKey === 'k2')?.ok).toBe(false);
  });

  it('分类浏览默认过滤成人分类内容', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '34', name: '伦理片', parentId: '1' },
      { id: '6', name: '动作片', parentId: '1' },
    ]);
    const http: HttpClient = {
      async request(url) {
        const typeId = /[?&]t=(\d+)/.exec(url)?.[1];
        if (typeId === '34') {
          return res({ list: [{ vod_id: 34, vod_name: '成人内容', type_name: '伦理片' }] });
        }
        return res({ list: [{ vod_id: 6, vod_name: '动作电影', type_name: '动作片' }] });
      },
    };
    // 伦理片名字带「片」会归入电影桶，必须在分类浏览里同样被过滤掉
    const filtered = await browseCategory({ sources: [source], key: 'movie', http });
    expect(filtered.items.map((i) => i.vodId)).toEqual(['6']);

    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '34', name: '伦理片', parentId: '1' },
      { id: '6', name: '动作片', parentId: '1' },
    ]);
    const unfiltered = await browseCategory({ sources: [source], key: 'movie', http, filterAdult: false });
    expect(unfiltered.items).toHaveLength(2);
  });

  it('翻页只抓目标页，不会把前面的页全部重下一遍', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '6', name: '动作片', parentId: '1' },
    ]);
    const requested: string[] = [];
    const http: HttpClient = {
      async request(url) {
        requested.push(url);
        const page = Number(/[?&]pg=(\d+)/.exec(url)?.[1] ?? '1');
        return res({ page, pagecount: 8, list: [{ vod_id: 100 + page, vod_name: `电影${page}`, type_name: '动作片' }] });
      },
    };

    const first = await browseCategory({ sources: [source], key: 'movie', http, pages: 1, startPage: 1 });
    expect(first.items.map((i) => i.vodId)).toEqual(['101']);
    expect(requested).toHaveLength(1);

    // 追加第 2 页：只应该再打 1 个请求（pg=2），而不是 2 个（pg=1+pg=2）
    requested.length = 0;
    const second = await browseCategory({ sources: [source], key: 'movie', http, pages: 1, startPage: 2 });
    expect(second.items.map((i) => i.vodId)).toEqual(['102']);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('pg=2');
  });
});

describe('probeCategories（首页隐藏空分类）', () => {
  function makeHttp(byType: Record<string, string[]>): HttpClient {
    return {
      async request(url) {
        if (url.includes('ac=list')) {
          return res({
            class: [
              { type_id: 1, type_name: '电影' },
              { type_id: 2, type_name: '连续剧' },
              { type_id: 5, type_name: '少儿' },
            ],
          });
        }
        const typeId = /[?&]t=(\d+)/.exec(url)?.[1] ?? '';
        const names = byType[typeId] ?? [];
        return res({
          pagecount: 1,
          list: names.map((name, i) => ({ vod_id: Number(`${typeId}${i}`), vod_name: name, type_name: '' })),
        });
      },
    };
  }

  it('只把确有内容的分类标记为可用', async () => {
    clearCategoryCache();
    // 「少儿」分类在源里存在但一条内容都没有 -> 首页应当隐藏
    const http = makeHttp({ '1': ['一部电影'], '2': ['一部电视剧'], '5': [] });
    const results = await probeCategories({
      sources: [source],
      http,
      keys: ['movie', 'tv', 'kids'],
    });
    expect(results.map((r) => [r.key, r.available])).toEqual([
      ['movie', true],
      ['tv', true],
      ['kids', false],
    ]);
    expect(results.find((r) => r.key === 'kids')?.hits).toBe(0);
    expect(results.find((r) => r.key === 'movie')?.sample?.name).toBe('一部电影');
  });

  it('按 HOME 顺序返回全部默认分类', async () => {
    clearCategoryCache();
    const http = makeHttp({ '1': ['x'], '2': ['y'], '5': ['z'] });
    const results = await probeCategories({ sources: [source], http });
    expect(results.map((r) => r.key)).toEqual(HOME_CATEGORIES.map((c) => c.key));
  });

  it('每个分类完成时就回调，便于边探测边点亮入口', async () => {
    clearCategoryCache();
    const seen: string[] = [];
    const http = makeHttp({ '1': ['x'] });
    await probeCategories({
      sources: [source],
      http,
      keys: ['movie', 'kids'],
      onProbe: (r) => seen.push(`${r.key}:${r.available}`),
    });
    expect(seen.sort()).toEqual(['kids:false', 'movie:true']);
  });

  it('单个分类抛错时按不可用处理，不影响其他分类', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) return res('', 500);
        return res({ list: [] });
      },
    };
    const results = await probeCategories({ sources: [source], http, keys: ['movie', 'tv'] });
    expect(results.every((r) => !r.available)).toBe(true);
    expect(results).toHaveLength(2);
  });

  it('成人内容算作空分类（过滤后无线索即隐藏入口）', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '34', name: '伦理片', parentId: '1' },
    ]);
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) {
          return res({ class: [{ type_id: 1, type_name: '电影片' }, { type_id: 34, type_name: '伦理片' }] });
        }
        const typeId = /[?&]t=(\d+)/.exec(url)?.[1];
        if (typeId === '34') {
          return res({ list: [{ vod_id: 34, vod_name: '成人内容', type_name: '伦理片' }] });
        }
        return res({ list: [] });
      },
    };
    const results = await probeCategories({ sources: [source], http, keys: ['movie'] });
    // 唯一的条目被成人过滤拦下，电影分类实际为空
    expect(results[0].available).toBe(false);
  });

  it('所有源都失败时不缓存结论，下次还会重新探测', async () => {
    clearCategoryCache();
    clearProbeCache();
    let calls = 0;
    const broken: HttpClient = {
      async request() {
        calls += 1;
        throw new Error('连接超时');
      },
    };
    await probeCategories({ sources: [source], http: broken, keys: ['movie'] });
    const after = calls;
    expect(after).toBeGreaterThan(0);
    // 第二次必须再打一遍：把「全源失败」缓存 10 分钟，用户只能干等
    await probeCategories({ sources: [source], http: broken, keys: ['movie'] });
    expect(calls).toBeGreaterThan(after);
  });

  it('源正常答复但没有内容时算可信结论，可以被缓存', async () => {
    clearCategoryCache();
    clearProbeCache();
    let calls = 0;
    const empty: HttpClient = {
      async request(url) {
        calls += 1;
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影片' }] });
        return res({ pagecount: 0, list: [] });
      },
    };
    await probeCategories({ sources: [source], http: empty, keys: ['movie'] });
    const after = calls;
    await probeCategories({ sources: [source], http: empty, keys: ['movie'] });
    expect(calls).toBe(after);
  });

  it('源顺序不同但集合相同，仍然命中同一份探测缓存', async () => {
    clearCategoryCache();
    clearProbeCache();
    const second: SourceConfig = { key: 'k2', name: '乙源', url: 'https://b.example.com/api.php/provide/vod' };
    const counting: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影片' }] });
        return res({ pagecount: 0, list: [] });
      },
    };
    const probes: string[] = [];
    const onProbe = (r: { key: string }) => probes.push(r.key);
    // 顺序 A,B
    await probeCategories({ sources: [source, second], http: counting, keys: ['movie'], onProbe });
    const after = probes.length;
    // 顺序 B,A：源集合没变。注意 browseCategory 自带的 browse 缓存也会吸收网络请求，
    // 所以这里必须看「有没有再走一遍探测流程」而不是看请求数。
    await probeCategories({ sources: [second, source], http: counting, keys: ['movie'], onProbe });
    expect(probes.length).toBe(after);
  });

  it('探测结果是只读副本，调用方改动不会污染缓存', async () => {
    clearCategoryCache();
    clearProbeCache();
    const http = makeHttp({ '1': ['一部电影'] });
    const first = await probeCategories({ sources: [source], http, keys: ['movie'] });
    // 首次返回值被改：不能影响缓存里那份
    first[0].available = false;
    first[0].hits = 999;
    const second = await probeCategories({ sources: [source], http, keys: ['movie'] });
    expect(second[0].available).toBe(true);
    expect(second[0].hits).not.toBe(999);
    // 缓存命中返回的那份被改：也不能影响下一次命中的那份
    second[0].available = false;
    second[0].hits = 777;
    const third = await probeCategories({ sources: [source], http, keys: ['movie'] });
    expect(third[0].available).toBe(true);
    expect(third[0].hits).not.toBe(777);
  });
});

describe('probeCategories 快速模式（只看分类表）', () => {
  it('只请求 ac=list，不抓内容，可用性按分类表判定', async () => {
    clearCategoryCache();
    clearProbeCache();
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
        return res({ pagecount: 1, list: [{ vod_id: 1, vod_name: 'x', type_name: '电影' }] });
      },
    };
    const results = await probeCategories({
      sources: [source],
      http,
      keys: ['movie', 'kids'],
      fast: true,
    });
    // 常规模式要 2 × 2 个请求（每个分类一次表 + 一次内容），快速模式只要 1 次表
    expect(calls.filter((url) => url.includes('ac=list'))).toHaveLength(1);
    expect(calls.some((url) => url.includes('ac=videolist'))).toBe(false);
    expect(results.map((r) => [r.key, r.available])).toEqual([
      ['movie', true],
      ['kids', false],
    ]);
  });

  it('快速模式与常规模式的缓存互不串用', async () => {
    clearCategoryCache();
    clearProbeCache();
    // 分类表里有「少儿」，但该分类一条内容都没有：常规模式判不可用，快速模式判可用
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) {
          return res({
            class: [
              { type_id: 1, type_name: '电影' },
              { type_id: 5, type_name: '少儿' },
            ],
          });
        }
        const typeId = /[?&]t=(\d+)/.exec(url)?.[1] ?? '';
        const list = typeId === '1' ? [{ vod_id: 1, vod_name: 'x', type_name: '电影' }] : [];
        return res({ pagecount: 1, list });
      },
    };
    const slow = await probeCategories({ sources: [source], http, keys: ['kids'] });
    const fast = await probeCategories({ sources: [source], http, keys: ['kids'], fast: true });
    expect(slow[0].available).toBe(false);
    expect(fast[0].available).toBe(true);
  });
});

describe('分类表在途去重', () => {
  it('并发浏览两个分类时，同一个源的 ac=list 只请求一次', async () => {
    clearCategoryCache();
    let listCalls = 0;
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) {
          listCalls += 1;
          // 让请求「悬一会儿」：两个 browseCategory 必须真的并发经过 categoriesOf
          await new Promise((resolve) => setTimeout(resolve, 20));
          return res({
            class: [
              { type_id: 1, type_name: '电影' },
              { type_id: 2, type_name: '连续剧' },
            ],
          });
        }
        return res({ pagecount: 1, list: [] });
      },
    };
    await Promise.all([
      browseCategory({ sources: [source], key: 'movie', http }),
      browseCategory({ sources: [source], key: 'tv', http }),
    ]);
    expect(listCalls).toBe(1);
  });

  it('请求失败后不残留，下一次调用会重新尝试', async () => {
    clearCategoryCache();
    let attempts = 0;
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) {
          attempts += 1;
          if (attempts === 1) throw new Error('临时故障');
          return res({ class: [{ type_id: 1, type_name: '电影' }] });
        }
        return res({ pagecount: 1, list: [] });
      },
    };
    const first = await browseCategory({ sources: [source], key: 'movie', http });
    expect(first.outcomes[0].ok).toBe(false);
    const second = await browseCategory({ sources: [source], key: 'movie', http });
    expect(second.outcomes[0].ok).toBe(true);
  });
});

describe('browseCategory 的总时限', () => {
  it('慢源不再拖住整页：到点先返回已收到的内容，其余标超时', async () => {
    clearCategoryCache();
    const slow: SourceConfig = { key: 'slow', name: '慢源', url: 'https://slow.example.com/api.php/provide/vod' };
    const http: HttpClient = {
      async request(url, options) {
        if (url.includes('/slow.example.com')) {
          // 一直不答复，只有被取消时才结束
          return new Promise<HttpResponse>((_, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
          });
        }
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
        return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: '流浪地球', type_name: '电影' }] });
      },
    };
    const started = Date.now();
    const result = await browseCategory({
      sources: [source, slow],
      key: 'movie',
      http,
      budgetMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.items.map((i) => i.vodId)).toEqual(['11']);
    const slowOutcome = result.outcomes.find((o) => o.sourceKey === 'slow');
    expect(slowOutcome).toMatchObject({ ok: false, timedOut: true });
  });

  it('所有源都在预算内答复时不触发超时，结果与常规一致', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
        return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: '流浪地球', type_name: '电影' }] });
      },
    };
    const result = await browseCategory({ sources: [source], key: 'movie', http, budgetMs: 5_000 });
    expect(result.items).toHaveLength(1);
    expect(result.outcomes[0].timedOut).toBeFalsy();
    expect(result.outcomes[0].ok).toBe(true);
  });
});
