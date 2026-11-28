import { describe, expect, it } from 'vitest';
import { exportSourceList, normalizeSubscription, parseRelaxedJson, parseSubscription } from './subscriptions';
import {
  DEFAULT_SETTINGS,
  dedupeHistory,
  findResumeByTitle,
  normalizeHistoryEntry,
  normalizeSettings,
  parseSnapshot,
  toggleFavorite,
  toggleLiveFavorite,
  upsertHistory,
} from './storage';
import { currentAndNext, parseXmltv, parseXmltvTime } from './live';
import {
  clampEpisodeIndex,
  episodeLabel,
  formatTime,
  isValidSourceUrl,
  stableKey,
  trimSlash,
} from './format';

describe('parseSubscription', () => {
  it('解析 LibreTV-SourceList', () => {
    const parsed = parseSubscription(
      JSON.stringify({
        name: '我的源',
        version: 2,
        sources: [{ name: 'A', url: 'https://a/api.php/provide/vod/' }],
        liveSources: [{ name: 'L', url: 'https://l/list.m3u', epg: 'https://l/epg.xml.gz' }],
      }),
      'https://sub.example.com/list.json'
    );
    expect(parsed.name).toBe('我的源');
    expect(parsed.stats.format).toBe('libretv');
    expect(parsed.sources[0]).toMatchObject({ name: 'A', url: 'https://a/api.php/provide/vod' });
    expect(parsed.sources[0].key).toMatch(/^sub_.+_0$/);
    expect(parsed.liveSources[0].epg).toBe('https://l/epg.xml.gz');
  });

  it('解析 TVBOX 配置并跳过 Spider/XML/不可搜索', () => {
    const parsed = normalizeSubscription({
      sites: [
        { name: 'CMS', api: 'https://cms/api.php/provide/vod', type: 1 },
        { name: 'Spider', api: 'csp_AppYs', type: 3 },
        { name: 'XML', api: 'https://x/api.php/provide/vod/at/xml', type: 0 },
        { name: 'NoSearch', api: 'https://n/api.php/provide/vod', type: 1, searchable: 0 },
        { name: 'Implicit', api: 'https://i/api.php/provide/vod', type: 0 },
      ],
      lives: [
        { name: '直播', url: 'https://l/list.m3u8', type: 0 },
        { name: 'TXT', url: 'https://l/channels.txt', type: 0 },
      ],
    });
    expect(parsed.sources.map((s) => s.name)).toEqual(['CMS', 'Implicit']);
    expect(parsed.liveSources).toHaveLength(1);
    expect(parsed.stats.skippedByReason).toMatchObject({ spider: 1, xml: 1, unsearchable: 1, nonM3uLive: 1 });
  });

  it('裸数组视为点播源', () => {
    const parsed = normalizeSubscription([{ name: 'A', url: 'https://a/api.php/provide/vod' }]);
    expect(parsed.stats.format).toBe('array');
    expect(parsed.sources).toHaveLength(1);
  });

  it('两份裸数组订阅的源 key 不会撞在一起', () => {
    // 撞 key 的后果：两个订阅的源在启用状态里只能一起勾选，
    // 健康度/画质探测按 key 记账会互相覆盖，历史回查也会指到另一个订阅的源上。
    const a = normalizeSubscription(
      [{ name: 'A0', url: 'https://a/api.php/provide/vod' }],
      'https://a/list.json',
    );
    const b = normalizeSubscription(
      [{ name: 'B0', url: 'https://b/api.php/provide/vod' }],
      'https://b/list.json',
    );
    expect(a.sources[0].key).not.toBe(b.sources[0].key);
    // 同一个订阅内部仍然从 0 开始编，保持稳定
    expect(a.sources[0].key).toMatch(/^sub_.+_0$/);
    expect(b.sources[0].key).toMatch(/^sub_.+_0$/);
  });

  it('同一个地址的裸数组订阅 key 稳定', () => {
    const list = [{ name: 'A0', url: 'https://a/api.php/provide/vod' }];
    const first = normalizeSubscription(list, 'https://a/list.json');
    const second = normalizeSubscription(list, 'https://a/list.json');
    expect(first.sources[0].key).toBe(second.sources[0].key);
  });

  it('按 URL 去重并剔除非法地址', () => {
    const parsed = normalizeSubscription({
      sources: [
        { url: 'https://a/api.php/provide/vod' },
        { url: 'https://a/api.php/provide/vod/' },
        { url: 'ftp://bad' },
        { url: 'not-a-url' },
      ],
    });
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.stats.skippedByReason.invalidUrl).toBe(2);
  });

  it('格式不对时抛错', () => {
    expect(() => normalizeSubscription({ foo: 1 })).toThrow('订阅内容格式不正确');
    expect(() => parseSubscription('not json')).toThrow('订阅内容不是合法的 JSON');
  });

  it('宽容解析注释与尾随逗号', () => {
    const text = `{
      // 注释
      "sources": [
        { "name": "A", "url": "https://a/api.php/provide/vod" }, // 尾随逗号在下一行
      ],
    }`;
    expect(() => parseSubscription(text)).not.toThrow();
    const obj = parseRelaxedJson<{ a: number[] }>('{ "a": [1,2,] }');
    expect(obj.a).toEqual([1, 2]);
  });

  it('exportSourceList 可被自身再次解析', () => {
    const json = exportSourceList(
      [{ key: 'k', name: 'A', url: 'https://a/api.php/provide/vod' }],
      [{ key: 'l', name: 'L', url: 'https://l/list.m3u' }]
    );
    const parsed = parseSubscription(json);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.liveSources).toHaveLength(1);
  });
});

