import { useEffect, useRef, useState } from 'react';
import { initBridge, resetBridge, seedPullDelta } from './lib/bridge';
import { DEFAULT_SOURCES } from './lib/defaults';
import { startCatalogWarmup, stopCatalogWarmup } from './lib/catalog-warmer';
import { startIndexWarmup, stopIndexWarmup } from './lib/title-index-warmer';
import { syncDueSubscriptions } from './lib/subscription-sync';
import { useAppStore } from './lib/store';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { Icon, type IconName } from './components/Icons';
import logo from './assets/logo.png';
import { HomePage } from './pages/Home';
import { SearchPage } from './pages/Search';
import { LivePage } from './pages/Live';
import { SettingsPage } from './pages/Settings';
import { CategoryPage, type CategoryKey } from './pages/Category';
import { WatchPage, type WatchTarget } from './pages/Watch';

type View = 'home' | 'search' | 'live' | 'settings' | 'category';

const NAV: { id: View; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: '首页' },
  { id: 'search', icon: 'search', label: '搜索' },
  { id: 'live', icon: 'radio', label: '直播' },
  { id: 'settings', icon: 'sliders', label: '设置' },
];

/**
 * 内置片库的「每日增量」：把当前启用的源报给主进程。
 *
 * 采集站按 `vod_time` 倒序，第 1 页就是当天新片。整表 OTA 走 jsDelivr（做的是
 * 大版本同步），增量走采集站本身（补「打包之后」的新片）。两条一起，新片延迟
 * 从「等下个版本」降到「当天或次日」。
 *
 * 只挑内置源：用户自己加的源可能上千个，全报上去等于每次启动打一轮洪水。
 */
function pullSeedDelta(): Promise<number> {
  const state = useAppStore.getState();
  const enabled = new Set(state.selectedKeys);
  const urls = DEFAULT_SOURCES.filter((s) => enabled.has(s.key)).map((s) => s.url);
  if (urls.length === 0) return Promise.resolve(0);
  return seedPullDelta(urls);
}

