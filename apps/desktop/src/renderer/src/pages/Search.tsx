import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  allEntries,
  dedupeEntries,
  describeDisabledRemaining,
  describeSourceDisable,
  groupSearchResults,
  isSourceDisabled,
  normalizeQuery,
  rankSearchGroups,
  remotePinyinSearch,
  remotePinyinSources,
  searchSources,
  suggestFromIndex,
  suggestionToItems,
  type AggregatedGroup,
  type SourceSearchOutcome,
  type SuggestionGroup,
  type TitleIndexEntry,
} from '@librextv/core';
import { http } from '../lib/bridge';
import { cachedSearch, rememberSearch } from '../lib/catalog-cache';
import { currentIndex, subscribeIndex } from '../lib/title-index-warmer';
import { useAppStore } from '../lib/store';
import { DetailPanel } from '../components/DetailPanel';
import { Icon } from '../components/Icons';
import { LetterKeyboard } from '../components/LetterKeyboard';
import { Poster } from '../components/Poster';
import { useToast } from '../components/toast-context';
import type { WatchTarget } from './Watch';

interface SearchState {
  outcomes: SourceSearchOutcome[];
  groups: AggregatedGroup[];
}

/** 远端拼音检索的节流：用户连打字母时不必每个字母都打网络 */
const REMOTE_DEBOUNCE_MS = 380;
/** 远端结果缓存条数上限（按 needle 缓存，回删/重敲时免重复请求；不封顶会一直涨） */
const REMOTE_CACHE_LIMIT = 64;