describe('storage 纯函数', () => {
  it('upsertHistory 去重置顶并裁剪', () => {
    let list = upsertHistory([], { id: 'a:1', sourceKey: 'a', vodId: '1', title: 'A', sourceName: 's', episodeIndex: 0, episodeCount: 10, position: 5, duration: 100 });
    list = upsertHistory(list, { id: 'a:2', sourceKey: 'a', vodId: '2', title: 'B', sourceName: 's', episodeIndex: 1, episodeCount: 2, position: 1, duration: 10 });
    list = upsertHistory(list, { ...list[0], position: 30 });
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('a:2');
    expect(list[0].position).toBe(30);
  });

  it('upsertHistory 跨源按片名去重（同一部片子只留一条）', () => {
    const base = { sourceName: 's', episodeIndex: 0, episodeCount: 1, position: 5, duration: 100 };
    let list = upsertHistory([], { ...base, id: 'ffzy:11', sourceKey: 'ffzy', vodId: '11', title: '大夏守夜人' });
    list = upsertHistory(list, { ...base, id: 'lzi:22', sourceKey: 'lzi', vodId: '22', title: '大夏守夜人' });
    expect(list).toHaveLength(1);
    // 保留最近播放的那条，切换到新源
    expect(list[0].id).toBe('lzi:22');
    // 不同片子仍然各留一条
    list = upsertHistory(list, { ...base, id: 'lzi:33', sourceKey: 'lzi', vodId: '33', title: '沙丘' });
    expect(list).toHaveLength(2);
  });

  it('upsertHistory 忽略片名里的空格与标点', () => {
    const base = { sourceName: 's', episodeIndex: 0, episodeCount: 1, position: 5, duration: 100 };
    let list = upsertHistory([], { ...base, id: 'a:1', sourceKey: 'a', vodId: '1', title: 'The Dark Knight  2008' });
    list = upsertHistory(list, { ...base, id: 'b:2', sourceKey: 'b', vodId: '2', title: 'thedarkknight2008' });
    expect(list).toHaveLength(1);
  });

  it('dedupeHistory 清掉老数据里的重复记录并保留最近的', () => {
    const mk = (id: string, title: string, updatedAt: number) => ({
      id,
      sourceKey: id.split(':')[0],
      vodId: id.split(':')[1],
      title,
      sourceName: 's',
      episodeIndex: 0,
      episodeCount: 1,
      position: 1,
      duration: 10,
      updatedAt,
    });
    const list = [mk('a:1', '大夏守夜人', 300), mk('b:2', '大夏守夜人', 200), mk('c:3', '沙丘', 100)];
    const deduped = dedupeHistory(list);
    expect(deduped.map((h) => h.id)).toEqual(['a:1', 'c:3']);
    // 幂等
    expect(dedupeHistory(deduped)).toEqual(deduped);
  });

  it('findResumeByTitle 能跨源找到续播点', () => {
    const entry = {
      id: 'ffzy:11',
      sourceKey: 'ffzy',
      vodId: '11',
      title: '大夏守夜人',
      sourceName: 's',
      episodeIndex: 3,
      episodeCount: 10,
      position: 1,
      duration: 10,
      updatedAt: 1,
    };
    expect(findResumeByTitle([entry], '大夏守夜人')?.episodeIndex).toBe(3);
    expect(findResumeByTitle([entry], '别的片')).toBeUndefined();
  });

  it('同名不同年的翻拍片不会被合并', () => {
    const base = { sourceName: 's', episodeIndex: 0, episodeCount: 1, position: 5, duration: 100 };
    let list = upsertHistory([], { ...base, id: 'a:1', sourceKey: 'a', vodId: '1', title: '西游记', year: '1986' });
    list = upsertHistory(list, { ...base, id: 'b:2', sourceKey: 'b', vodId: '2', title: '西游记', year: '2010' });
    expect(list).toHaveLength(2);
    // 同一年、不同源，仍然是同一部片子
    list = upsertHistory(list, { ...base, id: 'c:3', sourceKey: 'c', vodId: '3', title: '西游记', year: '2010' });
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('c:3');
  });

  it('旧记录没有年份时按片名合并，不会凭空多出一条', () => {
    const base = { sourceName: 's', episodeIndex: 0, episodeCount: 1, position: 5, duration: 100 };
    // 老版本存下的记录（没有 year）
    let list = upsertHistory([], { ...base, id: 'a:1', sourceKey: 'a', vodId: '1', title: '大夏守夜人' });
    // 新版本从另一个源又播了一次，这次带上了年份
    list = upsertHistory(list, { ...base, id: 'b:2', sourceKey: 'b', vodId: '2', title: '大夏守夜人', year: '2026' });
    expect(list).toHaveLength(1);
    expect(list[0].year).toBe('2026');
  });

  it('dedupeHistory 不会把同名不同年的记录删掉', () => {
    const mk = (id: string, title: string, year: string | undefined, updatedAt: number) => ({
      id,
      sourceKey: id.split(':')[0],
      vodId: id.split(':')[1],
      title,
      year,
      sourceName: 's',
      episodeIndex: 0,
      episodeCount: 1,
      position: 1,
      duration: 10,
      updatedAt,
    });
    const list = [
      mk('a:1', '西游记', '1986', 300),
      mk('b:2', '西游记', '2010', 200),
      mk('c:3', '西游记', '1986', 100),
    ];
    expect(dedupeHistory(list).map((h) => h.id)).toEqual(['a:1', 'b:2']);
  });

  it('toggleFavorite 可增删', () => {
    const entry = { id: 'a:1', sourceKey: 'a', vodId: '1', title: 'A' };
    let list = toggleFavorite([], entry);
    expect(list).toHaveLength(1);
    list = toggleFavorite(list, entry);
    expect(list).toHaveLength(0);
  });

  it('normalizeSettings 补默认值', () => {
    expect(normalizeSettings({ adFilter: false })).toMatchObject({ adFilter: false, adultFilter: DEFAULT_SETTINGS.adultFilter });
  });

  it('parseSnapshot 拒绝非法输入并兼容 customAPIs', () => {
    expect(parseSnapshot('nope')).toBeNull();
    const snap = parseSnapshot(JSON.stringify({ customAPIs: [{ key: 'k', name: 'A', url: 'https://a' }], history: [] }));
    expect(snap?.sources).toHaveLength(1);
    expect(snap?.selectedKeys).toEqual(['k']);
  });

  /**
   * H4 回归：过去 `parseSnapshot` 只要「能 JSON.parse 出对象」就返回合法快照，
   * 于是导入一个无关 JSON 会把源/历史/收藏全部覆盖成空（且不重置 defaultsSeeded，
   * 内置源也回不来）。现在必须显式拒绝。
   */
  it('parseSnapshot 对无关 JSON 返回 null，避免一键清空本地数据', () => {
    expect(parseSnapshot('{}')).toBeNull();
    expect(parseSnapshot('{"foo":1}')).toBeNull();
    expect(parseSnapshot('{"version":1}')).toBeNull();
    // 有字段名但条目全部非法（缺 url / 非 http(s) / 缺 title）
    expect(parseSnapshot('{"sources":[{"key":"k","url":"file:///etc/passwd"}]}')).toBeNull();
    expect(parseSnapshot('{"history":[{"sourceKey":"s"}]}')).toBeNull();
    expect(parseSnapshot('[1,2,3]')).toBeNull();
  });

  it('parseSnapshot 逐条校验历史，坏条目被丢弃而不是让 normalizeTitle 抛错', () => {
    const snap = parseSnapshot(
      JSON.stringify({
        sources: [{ key: 's', name: 'S', url: 'https://s/api' }],
        history: [
          { sourceKey: 's', vodId: '1', title: null },
          { sourceKey: 's', vodId: '2', title: '   ' },
          { sourceKey: 's', vodId: '3', title: '三体', episodeIndex: 99, episodeCount: 10 },
        ],
      })
    );
    expect(snap).not.toBeNull();
    expect(snap!.history).toHaveLength(1);
    expect(snap!.history[0]).toMatchObject({ id: 's:3', title: '三体' });
    // 越界集数在导入时就被夹回合法范围
    expect(snap!.history[0].episodeIndex).toBe(9);
    expect(() => snap!.history.map((h) => h.title.toLowerCase())).not.toThrow();
  });

  it('parseSnapshot 去重源并按历史/收藏上限裁剪', () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
      sourceKey: 's',
      vodId: String(i),
      title: `剧${i}`,
    }));
    const snap = parseSnapshot(
      JSON.stringify({
        sources: [
          { key: 'a', name: 'A', url: 'https://dup/api' },
          { key: 'b', name: 'B', url: 'https://dup/api' },
          { key: 'c', name: 'C', url: 'not-a-url' },
        ],
        history: many,
      })
    );
    expect(snap!.sources).toHaveLength(1);
    expect(snap!.sources[0].key).toBe('a');
    expect(snap!.history).toHaveLength(200);
  });

  it('parseSnapshot 逐字段重建源，name 不是字符串时退回主机名', () => {
    // 旧实现 `{ ...obj, url }` 原样透传：name 为 123 会一路进
    // SourceConfig.name: string，随后 group.ts 的 localeCompare 抛 TypeError，
    // 聚合列表白屏，而且已经落盘，重启后依旧。
    const snap = parseSnapshot(
      JSON.stringify({
        sources: [
          { key: 'a', url: 'https://bad/api', name: 123 },
          { key: 'b', url: 'https://good/api', name: ' 良好  ', detail: 'https://good/detail/' },
          { key: 'c', url: 'https://c/api', detail: 'javascript:alert(1)', isAdult: 'yes' },
        ],
      })
    );
    expect(snap!.sources[0].name).toBe('bad');
    expect(typeof snap!.sources[0].name).toBe('string');
    expect(snap!.sources[1].name).toBe('良好');
    expect(snap!.sources[1].detail).toBe('https://good/detail/');
    // 非法 detail 与真值判断都要收敛：不能把 'yes' 当成人标记
    expect(snap!.sources[2].detail).toBeUndefined();
    expect(snap!.sources[2].isAdult).toBeUndefined();
    expect(snap!.sources[2].name).toBe('c');
    expect(() => snap!.sources.map((s) => s.name.localeCompare('x', 'zh-CN'))).not.toThrow();
  });

  it('parseSnapshot 的选中项与真实源求交', () => {
    const snap = parseSnapshot(
      JSON.stringify({
        sources: [{ key: 'a', name: 'A', url: 'https://a/api' }],
        liveSources: [{ key: 'L1', name: 'L1', url: 'https://l/1.m3u' }],
        // b 对应的源已经被删掉了，不能继续占着「已启用」
        selectedKeys: ['a', 'b', 42],
        liveSelectedKeys: ['L1', 'L2'],
      })
    );
    expect(snap!.selectedKeys).toEqual(['a']);
    expect(snap!.liveSelectedKeys).toEqual(['L1']);
  });
});

