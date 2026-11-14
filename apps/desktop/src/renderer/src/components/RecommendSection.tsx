import { useEffect, useState, type ReactNode } from 'react';
import {
  DOUBAN_TAGS,
  HOT_LISTS,
  WEEKDAY_LABELS,
  filterAdultRecommendItems,
  recommendSourceLabel,
  type HotListId,
  type RecommendItem,
  type RecommendSource,
} from '@librextv/core';
import { fetchRecommend, type RecommendQuery } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { HScrollRow } from './HScrollRow';
import { Poster } from './Poster';

/**
 * 首页推荐位。
 *
 * 与片源完全解耦：内容来自豆瓣 / Bangumi / 影视榜单，点击后只把标题交给
 * 现有的多源搜索。因此冷启动、一个源都没配时首页也不会只剩分类按钮。
 *
 * 这里只做「展示 + 枚举切换」，抓取、UA/Referer 伪装与缓存都在主进程
 * （apps/desktop/src/main/recommend.ts），页面不直连第三方。
 */

/** 首页是「个人看板 + 发现」的组合，推荐区只做预览，避免 50 张卡把续播/收藏挤到屏幕外 */
const MAX_PREVIEW = 24;

const SOURCE_SHORT: Record<RecommendSource, string> = {
  bangumi: 'Bangumi',
  'hot-list': '榜单',
  douban: '豆瓣',
};

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`chip${active ? ' on' : ''}`}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function RecommendSection({
  source,
  onSearch,
}: {
  source: RecommendSource;
  onSearch: (keyword: string) => void;
}) {
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const [items, setItems] = useState<RecommendItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [bangumiWeekday, setBangumiWeekday] = useState<number | 'all'>(() => {
    // 默认显示今天：新番放送表按星期组织，直接给出「今天更新什么」比全量更有用
    const day = new Date().getDay();
    return day === 0 ? 7 : day;
  });
  const [hotListId, setHotListId] = useState<HotListId>('douban_movie_weekly');
  const [doubanType, setDoubanType] = useState<'movie' | 'tv'>('movie');
  const [doubanTag, setDoubanTag] = useState('热门');

  /** 电影标签与剧集标签不是同一套：切类型时必须回到两边都有的「热门」 */
  const switchDoubanType = (type: 'movie' | 'tv') => {
    setDoubanType(type);
    if (!DOUBAN_TAGS[type].includes(doubanTag)) setDoubanTag('热门');
  };

  // 换推荐源时先清空，避免把上一个源的卡片短暂标成新源的来源
  useEffect(() => {
    setItems(null);
    setError(null);
  }, [source]);

  useEffect(() => {
    let alive = true;
    const query: RecommendQuery =
      source === 'bangumi'
        ? { kind: 'bangumi' }
        : source === 'hot-list'
          ? { kind: 'hot-list', id: hotListId }
          : { kind: 'douban', type: doubanType, tag: doubanTag };

    setLoading(true);
    setError(null);
    void fetchRecommend(query)
      .then((next) => {
        if (!alive) return;
        setItems(next);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setItems(null);
        setError(err instanceof Error ? err.message : '推荐内容加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [source, hotListId, doubanType, doubanTag, nonce]);

  const filtered = items ? filterAdultRecommendItems(items, adultFilter) : [];
  const visible =
    source === 'bangumi' && bangumiWeekday !== 'all'
      ? filtered.filter((item) => item.weekday === bangumiWeekday)
      : filtered;
  const shown = visible.slice(0, MAX_PREVIEW);

  return (
    <>
      <div className="section-title">
        <span>发现 · {recommendSourceLabel(source)}</span>
        <span className="hint">
          {loading ? '加载中…' : `${visible.length} 条 · 点击卡片按标题搜索`}
        </span>
      </div>

      <div className="row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {source === 'bangumi' ? (
          <>
            <Chip active={bangumiWeekday === 'all'} onClick={() => setBangumiWeekday('all')}>
              全部
            </Chip>
            {WEEKDAY_LABELS.map((label, index) => (
              <Chip key={label} active={bangumiWeekday === index + 1} onClick={() => setBangumiWeekday(index + 1)}>
                {label}
              </Chip>
            ))}
          </>
        ) : null}

        {source === 'hot-list'
          ? HOT_LISTS.map((list) => (
              <Chip key={list.id} active={hotListId === list.id} onClick={() => setHotListId(list.id)}>
                {list.label}
              </Chip>
            ))
          : null}

        {source === 'douban' ? (
          <>
            <Chip active={doubanType === 'movie'} onClick={() => switchDoubanType('movie')}>
              电影
            </Chip>
            <Chip active={doubanType === 'tv'} onClick={() => switchDoubanType('tv')}>
              剧集
            </Chip>
            {DOUBAN_TAGS[doubanType].map((tag) => (
              <Chip key={tag} active={doubanTag === tag} onClick={() => setDoubanTag(tag)}>
                {tag}
              </Chip>
            ))}
          </>
        ) : null}
      </div>

      {error ? (
        <div className="empty" style={{ padding: 28 }}>
          <div style={{ fontSize: 13 }}>推荐加载失败：{error}</div>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn ghost" onClick={() => setNonce((n) => n + 1)}>
              重试
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: '#6b7688' }}>
            可稍后再试，或在「设置 → 播放设置」里关闭首页推荐 / 换一个推荐源。
          </div>
        </div>
      ) : loading && shown.length === 0 ? (
        <div className="empty" style={{ padding: 34 }}>
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      ) : shown.length === 0 ? (
        <div className="empty" style={{ padding: 34 }}>
          <div style={{ fontSize: 12.5 }}>这个分类暂时没有推荐内容。</div>
        </div>
      ) : (
        <HScrollRow>
          {shown.map((item) => (
            <button
              key={`${item.source}:${item.id}`}
              type="button"
              className="card"
              onClick={() => onSearch(item.title)}
              title={`${item.title}（点击按标题搜索）`}
            >
              <Poster src={item.cover} alt={item.title} />
              {item.rating ? <span className="badge">{item.rating} 分</span> : null}
              <div className="card-body">
                <div className="card-title" title={item.title}>
                  {item.title}
                </div>
                <div className="card-meta">
                  <span>{SOURCE_SHORT[item.source]}</span>
                  <span>· {item.isTv ? '剧集' : '电影'}</span>
                </div>
              </div>
            </button>
          ))}
        </HScrollRow>
      )}
    </>
  );
}
