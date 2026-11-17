import { describe, expect, it } from 'vitest';
import {
  cmsUrl,
  extractEpisodesFromPlayUrl,
  filterAdultResults,
  filterRelevantResults,
  isRelevant,
  isSameShow,
  normalizeTitle,
  parseDetail,
  parseSearchList,
} from './cms';
import type { SourceConfig } from './types';

const source: SourceConfig = { key: 'custom_0', name: '示例源', url: 'https://example.com/api.php/provide/vod' };

describe('parseSearchList', () => {
  it('解析标准搜索结果', () => {
    const list = parseSearchList(
      {
        list: [
          { vod_id: 1, vod_name: '流浪地球', vod_pic: 'https://img/1.jpg', type_name: '科幻片', vod_year: '2019' },
        ],
      },
      source
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sourceKey: 'custom_0',
      vodId: '1',
      name: '流浪地球',
      typeName: '科幻片',
      year: '2019',
      sourceUrl: source.url,
    });
  });

  it('list 为 null 时返回空数组', () => {
    expect(parseSearchList({ list: null }, source)).toEqual([]);
  });

  it('list 不是数组时抛错', () => {
    expect(() => parseSearchList({ list: 'oops' }, source)).toThrow('API返回的数据格式无效');
    expect(() => parseSearchList(null, source)).toThrow('API返回的数据格式无效');
  });
});

describe('cmsUrl', () => {
  it('普通源用 ? 起头，并丢掉尾部斜杠', () => {
    expect(cmsUrl('https://x.com/api.php/provide/vod/', { ac: 'videolist', pg: 1 })).toBe(
      'https://x.com/api.php/provide/vod?ac=videolist&pg=1'
    );
  });

  it('源地址已带查询串时用 & 追加，不能让 wd 退化成一个参数值', () => {
    expect(cmsUrl('https://x.com/api.php?key=abc', { ac: 'videolist', wd: '斗罗', pg: 2 })).toBe(
      `https://x.com/api.php?key=abc&ac=videolist&wd=${encodeURIComponent('斗罗')}&pg=2`
    );
  });

  it('参数值一律编码', () => {
    expect(cmsUrl('https://x.com/vod', { wd: 'a&b=c' })).toBe('https://x.com/vod?wd=a%26b%3Dc');
  });
});

describe('extractEpisodesFromPlayUrl', () => {
  it('优先选包含 m3u8 的线路', () => {
    const playUrl =
      '第1集$https://x.com/share/abc.html#第2集$https://x.com/share/def.html$$$第1集$https://cdn.x.com/a/index.m3u8#第2集$https://cdn.x.com/b/index.m3u8';
    expect(extractEpisodesFromPlayUrl(playUrl)).toEqual([
      'https://cdn.x.com/a/index.m3u8',
      'https://cdn.x.com/b/index.m3u8',
    ]);
  });

  it('无 m3u8 时回退第一条线路，并过滤非 http 地址', () => {
    const playUrl = '第1集$ftp://x/a.mp4#第2集$https://x.com/b.mp4';
    expect(extractEpisodesFromPlayUrl(playUrl)).toEqual(['https://x.com/b.mp4']);
  });

  it('空输入返回空数组', () => {
    expect(extractEpisodesFromPlayUrl('')).toEqual([]);
  });

  it('URL 自身含 $ 时只按第一个 $ 切，不把地址截断', () => {
    const playUrl = '第1集$https://cdn.x.com/a/index.m3u8$sign=abc';
    expect(extractEpisodesFromPlayUrl(playUrl)).toEqual(['https://cdn.x.com/a/index.m3u8$sign=abc']);
  });

  it('保留 m3u8 的签名查询参数（丢了签名就是 403）', () => {
    const playUrl = '第1集$https://cdn.x.com/a/index.m3u8?token=xyz&expires=123';
    expect(extractEpisodesFromPlayUrl(playUrl)).toEqual([
      'https://cdn.x.com/a/index.m3u8?token=xyz&expires=123',
    ]);
  });

  it('整集只给裸 URL、没有「集名$」前缀时也能取到', () => {
    const playUrl = '第1集$https://x.com/a.mp4#https://x.com/b.mp4';
    expect(extractEpisodesFromPlayUrl(playUrl)).toEqual(['https://x.com/a.mp4', 'https://x.com/b.mp4']);
  });
});