export function App() {
  const [ready, setReady] = useState(false);
  /** 启动失败的原因：preload 没注入 / IPC 握手超时，都必须让用户看见并能重试 */
  const [fatal, setFatal] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [view, setView] = useState<View>('home');
  const [category, setCategory] = useState<CategoryKey>('movie');
  const [keyword, setKeyword] = useState('');
  // 每提交一次搜索 +1，让「同一个词再搜一遍」也能触发重新请求
  const [searchNonce, setSearchNonce] = useState(0);
  const [input, setInput] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [watch, setWatch] = useState<WatchTarget | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const theme = useAppStore((s) => s.settings.theme);
  const recentSearches = useAppStore((s) => s.recentSearches);

  useEffect(() => {
    let alive = true;
    let bootSyncTimer: number | undefined;
    setFatal(null);
    // `void initBridge().then(...)` 没有 catch 的后果：preload 没注入（打包漏文件、
    // 被安全软件拦掉）或 IPC 握手抛错时，ready 永远是 false，界面上只有一个
    // 永远转下去的 spinner——没有错误信息、没有重试入口，用户只能以为程序坏了。
    // 而且这是异步错误，根 ErrorBoundary 完全接不住。
    void initBridge()
      .then(() => {
        if (!alive) return;
        setReady(true);
        // 首次启动导入内置默认源（之后不再自动加回，用户删掉就是删掉）
        useAppStore.getState().seedDefaults();
        // 老版本可能把同一个源写了两遍，导致分类请求翻倍、所有源一起超时
        useAppStore.getState().dedupeSources();
        // 老版本的观看记录按「源 + vodId」去重，同一部片子从两个源各播一次就会留两条；
        // 现在改成按片名去重，这里把存量数据清理一遍（幂等）。
        useAppStore.getState().dedupeHistory();
        // 启动预热分类目录，并在后台每小时刷新一次
        startCatalogWarmup();
        // 片名索引：后台低优先级慢慢补，供搜索页的字母检索用
        startIndexWarmup();
        // 内置片库的每日增量：把当前启用的源报给主进程，由它拉各源第 1 页
        // （那页就是当天新片）并进内存表。放在最后，别和首屏抢带宽。
        void pullSeedDelta();
        // 到期的订阅在后台静默同步；每半小时再看一眼，长时间挂机也能刷新
        void syncDueSubscriptions().catch(() => undefined);
        const syncTimer = window.setInterval(() => {
          void syncDueSubscriptions().catch(() => undefined);
        }, 30 * 60 * 1000);
        bootSyncTimer = syncTimer;
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const reason = err instanceof Error ? err.message : String(err);
        setFatal(reason || '与主进程通信失败');
      });
    return () => {
      alive = false;
      if (bootSyncTimer !== undefined) window.clearInterval(bootSyncTimer);
      stopCatalogWarmup();
      stopIndexWarmup();
    };
  }, [bootAttempt]);

  useEffect(() => {
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [theme]);

  // 全局快捷键：Ctrl/Cmd + F 聚焦搜索，Ctrl/Cmd + 1..4 切页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (watch) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setView('search');
        inputRef.current?.focus();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        setView(NAV[Number(e.key) - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [watch]);

  const startSearch = (kw: string) => {
    setInput(kw);
    setKeyword(kw);
    // 点最近搜索/分类里的词时关键词可能和当前一样，靠 nonce 保证仍会重跑
    if (kw) setSearchNonce((n) => n + 1);
    setView('search');
    if (!kw) setTimeout(() => inputRef.current?.focus(), 0);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const kw = input.trim();
    if (!kw) return;
    // 同一个词再搜一次也得重新跑：只 setKeyword(kw) 时值没变，React 不重渲染，
    // 搜索页的 useEffect 也不会再触发，用户会觉得「点了没反应」。
    setSearchNonce((n) => n + 1);
    setKeyword(kw);
    setView('search');
    setSearchOpen(false);
  };

  // 最近搜索收进搜索框下拉：输入时先按关键词过滤，聚焦即展开
  const lowered = input.trim().toLowerCase();
  const searchSuggestions = recentSearches
    .filter((kw) => !lowered || kw.toLowerCase().includes(lowered))
    .slice(0, 8);

  if (fatal !== null) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'grid',
          placeItems: 'center',
          color: '#c9d1de',
          padding: 32,
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 520, display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>启动失败</div>
          <div style={{ color: '#8d97a8', lineHeight: 1.6 }}>{fatal}</div>
          <div style={{ color: '#6b7688', fontSize: 13, lineHeight: 1.6 }}>
            常见原因：安装目录被安全软件拦截、安装不完整（缺少 preload 脚本）。
            可先点重试；仍失败请重新安装。
          </div>
          <button
            className="btn"
            onClick={() => {
              setReady(false);
              // 之前那次握手的结果（成功或失败）必须丢掉，否则重试只是拿回同一个旧 Promise
              resetBridge();
              setBootAttempt((n) => n + 1);
            }}
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', color: '#8d97a8' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <div className="app">
        <aside className="rail">
          <div className="brand" title="LibreXTV">
            <img src={logo} alt="LibreXTV" />
          </div>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`rail-btn${(view === item.id || (view === 'category' && item.id === 'home')) ? ' active' : ''}`}
              title={`${item.label}（Ctrl+${NAV.indexOf(item) + 1}）`}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} size={21} />
            </button>
          ))}
          <div className="rail-foot">LIBREXTV DESKTOP</div>
        </aside>

        <main className="main">
          <div className="topbar">
            <div className="search-wrap">
              <form className="search-box" onSubmit={submit}>
                <Icon name="search" size={17} />
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    setSearchOpen(true);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  // 点击下拉项会先触发 blur；延迟关闭让 onClick 有机会执行
                  onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchOpen(false);
                      inputRef.current?.blur();
                    }
                  }}
                  placeholder="搜索影片、剧集、综艺…（Ctrl+F）"
                  spellCheck={false}
                />
                {input ? (
                  <button
                    type="button"
                    onClick={() => {
                      setInput('');
                      inputRef.current?.focus();
                    }}
                    style={{ color: '#5f6a7c', display: 'grid', placeItems: 'center' }}
                  >
                    <Icon name="x" size={15} />
                  </button>
                ) : null}
              </form>
              {searchOpen && searchSuggestions.length > 0 ? (
                <div className="search-suggest" role="listbox" aria-label="最近搜索">
                  <div className="search-suggest-head">最近搜索</div>
                  {searchSuggestions.map((kw) => (
                    <button
                      key={kw}
                      type="button"
                      role="option"
                      className="search-suggest-item"
                      // 阻止默认的焦点转移：否则 blur 先发生，点击还没到就收了下拉
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSearchOpen(false);
                        startSearch(kw);
                      }}
                    >
                      <Icon name="search" size={13} />
                      <span>{kw}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="btn ghost" onClick={() => setView('settings')} title="设置">
              <Icon name="sliders" size={17} />
              设置
            </button>
            <button className="btn ghost" onClick={() => setView('settings')} title="管理点播源与直播源">
              <Icon name="film" size={16} />
              管理数据源
            </button>
          </div>

          <div className="content">
            {/* 每个页面各包一层边界：某一页渲染崩溃时只坏这一页，
                而不是把整个界面（含正在播放的视频）一起卸载掉。
                key 用当前视图：切页就等于换一个新实例，旧页面的错误状态自然作废。 */}
            <ErrorBoundary key={`page-${view}`} scope="这个页面">
              {view === 'home' ? (
                <HomePage
                  onPlay={setWatch}
                  onSearch={startSearch}
                  onCategory={(key) => {
                    setCategory(key);
                    setView('category');
                  }}
                />
              ) : null}
              {view === 'category' ? (
                <CategoryPage
                  category={category}
                  onCategoryChange={setCategory}
                  onPlay={setWatch}
                  onOpenSettings={() => setView('settings')}
                />
              ) : null}
              {view === 'search' ? (
                <SearchPage
                  keyword={keyword}
                  nonce={searchNonce}
                  onPlay={setWatch}
                  onOpenSettings={() => setView('settings')}
                />
              ) : null}
              {view === 'live' ? <LivePage onOpenSettings={() => setView('settings')} /> : null}
              {view === 'settings' ? <SettingsPage /> : null}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      <ErrorBoundary key={`watch-${watch ? watch.vodId : 'none'}`} scope="播放页">
        {watch ? <WatchPage target={watch} onClose={() => setWatch(null)} /> : null}
      </ErrorBoundary>
    </ToastProvider>
  );
}