describe('EPG', () => {
  it('parseXmltvTime 支持时区与 Z', () => {
    expect(parseXmltvTime('20240101120000 +0800')).toBe(Date.UTC(2024, 0, 1, 4, 0, 0));
    expect(parseXmltvTime('20240101120000')).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
    expect(parseXmltvTime('bad')).toBeNaN();
  });

  it('parseXmltv 按窗口裁剪并解码实体', () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);
    const xml = `<tv>
      <programme start="20240101110000 +0000" stop="20240101130000 +0000" channel="cctv1">
        <title>新闻 &amp; 联播</title><desc><![CDATA[描述]]></desc>
      </programme>
      <programme start="20240101130000 +0000" stop="20240101140000 +0000" channel="cctv1"><title>焦点访谈</title></programme>
      <programme start="20240102000000 +0000" stop="20240102010000 +0000" channel="cctv1"><title>太远了</title></programme>
    </tv>`;
    const map = parseXmltv(xml, 3 * 3600 * 1000, now);
    const list = map.get('cctv1')!;
    expect(list.map((p) => p.title)).toEqual(['新闻 & 联播', '焦点访谈']);
    expect(currentAndNext(list, now).current?.title).toBe('新闻 & 联播');
    expect(currentAndNext(list, now).next?.title).toBe('焦点访谈');
  });
});