describe('parseDetail', () => {
  it('解析详情并提取剧集', () => {
    const detail = parseDetail(
      {
        list: [
          {
            vod_name: '三体',
            vod_pic: 'https://img/3.jpg',
            vod_content: '简介',
            type_name: '国产剧',
            vod_year: '2023',
            vod_play_url: '第1集$https://cdn/1.m3u8#第2集$https://cdn/2.m3u8',
          },
        ],
      },
      source
    );
    expect(detail.episodes).toHaveLength(2);
    expect(detail.videoInfo).toMatchObject({ title: '三体', typeName: '国产剧', sourceKey: 'custom_0' });
  });

  it('无剧集时从简介兜底提取 m3u8', () => {
    const detail = parseDetail(
      { list: [{ vod_name: 'x', vod_content: '播放地址：$https://cdn/x/index.m3u8' }] },
      source
    );
    expect(detail.episodes).toEqual(['https://cdn/x/index.m3u8']);
  });

  it('空列表抛错', () => {
    expect(() => parseDetail({ list: [] }, source)).toThrow('获取到的详情内容无效');
  });
});

describe('相关性过滤', () => {
  it('忽略标点与大小写差异', () => {
    expect(isRelevant('摔跤吧!爸爸', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('SPY×FAMILY', 'spy family')).toBe(true);
  });

  it('多词查询要求全部命中', () => {
    const items = [{ name: '庆余年 第二季' }, { name: '庆余年' }, { name: '繁花' }];
    expect(filterRelevantResults(items, '庆余年 第二季').map((i) => i.name)).toEqual(['庆余年 第二季']);
  });

  it('季数必须匹配，不能把第 2 季当成 12 集', () => {
    expect(isRelevant('庆余年 第二季', '庆余年2')).toBe(true);
    expect(isRelevant('庆余年 第三季', '庆余年2')).toBe(false);
    expect(isRelevant('某剧 12', '某剧 2')).toBe(false);
  });

  it('normalizeTitle 去掉标点与空白', () => {
    expect(normalizeTitle('Hello, World! 你好')).toBe('helloworld你好');
  });
});

describe('成人内容过滤', () => {
  it('命中关键词时过滤', () => {
    const items = [{ typeName: '伦理片' }, { typeName: '科幻片' }];
    expect(filterAdultResults(items, true)).toEqual([{ typeName: '科幻片' }]);
    expect(filterAdultResults(items, false)).toHaveLength(2);
  });
});

describe('isSameShow（同一部剧的判定）', () => {
  it('同名与标点差异算同一部', () => {
    expect(isSameShow('庆余年', '庆余年')).toBe(true);
    expect(isSameShow('庆余年 第一季', '庆余年')).toBe(true);
    expect(isSameShow('The.Last.of.Us', 'the last of us')).toBe(true);
  });

  it('续集不算同一部', () => {
    // 这是自动换源最致命的误判：季数不同时换过去会播成另一部剧
    expect(isSameShow('庆余年 第二季', '庆余年')).toBe(false);
    expect(isSameShow('庆余年2', '庆余年')).toBe(false);
    expect(isSameShow('庆余年', '庆余年 第二季')).toBe(false);
  });

  it('片名后面紧跟的数字视为续集', () => {
    expect(isSameShow('流浪地球2 国语', '流浪地球')).toBe(false);
    expect(isSameShow('流浪地球', '流浪地球2')).toBe(false);
  });

  it('带说明的后缀仍算同一部', () => {
    expect(isSameShow('庆余年 第二季 4K', '庆余年 第二季')).toBe(true);
    expect(isSameShow('繁花(2024) 全集', '繁花')).toBe(true);
  });

  it('不同的剧不算同一部', () => {
    expect(isSameShow('庆余年', '繁花')).toBe(false);
    expect(isSameShow('三体', '三体 第二季')).toBe(false);
    expect(isSameShow('', '庆余年')).toBe(false);
  });
});