export function SearchPage({
  keyword,
  nonce,
  onPlay,
  onOpenSettings,
}: {
  keyword: string;
  /** 每次提交搜索 +1：同一个词再搜一遍时 keyword 不变，只能靠它触发重新请求 */
  nonce: number;
  onPlay: (target: WatchTarget) => void;
  onOpenSettings: () => void;
}) {
  // 注意：不要在 selector 里返回新数组（zustand v5 会判定快照持续变化而死循环），
  // 这里选原始数组后用 useMemo 派生。
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sources = useMemo(
    () => allSources.filter((s) => selectedKeys.includes(s.key)),
    [allSources, selectedKeys]
  );
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const recordSourceOutcome = useAppStore((s) => s.recordSourceOutcome);
  const restoreSourceHealth = useAppStore((s) => s.restoreSourceHealth);
  const settings = useAppStore((s) => s.settings);
  const recentSearches = useAppStore((s) => s.recentSearches);
  const addRecentSearch = useAppStore((s) => s.addRecentSearch);
  const toast = useToast();

  // 暂停只影响「这次搜索发不发请求」，不动用户勾选：恢复后不用再去设置里重新打勾
  const pausedSources = useMemo(() => {
    const at = Date.now();
    return sources.filter((s) => isSourceDisabled(sourceHealth[s.key], at));
  }, [sources, sourceHealth]);
  const searchableSources = useMemo(() => {
    const paused = new Set(pausedSources.map((s) => s.key));
    return sources.filter((s) => !paused.has(s.key));
  }, [sources, pausedSources]);

  /* ---------------------------- 建议（左键盘 + 右列表） ---------------------------- */

  /** 当前输入串（与「已提交的 keyword」分离：输入时右栏实时刷新，回车才真正搜） */
  const [draft, setDraft] = useState('');
  /** 本地索引 + 远端补齐合并后的候选池 */
  const [pool, setPool] = useState<TitleIndexEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  /**
   * 结果区标题要显示的词。
   *
   * 不能直接读 `keyword` prop：从字母键盘 / 最近搜索 / 建议行发起的搜索都不会回写父级
   * 的 keyword，标题就会一直显示上一次从外部传进来的词，跟下面的结果对不上。
   */
  const [lastWord, setLastWord] = useState('');
  const remoteTimer = useRef<number | null>(null);
  const remoteAbort = useRef<AbortController | null>(null);
  const remoteCache = useRef(new Map<string, TitleIndexEntry[]>());

  // 索引在后台缓慢长大：订阅更新，让右栏建议跟着变多。
  //
  // 注意是**合并**不是替换：`pool` 里还混着远端补来的老片条目，后台预热每 20~60 秒
  // 推一次新快照，如果用 `setPool(allEntries(...))` 直接盖掉，用户正在敲的那个查询
  // 的远端结果会突然消失，右栏建议跟着闪一下。
  useEffect(() => {
    const sync = () => {
      const indexed = allEntries(currentIndex());
      setPool((prev) => (prev.length === 0 ? indexed : dedupeEntries([...indexed, ...prev])));
    };
    sync();
    return subscribeIndex(sync);
  }, []);

  // 输入变化 → 先用本地索引立即出建议（零网络），再节流地补远端
  //
  // `liveNeedle` 存的是「当前输入真正对应的 needle」，异步回调回来时用它做最后一道
  // 校验：`controller.signal.aborted` 只能挡住被 cleanup 取消的那些，挡不住
  // 「用户从 abc 改成 abcd、旧请求先返回」这类替换竞争。
  const liveNeedle = useRef('');
  useEffect(() => {
    const needle = normalizeQuery(draft);
    liveNeedle.current = needle;
    // 每次输入变化都先把「补全中」复位。下面有 4 条 early return（空串、缓存命中、
    // 无远端源、单字母），而上一轮请求被 cleanup abort 后 `.finally` 里的
    // `!controller.signal.aborted` 不成立，不会复位 —— 只在空串分支复位的写法会让
    // 头部一直挂在「正在补全网关片库…」，其实什么都没在跑。
    setRemoteLoading(false);
    if (needle.length === 0) return;

    const cached = remoteCache.current.get(needle);
    if (cached) {
      setPool((prev) => dedupeEntries([...prev, ...cached]));
      return;
    }

    const targets = remotePinyinSources(sources);
    if (targets.length === 0) return;
    // 只有一个字母时先不打远端：命中太散，而且用户马上会继续敲
    if (needle.length < 2) return;

    if (remoteTimer.current !== null) window.clearTimeout(remoteTimer.current);
    remoteTimer.current = window.setTimeout(() => {
      remoteTimer.current = null;
      remoteAbort.current?.abort();
      const controller = new AbortController();
      remoteAbort.current = controller;
      setRemoteLoading(true);
      void remotePinyinSearch(needle, sources, http, { limit: 80, signal: controller.signal })
        .then((entries) => {
          if (controller.signal.aborted) return;
          // 缓存可以留（换个词再敲回来能直接命中），但**入池**必须确认它还是当前输入。
          const cache = remoteCache.current;
          if (cache.size >= REMOTE_CACHE_LIMIT && !cache.has(needle)) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          cache.set(needle, entries);
          if (liveNeedle.current !== needle) return;
          setPool((prev) => dedupeEntries([...prev, ...entries]));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) setRemoteLoading(false);
        });
    }, REMOTE_DEBOUNCE_MS);

    return () => {
      if (remoteTimer.current !== null) window.clearTimeout(remoteTimer.current);
      // 输入变化/清空时要连带取消在途请求：只 clearTimeout 不管用——
      // 当输入被删到 1 个字母或空串时，上面的 early return 根本走不到这里，
      // 上一轮 needle 的结果返回后照样会被 merge 进候选池，右栏出现不属于当前输入的建议。
      remoteAbort.current?.abort();
    };
  }, [draft, sources]);

  useEffect(
    () => () => {
      remoteAbort.current?.abort();
      if (remoteTimer.current !== null) window.clearTimeout(remoteTimer.current);
    },
    []
  );

  const suggestions: SuggestionGroup[] = useMemo(
    () => suggestFromIndex(pool, draft, { limit: 120 }),
    [pool, draft]
  );

  // 索引是否已有内容：`pool` 由 subscribeIndex 驱动，索引长大后这里会跟着变。
  const indexReady = pool.length > 0;

  /* -------------------------------- 搜索结果 -------------------------------- */

  const [state, setState] = useState<SearchState>({ outcomes: [], groups: [] });
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [selected, setSelected] = useState<AggregatedGroup | null>(null);
  const outcomesRef = useRef<SourceSearchOutcome[]>([]);
  const runId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const commitOutcome = useCallback(
    (outcome: SourceSearchOutcome, myRun: number, word: string) => {
      if (myRun !== runId.current) return;
      const merged = [...outcomesRef.current.filter((o) => o.sourceKey !== outcome.sourceKey), outcome];
      outcomesRef.current = merged;
      // 第一个源回来后就把缓存结果换掉：缓存里没有「哪些源有/没有」的信息，
      // 混着用会让用户以为某个源也返回了这些条目
      setFromCache(false);
      const items = merged.flatMap((o) => (o.ok ? o.list : []));
      setState({ outcomes: merged, groups: rankSearchGroups(groupSearchResults(items), word) });
      // 连续失败累计到阈值会在这里返回事件：暂停后本次搜索不再请求它，
      // 下次搜索直接跳过——死源不该让每次搜索都先等满 10 秒超时。
      const event = recordSourceOutcome(outcome.sourceKey, outcome.ok);
      if (event) {
        const name = sources.find((s) => s.key === outcome.sourceKey)?.name ?? outcome.sourceName;
        toast.push(`${name} 连续失败，${describeSourceDisable(event.level)}`);
      }
    },
    [recordSourceOutcome, sources, toast]
  );

  /** 只重试一个失败源：不重跑整轮搜索，已有的结果不闪 */
  const retrySource = useCallback(
    async (sourceKey: string) => {
      // 必须按**当前结果页的词**重试：点字母索引里的片名建议后 draft 已被改回首字母，
      // 用 keyword 重试等于按上一个词重搜，该源条目会被覆盖成另一部剧的结果。
      const word = (lastWord || keyword).trim();
      const source = searchableSources.find((s) => s.key === sourceKey);
      if (!word || !source) return;
      const myRun = runId.current;
      try {
        const result = await searchSources({
          wd: word,
          sources: [source],
          http,
          filterAdult: settings.adultFilter,
          maxPages: 3,
          timeoutMs: 10_000,
        });
        for (const outcome of result.outcomes) commitOutcome(outcome, myRun, word);
      } catch (err) {
        if (myRun === runId.current) toast.err(err instanceof Error ? err.message : '重试失败');
      }
    },
    [commitOutcome, keyword, lastWord, searchableSources, settings.adultFilter, toast]
  );

  const run = useCallback(
    async (kw: string) => {
      const word = kw.trim();
      if (!word) return;
      if (sources.length === 0) {
        toast.err('还没有启用任何点播源，请先在设置中添加');
        return;
      }
      if (searchableSources.length === 0) {
        toast.err('所有已启用的源都因连续失败暂停了，可点击上方的「恢复」重新启用');
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRun = ++runId.current;

      outcomesRef.current = [];
      setState({ outcomes: [], groups: [] });
      setLoading(true);
      setLastWord(word);
      addRecentSearch(word);

      // 先出缓存结果，网络结果回来后覆盖：同一个片名搜第二遍不该再等十几秒
      const cached = cachedSearch(searchableSources, settings.adultFilter, word);
      if (cached && cached.length > 0) {
        setState({ outcomes: [], groups: rankSearchGroups(groupSearchResults(cached), word) });
        setFromCache(true);
      }

      try {
        const result = await searchSources({
          wd: word,
          sources: searchableSources,
          http,
          filterAdult: settings.adultFilter,
          maxPages: 3,
          timeoutMs: 10_000,
          signal: controller.signal,
          onSource: (outcome) => commitOutcome(outcome, myRun, word),
        });
        if (myRun !== runId.current) return;
        if (result.list.length === 0 && result.failures.length > 0) {
          toast.err('所有源都没有返回结果，请检查网络或源可用性');
        } else if (result.list.length === 0) {
          toast.push(`没有找到「${word}」的相关内容`);
        } else {
          // 有结果才落盘：把「确实没搜到」也缓存住，会让下次重试直接看到空页面
          rememberSearch(searchableSources, settings.adultFilter, word, result.list);
        }
      } catch (err) {
        // 取消不是失败：离开搜索页时 abort 会让 searchSources 抛错，
        // 旧写法只判 runId，于是切页时必弹一次红色「搜索失败」。
        if (!controller.signal.aborted && myRun === runId.current) {
          toast.err(err instanceof Error ? err.message : '搜索失败');
        }
      } finally {
        if (myRun === runId.current) setLoading(false);
      }
    },
    [addRecentSearch, commitOutcome, searchableSources, settings.adultFilter, sources, toast]
  );

  useEffect(() => {
    if (keyword.trim()) {
      setDraft(keyword);
      void run(keyword);
    }
    // nonce 变化说明用户又点了一次搜索，哪怕关键词没变也要重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, nonce]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      // 与分类页同理：abort 后 catch 里 runId 仍相等，得自增才能让这一轮彻底失效
      runId.current += 1;
    },
    []
  );

  /**
   * 点建议 → 用它自己的片名去搜（不是用字母）。
   *
   * 用片名搜索能立刻命中详情页需要的 vod_id，比「按字母搜索 + 再筛」准得多；
   * 索引里的条目本来就带着 `sourceKey:vodId`，所以还能顺手把结果先塞进去，
   * 网络结果回来后再合并覆盖。
   */
  const pickSuggestion = useCallback(
    (group: SuggestionGroup) => {
      setActiveGroup(group.key);
      // 回填**首字母**而不是中文片名：字母键盘是往 `value` 后面追加字符的，
      // 输入框里一旦是「庆余年」这个中文串，用户再敲 `q` 就成了「庆余年q」，
      // 归一化后永远匹配不到任何首字母，右栏就一直空着，只能手动清空。
      setDraft(group.initials);
      setLastWord(group.name);
      const items = suggestionToItems(group);
      const myRun = ++runId.current;
      outcomesRef.current = [];
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setFromCache(false);
      setLoading(true);
      addRecentSearch(group.name);
      setState({
        outcomes: [],
        groups: rankSearchGroups(groupSearchResults(items), group.name),
      });
      void searchSources({
        wd: group.name,
        sources: searchableSources,
        http,
        filterAdult: settings.adultFilter,
        maxPages: 2,
        timeoutMs: 10_000,
        signal: controller.signal,
        onSource: (outcome) => commitOutcome(outcome, myRun, group.name),
      })
        .then((result) => {
          if (myRun !== runId.current) return;
          if (result.list.length > 0) {
            rememberSearch(searchableSources, settings.adultFilter, group.name, result.list);
          }
        })
        .catch(() => {
          // 已用索引条目先渲染出结果，网络失败不算致命
        })
        .finally(() => {
          if (myRun === runId.current) setLoading(false);
        });
    },
    [addRecentSearch, commitOutcome, searchableSources, settings.adultFilter]
  );

  const okCount = state.outcomes.filter((o) => o.ok).length;
  const failCount = state.outcomes.filter((o) => !o.ok).length;

  if (sources.length === 0) {
    return (
      <div className="empty">
        <Icon name="film" size={30} />
        <h3>还没有点播源</h3>
        <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          LibreXTV 桌面端不内置任何片源。请在设置中添加 Apple CMS 采集站地址，
          <br />
          或导入一份 LibreTV-SourceList / TVBOX 订阅。
        </div>
        <button className="btn primary" style={{ marginTop: 14 }} onClick={onOpenSettings}>
          前往设置
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="search-split">
        {/* 左栏：输入 + 字母键盘 */}
        <div style={{ display: 'grid', gap: 12 }}>
          <LetterKeyboard
            value={draft}
            onChange={setDraft}
            onSubmit={() => {
              const word = draft.trim();
              if (word) void run(word);
            }}
          />
          {recentSearches.length > 0 ? (
            <div className="panel" style={{ padding: 12 }}>
              <div className="hint" style={{ marginBottom: 8 }}>
                最近搜索
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {recentSearches.slice(0, 8).map((kw) => (
                  <button
                    key={kw}
                    className="chip"
                    onClick={() => {
                      setDraft(kw);
                      void run(kw);
                    }}
                  >
                    {kw}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* 右栏：实时建议 */}
        <div className="suggest-pane">
          <div className="suggest-head">
            <span>
              {draft.trim() ? (
                <>
                  建议 · <b>{normalizeQuery(draft)}</b>
                </>
              ) : (
                <b>输入拼音首字母</b>
              )}
            </span>
            <span>
              {remoteLoading
                ? '正在补全网关片库…'
                : draft.trim()
                  ? `${suggestions.length} 部匹配`
                  : indexReady
                    ? '本地索引已就绪'
                    : '索引后台构建中'}
            </span>
          </div>

          {suggestions.length > 0 ? (
            <div className="suggest-rows">
              {suggestions.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  className={`suggest-row${activeGroup === group.key ? ' on' : ''}`}
                  onClick={() => pickSuggestion(group)}
                  title={`${group.name}（${group.initials}）`}
                >
                  <span className="ini">{group.initials}</span>
                  <span className="nm">
                    <Highlight text={group.name} needle={normalizeQuery(draft)} />
                  </span>
                  <span className="meta">
                    {group.entries.length > 1 ? `${group.entries.length} 源` : ''}
                    {group.year ? ` ${group.year}` : ''}
                    {group.typeName ? ` · ${group.typeName}` : ''}
                  </span>
                </button>
              ))}
            </div>
          ) : draft.trim() ? (
            <div className="empty" style={{ padding: '24px 0' }}>
              <div style={{ fontSize: 12.5 }}>
                {draft.trim().length < 2
                  ? '再输入一个字母，或直接点「搜索」按关键词查'
                  : '本地索引里暂时没有，远端拼音源也没有更多结果'}
              </div>
            </div>
          ) : (
            <div className="empty" style={{ padding: '24px 0' }}>
              <Icon name="search" size={24} />
              <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                用左侧字母键盘输入片名的拼音首字母，
                <br />
                例如「斗罗大陆」→ <b>dldl</b>、「庆余年」→ <b>qyn</b>。
                <br />
                右侧会实时列出匹配片名，点一条即可搜它。
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 结果区 */}
      <div className="section-title" style={{ marginTop: 22 }}>
        <span>
          搜索结果{' '}
          {lastWord || keyword ? (
            <span style={{ color: '#8d97a8' }}>· {lastWord || keyword}</span>
          ) : null}
        </span>
        <span className="hint">
          {loading
            ? `搜索中… 已完成 ${state.outcomes.length}/${searchableSources.length} 个源`
            : fromCache
              ? `${state.groups.length} 部影片（本地缓存）`
              : `${state.groups.length} 部影片`}
        </span>
      </div>

      {pausedSources.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <div className="hint">
            已暂停 {pausedSources.length} 个源（连续失败 2 次自动暂停；暂停只影响搜索，不影响勾选）。
            恢复后从第 1 次失败重新累计：
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {pausedSources.map((source) => (
              <button
                key={source.key}
                className="chip warn"
                title="点击恢复此源"
                onClick={() => restoreSourceHealth(source.key)}
              >
                {source.name} · {describeDisabledRemaining(sourceHealth[source.key], Date.now())} · 恢复
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {state.outcomes.length > 0 ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {state.outcomes.map((o) =>
            o.ok ? (
              <span key={o.sourceKey} className="chip ok">
                {o.sourceName} · {o.list.length} 条 · {o.ms ?? 0}ms
              </span>
            ) : (
              <button
                key={o.sourceKey}
                className={`chip ${o.timedOut ? 'warn' : 'err'}`}
                title="点击只重试这个源"
                onClick={() => void retrySource(o.sourceKey)}
              >
                {o.sourceName} · {o.timedOut ? '超时' : o.error ?? '失败'} · 重试
              </button>
            )
          )}
          {!loading ? (
            <span className="chip">
              可用 {okCount} / 失败 {failCount}
            </span>
          ) : null}
        </div>
      ) : null}

      {state.groups.length > 0 ? (
        <div className="grid">
          {state.groups.map((group) => {
            const first = group.items[0];
            const resume = useAppStore
              .getState()
              .history.find((h) => h.sourceKey === first.sourceKey && h.vodId === first.vodId);
            return (
              <button key={group.key} className="card" onClick={() => setSelected(group)}>
                <Poster src={first.pic} alt={group.name} />
                {group.items.length > 1 ? <span className="badge right">{group.items.length} 个源</span> : null}
                {resume ? <span className="badge">看到 {resume.episodeIndex + 1} 集</span> : null}
                <div className="card-body">
                  <div className="card-title" title={group.name}>
                    {group.name}
                  </div>
                  <div className="card-meta">
                    {first.typeName ? <span>{first.typeName}</span> : null}
                    {first.year ? <span>· {first.year}</span> : null}
                    {first.remarks ? <span>· {first.remarks}</span> : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : loading ? (
        <div className="grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="card" style={{ opacity: 0.35 }}>
              <div className="poster-fallback" />
            </div>
          ))}
        </div>
      ) : keyword ? (
        <div className="empty">
          <Icon name="search" size={26} />
          <h3>没有找到相关内容</h3>
          <div style={{ fontSize: 12.5 }}>换个关键词，或检查源是否可用</div>
        </div>
      ) : null}

      {selected ? (
        <DetailPanel group={selected} onClose={() => setSelected(null)} onPlay={onPlay} />
      ) : null}
    </>
  );
}

/** 把片名里能被首字母串对上的部分高亮出来（只用字母匹配，不猜汉字） */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  // 字母串对不上汉字，只能整体标亮「已命中」的那几个字的位置——这里退化成整体高亮，
  // 因为真正的对齐要靠 pinyinInitials 逐字映射，收益不抵复杂度。
  void needle;
  return <em>{text}</em>;
}