describe('format 辅助', () => {
  it('formatTime', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(75)).toBe('01:15');
    expect(formatTime(3675)).toBe('1:01:15');
    expect(formatTime(-1)).toBe('00:00');
  });

  it('trimSlash / stableKey / episodeLabel', () => {
    expect(trimSlash('https://a/b///')).toBe('https://a/b');
    expect(stableKey('abc')).toBe(stableKey('abc'));
    expect(stableKey('abc')).not.toBe(stableKey('abd'));
    // 集号只按数组下标，不再从 URL 里抠数字：采集站地址里的数字和「第几集」不是一回事
    expect(episodeLabel(0)).toBe('第 1 集');
    expect(episodeLabel(3)).toBe('第 4 集');
  });

  it('clampEpisodeIndex 把越界集数收回列表范围', () => {
    expect(clampEpisodeIndex(14, 16)).toBe(14);
    expect(clampEpisodeIndex(16, 16)).toBe(15); // 最后一集看完会写成 episodeCount
    expect(clampEpisodeIndex(-3, 16)).toBe(0);
    expect(clampEpisodeIndex(5, 0)).toBe(0); // 空列表不能返回负数
    expect(clampEpisodeIndex(Number.NaN, 16)).toBe(0);
  });

  it('normalizeHistoryEntry 修掉存量的越界集数', () => {
    const base = {
      id: 'q:1',
      sourceKey: 'q',
      vodId: '1',
      title: '盲眼驭诡师',
      sourceName: '量子资源',
      position: 120,
      duration: 545,
      updatedAt: 1,
    };
    // 「第 17 / 16 集」这种卡片就是从这里来的
    expect(normalizeHistoryEntry({ ...base, episodeIndex: 16, episodeCount: 16 }).episodeIndex).toBe(15);
    expect(normalizeHistoryEntry({ ...base, episodeIndex: 14, episodeCount: 16 }).episodeIndex).toBe(14);
    // 没有集数上限的旧记录原样返回，不能把它错误地归零
    expect(normalizeHistoryEntry({ ...base, episodeIndex: 3, episodeCount: 0 }).episodeIndex).toBe(3);
  });
});

describe('isValidSourceUrl', () => {
  it('只放行能被 URL 解析的 http(s) 地址', () => {
    expect(isValidSourceUrl('https://a.example.com/api.php/provide/vod')).toBe(true);
    expect(isValidSourceUrl('http://127.0.0.1:8080/api')).toBe(true);
    // 下面这些旧实现（/^https?:\/\/.+/）全都放过，结果一请求就炸成英文报错
    expect(isValidSourceUrl('https://exa mple.com/api')).toBe(false);
    expect(isValidSourceUrl('http://[')).toBe(false);
    expect(isValidSourceUrl('https://')).toBe(false);
    expect(isValidSourceUrl('ftp://a.example.com/api')).toBe(false);
    expect(isValidSourceUrl('')).toBe(false);
  });
});

describe('toggleLiveFavorite', () => {
  it('直播收藏也受条数上限约束', () => {
    let list: Parameters<typeof toggleLiveFavorite>[0] = [];
    for (let i = 0; i < 5; i++) {
      list = toggleLiveFavorite(list, { url: `https://l.example.com/${i}.m3u8`, name: `台 ${i}` }, 3);
    }
    // 新的在前、旧的被裁掉：一个两万频道的源不会把快照撑爆
    expect(list.map((f) => f.name)).toEqual(['台 4', '台 3', '台 2']);
    // 取消收藏不受上限影响
    expect(toggleLiveFavorite(list, { url: 'https://l.example.com/4.m3u8', name: '台 4' }, 3)).toHaveLength(2);
  });
});
