package org.librextv.tv

import android.app.Application
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.librextv.tv.data.AppData
import org.librextv.tv.data.AppSettings
import org.librextv.tv.data.AppStore
import org.librextv.tv.data.CatalogSnapshot
import org.librextv.tv.data.CategoryKey
import org.librextv.tv.data.Defaults
import org.librextv.tv.data.HistoryDedupe
import org.librextv.tv.data.HistoryEntry
import org.librextv.tv.data.LiveChannel
import org.librextv.tv.data.LiveSource
import org.librextv.tv.data.Parsers
import org.librextv.tv.data.Pinyin
import org.librextv.tv.data.PlaybackCandidate
import org.librextv.tv.data.Repository
import org.librextv.tv.data.SearchGroup
import org.librextv.tv.data.SearchItem
import org.librextv.tv.data.SourceOutcome
import org.librextv.tv.data.VodDetail
import org.librextv.tv.data.VodSource
import java.util.UUID

/** 导航目标：播放页与详情页覆盖在主界面之上 */
sealed interface Screen {
    data object Home : Screen
    data object Search : Screen
    data object Live : Screen
    data object Settings : Screen
    data class Category(val key: CategoryKey) : Screen
    data class Detail(val group: SearchGroup, val item: SearchItem) : Screen
    data class Player(
        val source: VodSource,
        val vodId: String,
        val title: String,
        /** 年份：同名不同年的翻拍片靠它区分观看记录 */
        val year: String? = null,
        val cover: String?,
        val episodes: List<String>,
        val startIndex: Int,
        val sourceName: String,
        /** 同片源候选链（含当前源，当前源排第一）；失败时按顺序自动切换 */
        val candidates: List<PlaybackCandidate> = emptyList(),
    ) : Screen
    data class LivePlayer(
        val channel: LiveChannel,
        /**
         * 换台用的频道序列（通常是当前分组+关键词过滤后的可见列表）。
         *
         * 为空时退化成「只播这一个」，遥控器上下键不响应——首页的直播收藏
         * 就是这样进来的：那里没有列表语境，硬换到别的收藏反而不符合预期。
         */
        val playlist: List<LiveChannel> = emptyList(),
    ) : Screen
    data object Cast : Screen
    data class CastPlayer(val url: String, val title: String) : Screen
}

data class SearchUi(
    val keyword: String = "",
    val loading: Boolean = false,
    val outcomes: List<SourceOutcome> = emptyList(),
    val groups: List<SearchGroup> = emptyList(),
    val searched: Boolean = false,
    /** 结果来自本地检索缓存 */
    val fromCache: Boolean = false,
)

data class DetailUi(
    val loading: Boolean = true,
    val detail: VodDetail? = null,
    val error: String? = null,
)

data class LiveUi(
    val loading: Boolean = false,
    val channels: List<LiveChannel> = emptyList(),
    val statuses: List<Pair<String, String>> = emptyList(),
    val groups: List<String> = emptyList(),
    val selectedGroup: String = "全部",
    val keyword: String = "",
    /** 已下载字节数（渐进加载时显示进度，让用户知道正在动而不是卡死） */
    val downloadedBytes: Long = 0,
    /** 命中本地缓存：界面已经可用，后台仍在刷新 */
    val fromCache: Boolean = false,
)

data class CategoryUi(
    val key: CategoryKey = CategoryKey.MOVIE,
    val loading: Boolean = false,
    val groups: List<SearchGroup> = emptyList(),
    val supportedSources: Int = 0,
    val failedSources: Int = 0,
    /** 失败原因摘要（如「HTTP 503×2」）：只说「N 个源失败」用户没法判断该怎么办 */
    val failureReason: String = "",
    /** 内容来自本地缓存：界面已可用，后台仍在刷新 */
    val fromCache: Boolean = false,
)

/** 首页的一排内容：标题 + 该分类下的一批影片 */
data class HomeRow(
    val key: CategoryKey,
    val items: List<SearchItem>,
)

/** 单次详情请求的死线：超时即换下一个候选源，不让用户对着转圈等 */
private const val PINYIN_SOURCE_KEY = "pinyin"

/** 检索缓存命中时伪造的「源」，UI 上显示为「本地缓存」 */
private const val CACHE_SOURCE_KEY = "cache"
private const val DETAIL_TIMEOUT_MS = 9_000L

/**
 * 换源时拉单个候选详情的超时。必须小于 [DETAIL_TIMEOUT_MS] × 2，
 * 否则一个坏源就能让「正在切换到…」卡住半分钟（看门狗在 failingOver 期间不介入）。
 */
private const val FAILOVER_CANDIDATE_TIMEOUT_MS = 8_000L

/** 换源时跨源反查片名的总超时。 */
private const val FAILOVER_DISCOVER_TIMEOUT_MS = 12_000L

/** 同时发起的候选详情请求上限（电视盒子并发能力有限） */
private const val DETAIL_FANOUT = 3

/** 首页每个分类排显示多少张海报（再多也没人横向翻） */
private const val HOME_ROW_SIZE = 14

/**
 * 收藏条数上限（与桌面端 `FAVORITE_LIMIT` 对齐）。
 *
 * 直播收藏原来完全不设上限：一个两万频道的源被逐个收藏后，整份快照会撑爆
 * DataStore 落盘预算，写失败时连观看记录一起丢。
 */
private const val FAVORITE_LIMIT = 500

/** 拼音索引低于这个条数就认为覆盖不足，启动后补扫一批 */
private const val WARM_INDEX_THRESHOLD = 3_000

/**
 * 目录落盘的合并窗口。
 *
 * 一轮 refreshCatalog 会写 8+1 次快照，每份序列化约 557KB 且 DataStore 是整文件
 * 重写；不等一等就是九次连续大文件写，和播放抢磁盘。500ms 足以把一轮合并成一次。
 */
private const val CATALOG_SAVE_DEBOUNCE_MS = 500L

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = AppStore(app)
    private val repo = Repository()

    private val _data = MutableStateFlow(AppData())
    val data: StateFlow<AppData> = _data.asStateFlow()

    var screen by mutableStateOf<Screen>(Screen.Home)
        private set
    var search by mutableStateOf(SearchUi())
        private set
    var detail by mutableStateOf<DetailUi?>(null)
        private set
    var live by mutableStateOf(LiveUi())
        private set
    /**
     * 直播源已下载字节数。
     *
     * 单独放一个状态、不塞进 [live]：这个值由下载协程在 IO 线程上高频写入，
     * 而 [live] 是「读快照 → 改字段 → 整体写回」的写法，两处并发写会把
     * 对方的字段回退掉（典型现象：渐进加载时用户刚点的分组被弹回「全部」）。
     */
    var liveBytes by mutableLongStateOf(0L)
        private set
    var category by mutableStateOf(CategoryUi())
        private set
    var toast by mutableStateOf<String?>(null)
        private set
    var importing by mutableStateOf(false)
        private set

    /**
     * 有内容的分类（首页只摆这些入口）。
     * null = 还没探测过（此时先按全量显示，避免布局抖动）。
     */
    var availableCategories by mutableStateOf<List<CategoryKey>?>(null)
        private set

    /**
     * 首页内容流：每个可用分类一排，内容全部来自本地目录缓存。
     *
     * 首页原来只有 Hero + 分类胶囊 + 四张统计卡，新装用户进来几乎没东西可看。
     * 改成 row 式内容流后，一屏就能看到「继续观看 + 电影 + 电视剧 …」的真实海报。
     */
    var homeRows by mutableStateOf<List<HomeRow>>(emptyList())
        private set
    private var probeJob: Job? = null
    private var probedSourceSignature: String = ""

    /** 待落盘的目录快照：合并同一轮刷新里的多次变更，只写最后一次 */
    private var pendingCatalogSave: CatalogSnapshot? = null
    private var catalogSaveJob: Job? = null

    private var searchJob: Job? = null

    /** 拼音索引预热的后台任务，用户一旦开始检索就取消 */
    private var warmJob: Job? = null

    /** 「继续观看 / 收藏」起播的详情请求：同一时刻只允许一个在飞，避免连点叠请求。 */
    private var openingJob: Job? = null

    /** 检索序号：见 [startSearch] 里的说明 */
    private var searchSeq: Int = 0

    /** 上次落盘的拼音索引条数，用来判断「攒够没有」 */
    private var persistedIndexSize: Int = 0

    init {
        // 目录缓存一有变化就落盘：loadCategory 抓到的新内容不该等到下一个小时才保住。
        //
        // 但要合流：一轮 refreshCatalog 会逐分类写 8 次、再加末尾一次，每份快照
        // 序列化后约 557KB，DataStore 又是整文件重写 —— 9 次连续写会把 IO 打满，
        // 还和播放抢同一块磁盘。这里改成「记下最新值 + 500ms 延迟合并」，
        // 期间再来的只覆盖不排队，一次刷新最终只落一次盘。
        repo.onCatalogChanged = { snapshot ->
            pendingCatalogSave = snapshot
            if (catalogSaveJob?.isActive != true) {
                catalogSaveJob = viewModelScope.launch {
                    delay(CATALOG_SAVE_DEBOUNCE_MS)
                    val latest = pendingCatalogSave
                    pendingCatalogSave = null
                    if (latest != null) runCatchingCancellable { store.saveCatalog(latest) }
                }
            }
        }
        viewModelScope.launch {
            seedIfNeeded()
            dedupeStoredSources()
            dedupeStoredHistory()
            // DataStore 读盘是 IO：读失败（磁盘忙、文件被占）不该让界面永久停在空数据上。
            // 原来 `.catch { emit(AppData()) }` 会在 catch 之后正常结束整条流，
            // 之后再也不会收到更新；这里改成退避重订阅。
            while (true) {
                try {
                    store.data.collect { _data.value = it }
                    break
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    kotlinx.coroutines.delay(1_000)
                }
            }
        }
        // 先按上次落盘的结论摆好首页入口，真正的探测由 HomeScreen 触发
        viewModelScope.launch {
            kotlinx.coroutines.delay(300) // 等首帧 seed/collect 落定，拿到 activeSources
            runCatching { restoreCategoryAvailability() }
        }
        // 拼音索引：上次落盘的片名先装进内存，这样一开机 qmmk 就能命中之前浏览过的片子
        viewModelScope.launch {
            runCatching { repo.rememberItems(store.pinyinIndex()) }
        }
        // 索引太薄时补扫一批：拼音检索只能命中「见过的片名」，
        // 光靠首页分类刷新（每分类一页）根本不够，用户按首字母搜什么都搜不到。
        // 补完就落盘，之后启动不再重复打这批请求。
        // 注意：这个 Job 会被 startSearch() 取消 —— 预热是后台任务，用户一开口
        // 检索就得让路。gated() 的 Semaphore 是 FIFO 公平的，预热启动时会一口气
        // 排上几十个请求，用户的搜索请求排在它们后面，实测 45 秒都翻不完第一页。
        warmJob = viewModelScope.launch {
            kotlinx.coroutines.delay(8_000) // 让首页与目录刷新先跑，别抢带宽
            if (repo.seenSnapshot().size >= WARM_INDEX_THRESHOLD) return@launch
            val sources = _data.value.activeSources()
            if (sources.isEmpty()) return@launch
            val added = runCatching { repo.warmPinyinIndex(sources) }.getOrDefault(0)
            if (added > 0) runCatching { persistPinyinIndex() }
        }
        // 目录缓存：先把上次落盘的内容装进 repo，界面一开机就有内容可读
        viewModelScope.launch {
            runCatching { installCatalogCache() }
        }
        // 预热 + 每小时刷新：启动后拉一遍所有分类，之后每小时一次。
        // 用户要求「切分类和检索时优先读缓存」，所以刷新是唯一打网络的时机。
        viewModelScope.launch {
            kotlinx.coroutines.delay(1_500) // 让首帧先渲染，别和冷启动抢带宽
            while (true) {
                runCatching { refreshCatalog() }
                kotlinx.coroutines.delay(org.librextv.tv.data.CatalogSnapshot.REFRESH_INTERVAL_MS)
            }
        }
    }

    /** 目录缓存的源签名：源或成人过滤开关一变，旧缓存整体作废 */
    private fun catalogSignature(sources: List<VodSource>, adultFilter: Boolean): String =
        org.librextv.tv.data.CatalogSnapshot.signatureOf(sources, adultFilter)

    private suspend fun installCatalogCache() {
        val sources = _data.value.activeSources()
        if (sources.isEmpty()) return
        val signature = catalogSignature(sources, _data.value.settings.adultFilter)
        val snapshot = store.catalog(signature) ?: return
        repo.installCatalog(snapshot)
        refreshHomeRows()
    }

    /**
     * 预热 / 定时刷新：把 8 个分类各拉一遍并写入本地目录缓存。
     *
     * 单轮用 `useCache = false` 强制刷新分类表本身；分类内容每条只抓第一页，
     * 4 个源并发 + 每分类并发，一轮大约十几秒，放在后台跑不影响前台。
     */
    private suspend fun refreshCatalog() {
        val sources = _data.value.activeSources()
        if (sources.isEmpty()) return
        val adultFilter = _data.value.settings.adultFilter
        val signature = catalogSignature(sources, adultFilter)
        // 签名不符才换新快照：签名相同要保留内存里那份，
        // 否则刚由 loadCategory 写进去、还没来得及落盘的条目会被这里覆盖掉
        if (repo.catalogSignature() != signature) {
            repo.installCatalog(
                store.catalog(signature) ?: org.librextv.tv.data.CatalogSnapshot(signature = signature)
            )
        }
        val snapshot = repo.catalogSnapshot()
        // 8 个分类 × 每分类并发拉源：串行要一分钟以上，预热就没意义了
        coroutineScope {
            CategoryKey.home.map { key ->
                async {
                    // 还新鲜就不重复打网络
                    if (snapshot.isFresh(key) && repo.cachedCategoryItems(key) != null) return@async
                    val items = sources.map { source ->
                        async {
                            val (ok, list, _) = repo.browseCategory(
                                source,
                                key,
                                adultFilter = adultFilter,
                                // 后台刷新必须真的回源：useCache=true 会命中 5 分钟内存缓存，
                                // 这一轮就白跑了（注释与实现曾经不一致）
                                useCache = false,
                            )
                            if (ok) list else emptyList()
                        }
                    }.awaitAll().flatten()
                    val merged = items.distinctBy { "${it.sourceKey}:${it.vodId}" }
                    if (merged.isNotEmpty()) {
                        repo.cacheCatalogItems(key, merged)
                    } else if (repo.cachedCategoryItems(key) == null) {
                        // 空分类也要记一笔「刚查过」，否则它永远不算新鲜，
                        // 每小时都重打一轮请求，用户看到的还是同一片空白
                        repo.markCatalogChecked(key)
                    }
                }
            }.awaitAll()
        }
        runCatching { store.saveCatalog(repo.catalogSnapshot()) }
        // 缓存到位后，若用户正停在某个还没内容的分类页，顺手把它补上
        val current = screen
        if (current is Screen.Category && category.groups.isEmpty() && !category.loading) {
            val filled = repo.cachedCategoryItems(current.key)
            if (!filled.isNullOrEmpty()) {
                category = category.copy(groups = Parsers.group(filled), fromCache = true)
            }
        }
        refreshHomeRows()
    }

    /**
     * 用本地目录缓存填首页的内容流。
     *
     * 只读缓存、不发请求：首页要「一进去就有海报」，网络那是 [refreshCatalog] 的事。
     * 每个可用分类取前 [HOME_ROW_SIZE] 条，单独一个分类失败不影响其它排。
     */
    fun refreshHomeRows() {
        val keys = availableCategories ?: CategoryKey.home
        val rows = keys.mapNotNull { key ->
            val cached = repo.cachedCategoryItems(key)
            if (cached.isNullOrEmpty()) return@mapNotNull null
            HomeRow(key = key, items = cached.take(HOME_ROW_SIZE))
        }
        homeRows = rows
    }

    // —— 首次启动 / 内置源清单升级：导入内置默认源 ——
    private suspend fun seedIfNeeded() {
        val current = store.current()
        val version = Defaults.version(getApplication())
        val upgraded = current.defaultsVersion < version
        // 首次启动与「内置源清单升级」走同一条路径：两边都只补本地没有的 url，
        // 因此重复执行是安全的。只靠 `seeded` 布尔量的话，老用户永远拿不到新源。
        if (current.seeded && !upgraded) return
        val (vod, liveSources) = Defaults.load(getApplication())
        // 用户删掉过的内置源不要再塞回来
        val removed = current.removedDefaultUrls.toSet()
        val addedVod = vod.filter { s -> current.sources.none { it.url == s.url } && s.url !in removed }
        val addedLive = liveSources.filter { s -> current.liveSources.none { it.url == s.url } && s.url !in removed }
        // 只勾选清单里「默认启用」的内置直播源：两个 iptv-org 源与 Guovin 这类
        // 默认关掉的源进列表但不参与加载，否则新用户开箱就是一屏死台。
        val defaultLiveSelected = Defaults.defaultLiveSelectedKeys(getApplication())
        // v4 之前老用户是三个直播源全开的。清单把两个 iptv-org 源改成默认关闭后，
        // 光改 `selected` 对老用户没用（勾选状态早就存下来了），所以升级到
        // LIVE_SELECTION_VERSION 时取消一次；之后用户自己再打开就不会被关掉。
        val disabled = Defaults.defaultLiveDisabledKeys(getApplication())
        val liveBase =
            if (current.defaultsVersion < Defaults.LIVE_SELECTION_VERSION) {
                current.liveSelected.filterNot { it in disabled }
            } else {
                current.liveSelected
            }
        store.update {
            // 内置源**换了地址**（同 key、不同 url）时用新地址替换旧条目：
            // key 是按下标生成的，光按 url 判重会让列表里出现两条同 key 的同名源
            // （一条旧镜像、一条新镜像），勾选状态也会打架。直播源一直有这一步，
            // 点播源以前漏了，同一站换域名时会留下一条永远连不上的旧条目。
            val freshVodByKey = vod.filter { d ->
                val local = it.sources.firstOrNull { s -> s.key == d.key }
                local != null && local.url != d.url && local.url !in removed
            }.associateBy { s -> s.key }
            val mergedVod = it.sources.map { s -> freshVodByKey[s.key] ?: s }
            val addedVodKeys = addedVod
                .filter { s -> it.sources.none { old -> old.key == s.key } }
                .map { s -> s.key }
            val freshByKey = addedLive.associateBy { s -> s.key }
            val mergedLive = it.liveSources.map { s -> freshByKey[s.key] ?: s } +
                addedLive.filter { s -> it.liveSources.none { old -> old.key == s.key } }
            it.copy(
                sources = (mergedVod + addedVod).distinctBy { s -> s.url },
                selected = (it.selected + addedVodKeys).distinct(),
                liveSources = mergedLive.distinctBy { s -> s.url },
                liveSelected = (
                    liveBase + addedLive.filter { s -> s.key in defaultLiveSelected }.map { s -> s.key }
                    ).distinct(),
                seeded = true,
                defaultsVersion = version,
            )
        }
    }

    /**
     * 合并重复配置的源（同一地址只留一条）。
     *
     * 老版本有可能把内置源写进存储两遍；重复条目会让分类浏览的并发请求翻倍，
     * 采集站以 503 回敬，用户看到的就是「所有源都失败、这个分类一部片子都没有」。
     */
    private suspend fun dedupeStoredSources() {
        val current = store.current()
        // 记下「被删掉的 key → 保留下来的 key」：同地址的两条源里，用户启用的
        // 可能正好是后一条。直接按 key 过滤会把这种源静默停用，用户会以为
        // 「我明明开着这个源，怎么没内容了」。
        val keepByUrl = HashMap<String, String>()
        val sources = current.sources.filter { keepByUrl.getOrPut(it.url) { it.key } == it.key }
        val liveKeepByUrl = HashMap<String, String>()
        val liveSources = current.liveSources
            .filter { liveKeepByUrl.getOrPut(it.url) { it.key } == it.key }
        if (sources.size == current.sources.size && liveSources.size == current.liveSources.size) return
        val keys = sources.map { it.key }.toSet()
        val liveKeys = liveSources.map { it.key }.toSet()
        val remap = current.selected.mapNotNull { key ->
            if (key in keys) key else keepByUrl[current.sources.firstOrNull { it.key == key }?.url]
        }.distinct()
        val liveRemap = current.liveSelected.mapNotNull { key ->
            if (key in liveKeys) key else liveKeepByUrl[current.liveSources.firstOrNull { it.key == key }?.url]
        }.distinct()
        store.update {
            it.copy(
                sources = sources,
                liveSources = liveSources,
                selected = remap,
                liveSelected = liveRemap,
            )
        }
        Log.i("LibreXTV", "已合并重复源：点播 ${current.sources.size}→${sources.size}，直播 ${current.liveSources.size}→${liveSources.size}")
    }

    /**
     * 清理老版本按「源 + vodId」去重留下的重复观看记录。
     *
     * 同一部片子从两个源各播一次会留两条同名卡片；现在改成按片名去重
     * （见 [saveProgress]），存量数据在启动时幂等清理一遍。
     */
    private suspend fun dedupeStoredHistory() {
        val current = store.current()
        val deduped = HistoryDedupe.dedupe(current.history)
        if (deduped.size != current.history.size) {
            store.update { it.copy(history = deduped) }
        }
    }

    // —— 导航 ——
    /**
     * 首页内容流点海报：没有 group 就直接按单条打开详情。
     *
     * 首页海报可能来自另一个源（缓存里是第一页混排），group 里只有它自己，
     * 换源候选仍会按片名自动补。
     */
    fun openDetailForItem(item: SearchItem) {
        openDetail(SearchGroup(key = item.name, name = item.name, items = listOf(item)), item)
    }

    /**
     * 焦点在左侧导航里连续移动时会反复调用 go()。
     * 目标页各自有「进入后把焦点抢到第一个可操作元素」的 LaunchedEffect，
     * 若不加标记，焦点刚进导航栏就会被目标页抢走，↓ 根本走不到第二项。
     * 前端在这段时间内跳过自己的抢焦点逻辑。
     */
    var navFocusHold = false
        private set

    private var navHoldRelease: Job? = null

    fun beginNavFocusHold() {
        navHoldRelease?.cancel()
        navFocusHold = true
    }

    /**
     * 焦点离开某个导航项后的收尾。
     *
     * 不能立刻解除：焦点还在导航栏里从「首页」→「搜索」移动时，
     * 上一个项的失焦和下一个项的获焦之间有几十毫秒空档，
     * 立刻解除会让目标页趁这个空档抢走焦点。
     * 用 250ms 的宽限期把「连续移动」和「真的离开导航」区分开。
     */
    fun releaseNavFocusHoldSoon() {
        navHoldRelease?.cancel()
        navHoldRelease = viewModelScope.launch {
            delay(250)
            navFocusHold = false
        }
    }

    fun endNavFocusHold() {
        navHoldRelease?.cancel()
        navHoldRelease = null
        navFocusHold = false
    }

    /**
     * 「现在请把焦点交给内容区的第一个可操作元素」的信号。
     *
     * 导航栏是「焦点移上去就切页」，所以目标页组合的那一刻 `navFocusHold`
     * 必然是 true，它自己那段 `LaunchedEffect(Unit)` 里的首焦点逻辑 100% 被跳过——
     * 也就是说进入任何页面都不会有首焦点。这里改用显式信号：
     * 用户在导航项上按 OK（明确的「我要进这一页」），才让页面去抢焦点。
     * 只靠 `releaseNavFocusHoldSoon` 的 250ms 宽限期做不到这件事，
     * 因为它分不清「用户按 ↓ 进内容」和「焦点在导航项之间移动」。
     */
    var contentFocusTick by mutableStateOf(0)
        private set

    fun requestContentFocus() {
        endNavFocusHold()
        contentFocusTick++
    }

    fun go(target: Screen) {
        // 直接跳播放页（比如首页「直播收藏」里点一个台）也要记下来源，
        // 否则返回键会落到用户从没去过的页面：NavStack 对 LivePlayer 是硬编码回
        // 「直播」列表，而从首页收藏直接起播的人从没打开过那个列表。
        if (target is Screen.LivePlayer || target is Screen.Player) nav.playFrom(screen)
        screen = target
        if (target is Screen.Search) {
            // 从详情返回搜索时保留结果
        }
        if (target is Screen.Live && live.channels.isEmpty() && !live.loading) {
            loadLive()
        }
        if (target is Screen.Category) {
            loadCategory(target.key)
        }
        if (target is Screen.Cast) {
            // 投屏接收页由 UI 层驱动
        }
    }

    /** 切换分类并重新拉取 */
    fun selectCategory(key: CategoryKey) {
        // 用户明确选了分类：取消还在防抖里的悬停预载，避免它稍后把页面再翻回去
        previewJob?.cancel()
        screen = Screen.Category(key)
        loadCategory(key)
    }

    private var previewJob: Job? = null

    /**
     * 遥控器焦点移到某个分类上就直接切过去并加载，不用再按一次 OK。
     *
     * 只认「当前就在分类页」的情况：首页分类行也会调用，那里应当按 OK 才进页面。
     * 防抖 70ms：遥控器连按时一次移动只发一轮请求，但短到用户感觉不到延迟。
     *
     * 这里**不能**再校验「category.key 还是不是进入时的那个」。
     * 之前写了 `if (category.key != current.key) return@launch`，本意是防止
     * 迟到的预载把页面拽回悬停项，实际效果是：先悬停 A（A 已加载，category.key 变成 A），
     * 再悬停 B 时 current.key 仍是更早的值，判断成立 → B 直接放弃加载。
     * 表现就是「第一个分类能自动加载，之后都必须按 OK」。光标自己换来的
     * 分类本来就是要加载的目标，不需要防它。
     */
    fun previewCategory(key: CategoryKey) {
        if (screen !is Screen.Category) return
        if (key == category.key) return
        previewJob?.cancel()
        previewJob = viewModelScope.launch {
            delay(70)
            // 防抖期间用户可能已经按 OK 选了别的分类、或直接返回：
            // 那时不能再把这个「只是路过」的分类加载出来，否则会被拽回悬停项
            if (screen !is Screen.Category) return@launch
            selectCategory(key)
        }
    }

    /**
     * 探测有内容的分类（首页分类入口只显示这些）。
     *
     * 用户反馈「少儿分类无任何影片时应该把入口藏起来」——点进去空页面体验很差。
     * 探测走 fast 模式：只读各源的分类表（有 6 小时缓存），不再为 8 个分类各抓一遍
     * 内容 —— 老做法是 8 × 源数 次内容请求，13 个源实测两分钟级，还会和用户随后
     * 点进分类抢同一批连接。结果按源签名落到 DataStore，下次启动直接按上次结论
     * 渲染，后台再刷新，避免首页按钮先全显示再少一个。
     */
    fun probeCategories(force: Boolean = false) {
        val sources = _data.value.activeSources()
        // 源还没就绪（DataStore 首次 collect 之前）时不能下「没有分类」的结论：
        // availableCategories 一旦被写成 emptyList()，首页就会永久停在
        // 「暂未返回任何分类内容」，而接下来真正到达的探测结果会被
        // probedSourceSignature 判重挡掉。这里什么都不做，等源到位后由
        // 首页按源签名重新触发。
        if (sources.isEmpty()) return
        val signature = sources.map { it.key }.sorted().joinToString(",") +
            "|" + _data.value.settings.adultFilter
        if (!force && signature == probedSourceSignature && probeJob?.isActive != true) return
        probedSourceSignature = signature
        probeJob?.cancel()
        probeJob = viewModelScope.launch {
            // 必须用「保留取消」的版本：普通 runCatching 会把 CancellationException
            // 当成「探测失败」，于是下面的兜底把所有分类都点亮，用户看到入口
            // 全亮又突然收窄——正是注释里想避免的那种抖动。
            val hits = runCatchingCancellable {
                repo.probeCategories(sources, _data.value.settings.adultFilter)
            }.getOrNull()
            val cancelled = !isActive || probeJob?.isActive == false
            if (cancelled) return@launch
            val keys = if (hits == null) {
                // 探测整体失败就退回显示全部，不能把入口全藏起来
                CategoryKey.home
            } else {
                CategoryKey.home.filter { (hits[it] ?: 0) > 0 }
            }
            availableCategories = keys
            if (hits != null) store.saveCategoryAvailability(signature, keys.map { it.name })
            refreshHomeRows()
        }
    }

    /** 启动时先按上次落盘的结论摆好入口（真正的最新结论由 [probeCategories] 覆盖） */
    private suspend fun restoreCategoryAvailability() {
        val sources = _data.value.activeSources()
        if (sources.isEmpty()) return
        val signature = sources.map { it.key }.sorted().joinToString(",") +
            "|" + _data.value.settings.adultFilter
        val cached = store.categoryAvailability(signature) ?: return
        val keys = cached.mapNotNull { name -> CategoryKey.entries.find { it.name == name } }
        // 只用于首屏展示：不写 probedSourceSignature，否则会把后续真实探测挡掉
        if (keys.isNotEmpty()) availableCategories = keys
    }

    /**
     * 返回栈：播放页 / 详情页各自该退回哪里。
     *
     * 播放页和详情页的来源要分开记：共用一份会出现「播放页按返回连退两级」，
     * 拆错了会出现「详情页按返回原地不动」，两个 bug 都真实发生过，
     * 所以判定逻辑抽成了带单元测试的纯状态机 [NavStack]。
     */
    private val nav = NavStack()

    /** 分类加载任务：切分类时取消上一轮，避免旧结果覆盖新结果 */
    private var categoryJob: Job? = null

    /**
     * 分类加载序号。
     *
     * 光靠 `categoryJob?.cancel()` 不够：取消是协作式的，`browseCategory` 内部的
     * 阻塞 IO 不会立刻返回，那一轮仍可能在取消后跑到「边收边渲染」的赋值处，
     * 把旧分类的海报显示到新分类页上。每次 loadCategory 领一个号，只有号码还是
     * 最新的那一轮才允许改 category（桌面端对应的就是 Category.tsx 的 runId）。
     */
    private var categorySeq: Int = 0

    /** 详情加载任务：连续打开多个详情时取消上一轮，避免旧结果回填到新页面 */
    private var detailJob: Job? = null

    /** 详情请求序号：只有最后一次打开的详情才允许改 screen / detail */
    private var detailSeq: Int = 0

    /** 按分类拉取各源内容（分类页与首页分类入口共用） */
    fun loadCategory(key: CategoryKey) {
        val sources = _data.value.activeSources()
        nav.playFrom(Screen.Home)
        if (sources.isEmpty()) {
            category = CategoryUi(key = key)
            showToast("还没有启用任何点播源")
            return
        }
        // 缓存优先：切分类时先立刻出上一次的内容（进程重启后依然有效），
        // 只有缓存缺失才显示加载态。用户反馈「每次切分类都像在重新拉播放源」
        // 就是这一步缺失导致的。
        val cached = runCatching { repo.cachedCategoryItems(key) }.getOrNull()
        category = if (cached.isNullOrEmpty()) {
            CategoryUi(key = key, loading = true)
        } else {
            CategoryUi(
                key = key,
                loading = false,
                groups = Parsers.group(cached),
                supportedSources = cached.map { it.sourceKey }.distinct().size,
                failedSources = 0,
                fromCache = true,
            )
        }
        // 快速切分类时取消上一轮：否则旧协程回来会覆盖新分类的结果
        categoryJob?.cancel()
        val mySeq = ++categorySeq
        categoryJob = viewModelScope.launch {
            // 边收边渲染：4 个源 × 4 个子分类全回来要 3~6 秒，
            // 而第一个源通常 1~3 秒就有内容了。等全部回来才出画面，
            // 用户看到的就是长时间骨架屏。
            val done = mutableListOf<Triple<Boolean, List<SearchItem>, String?>>()
            val doneLock = Mutex()
            fun snapshot() = done.flatMap { it.second }
                .distinctBy { "${it.sourceKey}:${it.vodId}" }

            // 并行抓取：串行时单源 14s 超时，8 个源要等近两分钟
            val results = sources.map { source ->
                async {
                    val result = repo.browseCategory(
                        source,
                        key,
                        adultFilter = _data.value.settings.adultFilter,
                        // 有缓存时这一轮是「后台刷新」：命中 5 分钟内存缓存就够，别把整排源再打一遍
                        useCache = cached.isNullOrEmpty(),
                    )
                    val partial = doneLock.withLock {
                        done += result
                        snapshot()
                    }
                    if (partial.isNotEmpty() && mySeq == categorySeq) {
                        val okCount = doneLock.withLock { done.count { it.first } }
                        category = category.copy(
                            key = key,
                            loading = false,
                            groups = Parsers.group(partial),
                            supportedSources = okCount,
                            fromCache = false,
                        )
                    }
                    result
                }
            }.awaitAll()
            if (mySeq != categorySeq) return@launch
            val items = mutableListOf<SearchItem>()
            var supported = 0
            var failed = 0
            val reasons = mutableListOf<String>()
            for (result in results) {
                val (ok, list, note) = result
                if (ok) {
                    supported++
                    items += list
                } else if (repo.isUnsupported(note)) {
                    // 源正常答复、只是没有这个分类：既不算成功也不算失败。
                    // 记成失败会让标题多出「N 个源失败」，用户以为网络出了问题。
                } else {
                    failed++
                    if (!note.isNullOrBlank()) reasons += note
                }
            }
            if (items.isEmpty()) {
                // 刷新失败时不要把已有缓存内容清掉
                if (cached.isNullOrEmpty()) {
                    category = CategoryUi(key = key, loading = false)
                    showToast("当前源没有返回「${key.label}」内容")
                } else {
                    category = category.copy(loading = false, fromCache = true)
                }
                return@launch
            }
            val merged = items.distinctBy { "${it.sourceKey}:${it.vodId}" }
            // 跨源合并后的整体结果落到本地目录缓存，下次切回来零网络
            repo.cacheCatalogItems(key, merged)
            refreshHomeRows()
            category = CategoryUi(
                key = key,
                loading = false,
                groups = Parsers.group(merged),
                supportedSources = supported,
                failedSources = failed,
                failureReason = reasons.groupingBy { it }.eachCount()
                    .entries.sortedByDescending { it.value }.take(2)
                    .joinToString("、") { (reason, count) -> if (count > 1) "$reason×$count" else reason },
            )
        }
    }

    fun back() {
        val current = screen
        // 这里不再「补存一次进度」：播放页的 onDispose 会带着 exo 的真实位置调
        // saveProgress，而 ViewModel 拿不到播放器位置（旧实现 saveProgressNow
        // 是个空函数，属于死调用，容易让人误以为退出前一定会落盘）。
        screen = nav.target(current)
    }

    /** 手机通过 DLNA 投屏过来：直接进入播放页 */
    fun playCast(url: String, title: String) {
        screen = Screen.CastPlayer(url, title)
    }

    fun showToast(message: String) {
        toast = message
    }

    fun consumeToast() {
        toast = null
    }

    // —— 搜索 ——
    fun startSearch(keyword: String) {
        val word = keyword.trim()
        if (word.isEmpty()) return
        searchJob?.cancel()
        // 后台预热会给 FIFO 闸门塞几十个请求，用户检索必须插到前面去
        warmJob?.cancel()
        search = SearchUi(keyword = word, loading = true, searched = true)
        // 序号守卫：取消是协作式的，被取消的那一轮仍可能跑到 collect 之后的
        // 「收尾」语句（loading=false、写缓存、落拼音索引），把新一次检索的
        // 状态改掉。只有号码最新的那一轮才允许收尾。
        val mySeq = ++searchSeq
        searchJob = viewModelScope.launch {
            val sources = _data.value.activeSources()
            if (sources.isEmpty()) {
                search = search.copy(loading = false)
                showToast("还没有启用任何点播源，请在设置中添加")
                return@launch
            }
            // 拼音首字母：采集站只支持中文 LIKE，本地扫「最近列表」再按首字母过滤。
            // 遥控器输中文极难，`qmmk` 能搜到「奇妙萌可」是电视端最实用的一条输入路径。
            if (Pinyin.isQuery(word)) {
                val adult = _data.value.settings.adultFilter
                // 先把「拼音」这一条结果挂上去：不然检索期间标题栏按「0/10 个源」算，
                // 看着像什么都没干，用户以为卡死了。
                search = search.copy(
                    outcomes = listOf(
                        SourceOutcome(
                            sourceKey = PINYIN_SOURCE_KEY,
                            sourceName = "拼音「${word.lowercase()}」",
                            ok = true,
                            items = emptyList(),
                        ),
                    ),
                    groups = emptyList(),
                    loading = true,
                )
                val hits = runCatching {
                    // 边扫边把已命中的结果顶到界面上：拼音要在各源「最新列表」里
                    // 一页页往后翻（「师兄啊师兄」在 ffzyapi 第 11 页），全程
                    // 盯十几秒空白谁也受不了。
                    repo.pinyinSearch(sources, word, adult) { page, partial ->
                        if (mySeq != searchSeq) return@pinyinSearch
                        search = search.copy(
                            outcomes = listOf(
                                SourceOutcome(
                                    sourceKey = PINYIN_SOURCE_KEY,
                                    // 没命中时把进度显示出来，让用户知道它还在翻页
                                    sourceName = if (partial.isEmpty()) {
                                        "拼音「${word.lowercase()}」· 已翻到第 $page 页"
                                    } else {
                                        "拼音「${word.lowercase()}」"
                                    },
                                    ok = true,
                                    items = partial,
                                ),
                            ),
                            groups = if (partial.isEmpty()) search.groups else Parsers.group(partial),
                            loading = true,
                        )
                    }
                }.getOrDefault(emptyList())
                // 深扫出来的片名要落盘，否则每次冷启动都从零开始、
                // 拼音检索永远只有「最新几页」覆盖的那点片名。
                persistPinyinIndex()
                if (mySeq != searchSeq) return@launch
                val outcome = SourceOutcome(
                    sourceKey = PINYIN_SOURCE_KEY,
                    sourceName = "拼音「${word.lowercase()}」",
                    ok = true,
                    items = hits,
                )
                search = search.copy(
                    outcomes = listOf(outcome),
                    groups = Parsers.group(hits),
                    loading = false,
                )
                if (hits.isEmpty()) {
                    showToast("没有匹配「${word.lowercase()}」的影片：拼音检索靠本地片名索引，可先用中文搜一次或换个首字母")
                }
                return@launch
            }
            // 检索结果缓存：同一个片名一天里会被搜好几次（没找到、隔天再搜、家里人再搜），
            // 命中就直接出结果，不用再打 4 个源 × 3 页。缓存 1 小时，见 SearchCacheSnapshot。
            val adultFilter = _data.value.settings.adultFilter
            val signature = catalogSignature(sources, adultFilter)
            val cacheSnap = runCatching { store.searchCache(signature) }.getOrNull()
            val cachedHits = cacheSnap?.itemsOf(word, adultFilter)
            if (!cachedHits.isNullOrEmpty()) {
                val outcome = SourceOutcome(
                    sourceKey = CACHE_SOURCE_KEY,
                    sourceName = "本地缓存",
                    ok = true,
                    items = cachedHits,
                )
                search = search.copy(
                    outcomes = listOf(outcome),
                    groups = Parsers.group(cachedHits),
                    loading = false,
                    fromCache = true,
                )
                // 缓存先给结果，后台仍继续拉一遍最新的，拿到就覆盖
                // （采集站新片更新很快，完全信缓存会搜不到刚上的片）
            }
            repo.searchAll(sources, word, adultFilter)
                .catch { e ->
                    // 取消不是错误：吞掉它会让下面的收尾逻辑照常执行，
                    // 从而把用户新一次检索的状态覆盖掉
                    if (e is kotlinx.coroutines.CancellationException) throw e
                }
                .collect { outcome ->
                    if (mySeq != searchSeq) return@collect
                    val outcomes = search.outcomes.filter { it.sourceKey != outcome.sourceKey } + outcome
                    val items = outcomes.filter { it.ok }.flatMap { it.items }
                    search = search.copy(
                        outcomes = outcomes.filter { it.sourceKey != CACHE_SOURCE_KEY },
                        groups = Parsers.group(items),
                        loading = outcomes.size < sources.size,
                        fromCache = false,
                    )
                }
            if (mySeq != searchSeq) return@launch
            search = search.copy(loading = false)
            // 有结果才写缓存：空结果也缓存住的话，源临时抽风会让用户一小时内都搜不到
            val collected = search.outcomes.filter { it.ok }.flatMap { it.items }
            if (collected.isNotEmpty()) {
                val base = cacheSnap ?: org.librextv.tv.data.SearchCacheSnapshot()
                val next = base.withEntry(word, adultFilter, collected)
                viewModelScope.launch { runCatching { store.saveSearchCache(signature, next) } }
            }
            persistPinyinIndex()
        }
    }

    /**
     * 把「见过的片名」落盘，供拼音检索下次直接用。
     *
     * 不是每次都写：一条索引就是一次整份 JSON 序列化，攒够 80 条再写一次足够。
     */
    private fun persistPinyinIndex() {
        val snapshot = repo.seenSnapshot()
        if (snapshot.size < persistedIndexSize + 80) return
        persistedIndexSize = snapshot.size
        viewModelScope.launch { runCatching { store.savePinyinIndex(snapshot) } }
    }

    fun openDetail(group: SearchGroup, item: SearchItem) {
        // 记住来源页：详情页与播放页返回时按原路径退回
        if (screen !is Screen.Detail) nav.enterDetail(screen)
        screen = Screen.Detail(group, item)
        detail = DetailUi(loading = true)
        // 换片源最多试 8 个、每个 9 秒，慢的时候能跑一分多钟。
        // 这段时间里用户可能已经返回或进了别的详情，所以既要能取消，
        // 也要用序号把「过期的结果」挡在门外，否则会把导航劫持回去。
        val seq = ++detailSeq
        detailJob?.cancel()
        detailJob = viewModelScope.launch {
            val sources = _data.value.sources
            val sourceOf: (SearchItem) -> VodSource = { entry ->
                sources.firstOrNull { it.key == entry.sourceKey }
                    ?: VodSource(entry.sourceKey, entry.sourceName, entry.sourceUrl ?: "")
            }

            // 当前源拿不到详情就换同片的其它源：常见于某采集站详情接口挂掉但搜索还活着，
            // 用户看到的是「详情加载失败」，实际上同一部片子别的源完全能播
            val candidates = PlaybackCandidate.build(group.items, sources, active = item.sourceKey to item.vodId)
            val chain = if (candidates.isEmpty()) {
                listOf(PlaybackCandidate(sourceOf(item), item.vodId, item.sourceName))
            } else {
                candidates
            }

            var lastError = "没有可用的片源"
            for (candidate in chain) {
                if (seq != detailSeq) return@launch
                val target = group.items.firstOrNull {
                    it.sourceKey == candidate.source.key && it.vodId == candidate.vodId
                } ?: item
                val result = withTimeoutOrNull(DETAIL_TIMEOUT_MS) {
                    runCatchingCancellable { repo.detail(sourceOf(target), target.vodId) }
                }
                val vod = result?.getOrNull()
                if (vod != null && vod.episodes.isNotEmpty()) {
                    // 用户已经离开详情页（或又点了别的片）：不要把界面拽回来
                    if (seq != detailSeq || screen !is Screen.Detail) return@launch
                    if (target !== item) {
                        // 换了源：详情页也要跟着切，否则播放按钮用的还是旧 item
                        screen = Screen.Detail(group, target)
                        showToast("已切换到「${target.sourceName}」")
                    }
                    detail = DetailUi(loading = false, detail = vod)
                    return@launch
                }
                lastError = result?.exceptionOrNull()?.message ?: "「${target.sourceName}」没有可播放的线路"
            }
            if (seq != detailSeq || screen !is Screen.Detail) return@launch
            detail = DetailUi(loading = false, error = lastError)
        }
    }

    fun playFromDetail(index: Int) {
        val current = screen as? Screen.Detail ?: return
        val vod = detail?.detail ?: return
        val source = _data.value.sources.firstOrNull { it.key == current.item.sourceKey }
            ?: VodSource(current.item.sourceKey, current.item.sourceName, current.item.sourceUrl ?: "")
        // 从详情页起播：返回键退回这个详情页，而不是退回详情页的来源页。
        // 这里曾经什么都不做，backTarget 还是「进详情之前」的分类页，
        // 于是播放页按一次返回连退两级（播放 → 分类）。
        nav.playFromDetail(current)
        screen = Screen.Player(
            source = source,
            vodId = current.item.vodId,
            title = vod.title ?: current.item.name,
            year = current.item.year,
            cover = vod.cover ?: current.item.pic,
            episodes = vod.episodes,
            startIndex = HistoryDedupe.clampEpisodeIndex(index, vod.episodes.size),
            sourceName = current.item.sourceName,
            // 聚合结果里同片源的其它条目就是天然的备份播放源
            candidates = PlaybackCandidate.build(
                items = current.group.items,
                sources = _data.value.sources,
                active = current.item.sourceKey to current.item.vodId,
            ),
        )
    }

    fun resumeFromHistory(entry: HistoryEntry) {
        // 连按 OK 会叠出多个并发请求，每个都能走 20 秒；这里只允许一个在飞，
        // 并给它一个可见的上限（超时给提示），否则界面看起来像「按了没反应」。
        if (openingJob?.isActive == true) return
        openingJob = viewModelScope.launch {
            val source = _data.value.sources.firstOrNull { it.key == entry.sourceKey }
            if (source == null) {
                showToast("该片源已被删除")
                return@launch
            }
            val detail = withTimeoutOrNull(DETAIL_TIMEOUT_MS) { repo.detail(source, entry.vodId) }
            val result = runCatching { detail ?: throw IllegalStateException("超时") }
            result.onSuccess { vod ->
                if (vod.episodes.isEmpty()) {
                    showToast("该片源暂无可用播放地址")
                    return@launch
                }
                // 从首页「继续观看」起播：返回直接回首页
                nav.playFrom(Screen.Home)
                screen = Screen.Player(
                    source = source,
                    vodId = entry.vodId,
                    title = vod.title ?: entry.title,
            year = entry.year ?: vod.year,
                    cover = vod.cover ?: entry.cover,
                    episodes = vod.episodes,
                    // 历史里的下标只对写入它的那个源有效（各采集站分集列表长度不同），
                    // 必须按这份新列表夹紧；大小已由上面的空判断保证 >= 1
                    startIndex = HistoryDedupe.clampEpisodeIndex(entry.episodeIndex, vod.episodes.size),
                    sourceName = entry.sourceName,
                    // 历史里只有一个源：先建单元素链，播放页失败时会按片名反查补充
                    candidates = listOf(PlaybackCandidate(source, entry.vodId, entry.sourceName)),
                )
            }.onFailure { showToast(it.message ?: "打开失败") }
        }
    }

    fun playFavorite(favoriteId: String) {
        val entry = _data.value.history.firstOrNull { it.id == favoriteId }
        if (entry != null) {
            resumeFromHistory(entry)
            return
        }
        val fav = _data.value.favorites.firstOrNull { it.id == favoriteId } ?: return
        if (openingJob?.isActive == true) return
        openingJob = viewModelScope.launch {
            val source = _data.value.sources.firstOrNull { it.key == fav.sourceKey }
            if (source == null) {
                showToast("该片源已被删除")
                return@launch
            }
            val detail = withTimeoutOrNull(DETAIL_TIMEOUT_MS) { repo.detail(source, fav.vodId) }
            runCatching { detail ?: throw IllegalStateException("超时") }
                .onSuccess { vod ->
                    if (vod.episodes.isEmpty()) {
                        showToast("该片源暂无可用播放地址")
                        return@launch
                    }
                    // 从首页「我的收藏」起播：返回直接回首页
                    nav.playFrom(Screen.Home)
                    screen = Screen.Player(
                        source = source,
                        vodId = fav.vodId,
                        title = vod.title ?: fav.title,
            year = fav.year,
                        cover = vod.cover ?: fav.cover,
                        episodes = vod.episodes,
                        startIndex = 0,
                        sourceName = source.name,
                        candidates = listOf(PlaybackCandidate(source, fav.vodId, source.name)),
                    )
                }
                .onFailure { showToast(it.message ?: "打开失败") }
        }
    }

    // —— 观看进度 ——
    fun saveProgress(
        player: Screen.Player,
        index: Int,
        positionMs: Long,
        durationMs: Long,
        finished: Boolean = false,
    ) {
        if (!_data.value.settings.resumePlayback) return
        if (positionMs <= 0) return
        // 看完的一集记为「已完成」，下次续播从头开始；未看完的才记具体位置
        val effectivePosition = if (finished) 0L else positionMs
        val id = "${player.source.key}:${player.vodId}"
        val entry = HistoryEntry(
            id = id,
            sourceKey = player.source.key,
            vodId = player.vodId,
            title = player.title,
            year = player.year,
            cover = player.cover,
            sourceName = player.sourceName,
            // 看完一集推到下一集，但不能越界：原先写 `.coerceAtMost(size)` 会存下
            // 等于列表长度的下标，首页卡片于是显示「第 17 / 16 集」
            episodeIndex = HistoryDedupe.clampEpisodeIndex(if (finished) index + 1 else index, player.episodes.size),
            episodeCount = player.episodes.size,
            positionMs = effectivePosition,
            durationMs = durationMs,
            updatedAt = System.currentTimeMillis(),
        )
        viewModelScope.launch {
            store.update { data ->
                // 按片名去重（跨源）：同一部片子不因换了采集源而多出一条记录
                data.copy(history = HistoryDedupe.upsert(data.history, entry))
            }
        }
    }

    /**
     * 播放失败时切换到下一个候选源（失败转移）。
     *
     * 候选链试完后，只要还有其它启用的源，就按片名反查一轮补充候选；
     * 补出来的也全部失败才返回 null，避免无限循环。
     * 返回 (新播放目标, 对齐后的集数)，调用方负责用它替换当前播放状态。
     */
    suspend fun failoverPlayback(
        player: Screen.Player,
        tried: Set<String>,
        episodeIndex: Int,
        discovered: Boolean,
    ): FailoverResult? {
        var chain = player.candidates
        var searched = discovered
        // 必须自己记账：入参 tried 是调用方的快照，如果只拿它过滤，
        // 「详情拉不到」的候选会被无限重试（每次 8~20 秒超时，播放页永远停在切换中）
        val attempted = tried.toMutableSet()

        while (true) {
            currentCoroutineContext().ensureActive()
            val untried = chain.filter { it.key !in attempted }
            if (untried.isEmpty()) {
                if (searched) return null
                searched = true
                // 跨源反查片名要走一整轮多源搜索，同样不能无限等：超时就当作「没找到」，
                // 直接把控制权交回播放页（提示「没有更多可用片源了」），别让界面空转。
                val extra = withTimeoutOrNull(FAILOVER_DISCOVER_TIMEOUT_MS) {
                    runCatchingCancellable {
                        repo.discoverCandidates(
                            title = player.title,
                            sources = _data.value.activeSources(),
                            exclude = attempted,
                        )
                    }.getOrDefault(emptyList())
                } ?: emptyList()
                if (extra.isEmpty()) return null
                chain = (chain + extra).distinctBy { it.key }
                continue
            }

            val next = untried.first()
            attempted += next.key
            // 必须给超时：repo.detail 内部是「先 ?ac=videolist&ids=，失败再爬详情页」，
            // 两段各 20 秒。不加超时时单个候选最长挂 40 秒，而这段时间
            // failingOver=true 让看门狗也不敢介入，界面上就是「正在切换到…」卡死。
            val detail = withTimeoutOrNull(FAILOVER_CANDIDATE_TIMEOUT_MS) {
                runCatchingCancellable { repo.detail(next.source, next.vodId) }.getOrNull()
            }
            if (detail == null || detail.episodes.isEmpty()) continue

            // 与详情页/观看记录用同一个夹紧口径（HistoryDedupe.clampEpisodeIndex），
            // 各写一份 coerceIn 才会出现「显示第 15 集、实际播第 2 集」的错位。
            val aligned = HistoryDedupe.clampEpisodeIndex(episodeIndex, detail.episodes.size)
            val target = player.copy(
                source = next.source,
                vodId = next.vodId,
                sourceName = next.sourceName,
                title = detail.title ?: player.title,
                cover = detail.cover ?: player.cover,
                episodes = detail.episodes,
                startIndex = aligned,
                candidates = chain,
            )
            return FailoverResult(target, aligned, next, detail)
        }
    }

    /**
     * 与 [runCatching] 相同的兜底，但把协程取消原样抛出去。
     *
     * `runCatching` 连 `CancellationException` 一起吞掉，会让「退出播放页后仍在后台拉流」
     * 变成可能，也让超时/取消被当成普通失败。
     */
    private suspend inline fun <T> runCatchingCancellable(block: () -> T): Result<T> =
        try {
            Result.success(block())
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }

    data class FailoverResult(
        val target: Screen.Player,
        val episodeIndex: Int,
        val candidate: PlaybackCandidate,
        val detail: VodDetail,
    )

    fun removeHistory(id: String) {
        viewModelScope.launch { store.update { it.copy(history = it.history.filter { h -> h.id != id }) } }
    }

    fun clearHistory() {
        viewModelScope.launch { store.update { it.copy(history = emptyList()) } }
        showToast("观看历史已清空")
    }

    fun toggleFavorite(item: SearchItem, title: String?, cover: String?) {
        val id = "${item.sourceKey}:${item.vodId}"
        // 是否已收藏要在 update 之前算：update 是异步回写 DataStore，
        // 之后的 _data.value 仍是旧快照，提示语会反掉
        val wasFavorite = _data.value.favorites.any { it.id == id }
        viewModelScope.launch {
            store.update { data ->
                val exists = data.favorites.any { it.id == id }
                if (exists) data.copy(favorites = data.favorites.filter { it.id != id })
                else data.copy(
                    favorites = listOf(
                        org.librextv.tv.data.FavoriteEntry(
                            id = id,
                            sourceKey = item.sourceKey,
                            vodId = item.vodId,
                            title = title ?: item.name,
                            year = item.year,
                            cover = cover ?: item.pic,
                            createdAt = System.currentTimeMillis(),
                        )
                    ) + data.favorites
                )
            }
            showToast(if (wasFavorite) "已取消收藏" else "已收藏")
        }
    }

    // —— 直播 ——

    /** 直播缓存的签名：源地址集合 + 成人过滤开关，任一变化都重拉 */
    private fun liveSignature(sources: List<LiveSource>, adultFilter: Boolean): String =
        sources.map { it.url }.sorted().joinToString("|") + "#" + if (adultFilter) "1" else "0"

    /**
     * 拉取直播频道列表：缓存优先 + 渐进渲染。
     *
     * 实测 iptv-org 的 index.m3u 有 2.46MB、服务器只给 ~35KB/s，整串下载要 70 秒，
     * 而解析只要十几毫秒。原实现是全部下完才赋值，用户要盯着一分钟空列表。
     * 现在三件事同时做：
     * 1. 先读 DataStore 缓存，命中就立刻渲染（进直播页从 70 秒降到 0）；
     * 2. 网络请求边下边解析，每 120 个频道刷新一次列表（第一批约 1 秒上屏）；
     * 3. 全部完成后落盘，下次直接命中。
     */
    fun loadLive(force: Boolean = false) {
        val sources = _data.value.activeLiveSources()
        if (sources.isEmpty()) {
            live = live.copy(loading = false)
            showToast("还没有启用任何直播源")
            return
        }
        if (live.loading) return
        val adultFilter = _data.value.settings.adultFilter
        val signature = liveSignature(sources, adultFilter)
        live = live.copy(loading = true)
        liveBytes = 0L

        viewModelScope.launch {
            // 1) 缓存优先
            if (!force) {
                val cached = runCatching { store.liveCache(signature) }.getOrNull()
                if (!cached.isNullOrEmpty()) {
                    live = live.copy(
                        channels = cached,
                        groups = listOf("全部") + Parsers.groups(cached),
                        statuses = sources.map { s -> s.name to "${cached.count { it.sourceKey == s.key }} 频道" },
                        loading = false,
                        fromCache = true,
                    )
                    // 后台继续刷新，失败就保留缓存（缓存总比空列表有用）
                    refreshLive(sources, adultFilter, signature, quiet = true, progressive = false)
                    return@launch
                }
            }
            refreshLive(sources, adultFilter, signature, quiet = false, progressive = true)
        }
    }

    /**
     * 真正发起网络请求。
     *
     * @param progressive 为 true 时边下边把已解析的频道推给 UI，为 false 时只等最终结果。
     *   已经有缓存列表在屏上时必须传 false：否则界面会先退化成前 120 个频道再长回来，
     *   视觉上像「列表被重置了」。
     */
    private suspend fun refreshLive(
        sources: List<LiveSource>,
        adultFilter: Boolean,
        signature: String,
        quiet: Boolean,
        progressive: Boolean,
    ) {
        // 按源分别累加，合并时按 sources 顺序取，避免频道顺序在每次刷新时乱跳
        val buffers = LinkedHashMap<String, List<LiveChannel>>()
        val mutex = Mutex()
        val done = HashMap<String, String>()
        // 渐进刷新节流：全球列表一万多个频道、每 120 个回调一次，不节流就是
        // 近百次「重算 groups + 整体替换列表」，Compose 重组会明显卡顿。
        // 400ms 足够让首屏一秒内出现，又把工作量压到个位数量级。
        var lastPush = 0L
        val pushIntervalMs = 400L
        val reportProgress = { bytes: Long ->
            // 只写独立的字节计数状态：这里在下载协程（IO）上高频回调，
            // 改成 live.copy(...) 会和下面 onBatch 的写入互相覆盖字段。
            liveBytes = bytes
        }

        coroutineScope {
            sources.forEach { source ->
                launch {
                    var count = 0
                    runCatching {
                        repo.liveChannelsStream(
                            source = source,
                            adultFilter = adultFilter,
                            onBytes = { if (source.key == sources.first().key) reportProgress(it) },
                        ) { batch ->
                            count += batch.size
                            mutex.withLock {
                                buffers[source.key] = (buffers[source.key] ?: emptyList()) + batch
                                val now = System.currentTimeMillis()
                                if (progressive && (lastPush == 0L || now - lastPush >= pushIntervalMs)) {
                                    lastPush = now
                                    val merged = Parsers.dedupeChannels(
                                        sources.mapNotNull { buffers[it.key] }.flatten()
                                    )
                                    // loading 保持 true：列表已经在长，但仍需显示"仍在读取"，
                                    // 也让 loadLive 的并发保护继续生效
                                    // live 是「读快照 → 改字段 → 整体写回」，这段在下载协程里跑，
                                    // 和主线程的 setLiveGroup/setLiveKeyword 并发写会互相回退字段
                                    //（表现：刚点的分组被弹回「全部」）。统一挪到主线程串行写。
                                    withContext(Dispatchers.Main) {
                                        live = live.copy(
                                            channels = merged,
                                            groups = listOf("全部") + Parsers.groups(merged),
                                        )
                                    }
                                }
                            }
                        }
                    }
                        .onSuccess { mutex.withLock { done[source.key] = "$count 频道" } }
                        .onFailure { err ->
                            mutex.withLock {
                                done[source.key] =
                                    if (count > 0) "$count 频道（下载中断）"
                                    else (err.message ?: "加载失败")
                            }
                        }
                }
            }
        }

        val merged = Parsers.dedupeChannels(sources.mapNotNull { buffers[it.key] }.flatten())
        if (merged.isEmpty()) {
            // 一个频道都没拿到：缓存还在就别清空，只把 loading 摘掉
            live = live.copy(
                loading = false,
                downloadedBytes = 0,
                statuses = sources.map { s -> s.name to (done[s.key] ?: "加载失败") },
            )
            if (!quiet) showToast("所有直播源都没有解析到频道")
            return
        }
        live = live.copy(
            loading = false,
            channels = merged,
            groups = listOf("全部") + Parsers.groups(merged),
            statuses = sources.map { s -> s.name to (done[s.key] ?: "加载失败") },
            downloadedBytes = 0,
            fromCache = false,
        )
        runCatching { store.saveLiveCache(signature, merged) }
    }

    fun setLiveGroup(group: String) {
        live = live.copy(selectedGroup = group)
    }

    fun setLiveKeyword(keyword: String) {
        live = live.copy(keyword = keyword)
    }

    fun toggleLiveFavorite(channel: LiveChannel) {
        viewModelScope.launch {
            store.update { data ->
                val exists = data.liveFavorites.any { it.url == channel.url }
                if (exists) data.copy(liveFavorites = data.liveFavorites.filter { it.url != channel.url })
                else data.copy(
                    liveFavorites = (
                        listOf(
                            org.librextv.tv.data.LiveFavoriteEntry(
                                url = channel.url,
                                name = channel.name,
                                logo = channel.logo,
                                createdAt = System.currentTimeMillis(),
                            )
                        ) + data.liveFavorites
                        ).take(FAVORITE_LIMIT)
                )
            }
        }
    }

    // —— 设置 / 源管理 ——
    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch { store.update { it.copy(settings = transform(it.settings)) } }
    }

    /**
     * 添加点播源。返回 false 表示校验没过（UI 据此决定是否清空输入框）——
     * 以前 UI 无条件清空，输错一个字符名称/地址/详情全丢，只能重打。
     */
    fun addSource(name: String, url: String, detailUrl: String?): Boolean {
        val cleanUrl = url.trim().trimEnd('/')
        if (!cleanUrl.startsWith("http")) {
            showToast("请填写 http(s) 开头的采集接口地址")
            return false
        }
        // 同一地址加两次会让搜索/分类对同一个接口发两份请求，详情页的「同片源」
        // 也会出现两个同名条目。导入订阅与恢复默认源都做了去重，手动添加漏了。
        if (_data.value.sources.any { it.url.trimEnd('/') == cleanUrl }) {
            showToast("这个采集接口已经添加过了")
            return false
        }
        val key = "custom_${UUID.randomUUID().toString().take(8)}"
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    sources = data.sources + VodSource(
                        key = key,
                        name = name.ifBlank { runCatching { java.net.URI(cleanUrl).host }.getOrDefault(cleanUrl) },
                        url = cleanUrl,
                        detail = detailUrl?.trim()?.takeIf { it.isNotEmpty() },
                    ),
                    selected = data.selected + key,
                )
            }
            showToast("已添加点播源")
        }
        return true
    }

    fun removeSource(key: String) {
        val defaults = Defaults.load(getApplication()).first.map { it.url }.toSet()
        viewModelScope.launch {
            store.update { data ->
                val target = data.sources.firstOrNull { it.key == key }
                // 记下被删掉的内置源地址：内置源清单升级时不能再把它塞回来
                val removed =
                    if (target != null && target.url in defaults) {
                        (data.removedDefaultUrls + target.url).distinct()
                    } else {
                        data.removedDefaultUrls
                    }
                data.copy(
                    sources = data.sources.filter { it.key != key },
                    selected = data.selected - key,
                    history = data.history.filter { it.sourceKey != key },
                    favorites = data.favorites.filter { it.sourceKey != key },
                    removedDefaultUrls = removed,
                )
            }
        }
    }

    fun toggleSource(key: String) {
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    selected = if (key in data.selected) data.selected - key else data.selected + key
                )
            }
        }
    }

    /** 添加直播源；返回 false 表示校验没过（UI 据此决定是否清空输入框） */
    fun addLiveSource(name: String, url: String, epg: String?): Boolean {
        val cleanUrl = url.trim().trimEnd('/')
        if (!cleanUrl.startsWith("http")) {
            showToast("请填写 http(s) 开头的 M3U 地址")
            return false
        }
        // 同 addSource：重复地址会在直播列表里出现两份同样的频道
        if (_data.value.liveSources.any { it.url.trimEnd('/') == cleanUrl }) {
            showToast("这个直播源已经添加过了")
            return false
        }
        val key = "live_${UUID.randomUUID().toString().take(8)}"
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    liveSources = data.liveSources + LiveSource(
                        key = key,
                        name = name.ifBlank { runCatching { java.net.URI(cleanUrl).host }.getOrDefault(cleanUrl) },
                        url = cleanUrl,
                        epg = epg?.trim()?.takeIf { it.isNotEmpty() },
                    ),
                    liveSelected = data.liveSelected + key,
                )
            }
            showToast("已添加直播源")
        }
        return true
    }

    fun removeLiveSource(key: String) {
        val defaults = Defaults.load(getApplication()).second.map { it.url }.toSet()
        viewModelScope.launch {
            store.update { data ->
                val target = data.liveSources.firstOrNull { it.key == key }
                val removed =
                    if (target != null && target.url in defaults) {
                        (data.removedDefaultUrls + target.url).distinct()
                    } else {
                        data.removedDefaultUrls
                    }
                data.copy(
                    liveSources = data.liveSources.filter { it.key != key },
                    liveSelected = data.liveSelected - key,
                    removedDefaultUrls = removed,
                )
            }
        }
    }

    fun toggleLiveSource(key: String) {
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    liveSelected = if (key in data.liveSelected) data.liveSelected - key else data.liveSelected + key
                )
            }
        }
    }

    fun importSubscription(url: String) {
        // 重入守卫：遥控器连按 OK 会并发跑两次导入，store.update 的
        // read-modify-write 可能把同一批源重复追加、勾选集合互相覆盖。
        // importing 以前只用于改按钮文案，挡不住任何东西。
        if (importing) {
            showToast("正在导入，请稍候")
            return
        }
        val trimmed = url.trim()
        if (!trimmed.startsWith("http")) {
            showToast("请填写订阅地址")
            return
        }
        importing = true
        viewModelScope.launch {
            runCatching { repo.importSubscription(trimmed) }
                .onSuccess { parsed ->
                    store.update { data ->
                        val vod = parsed.sources.filter { s -> data.sources.none { it.url == s.url } }
                        val lives = parsed.liveSources.filter { s -> data.liveSources.none { it.url == s.url } }
                        data.copy(
                            sources = data.sources + vod,
                            selected = (data.selected + vod.map { it.key }).distinct(),
                            liveSources = data.liveSources + lives,
                            liveSelected = (data.liveSelected + lives.map { it.key }).distinct(),
                        )
                    }
                    if (parsed.sources.isEmpty() && parsed.liveSources.isEmpty()) {
                        showToast("订阅里没有可用的源")
                    } else {
                        showToast("已导入 ${parsed.sources.size} 个点播源、${parsed.liveSources.size} 个直播源")
                    }
                }
                .onFailure { showToast(it.message ?: "导入失败") }
            importing = false
        }
    }

    fun restoreBuiltinSources() {
        viewModelScope.launch {
            val (vod, lives) = Defaults.load(getApplication())
            // 恢复默认同样只勾选「默认启用」的那几个：恢复默认源不该顺手把
            // 一万多个境外台打开（打开后立刻就是卡死）
            val defaultLiveSelected = Defaults.defaultLiveSelectedKeys(getApplication())
            store.update { data ->
                val newVod = vod.filter { s -> data.sources.none { it.url == s.url } }
                val newLive = lives.filter { s -> data.liveSources.none { it.url == s.url } }
                // 用户明确点了「恢复」：把「不再自动补回」的名单一并清掉，
                // 否则下次升级补源时这些刚恢复的地址又会被当成「用户删掉的」。
                val restored = (newVod.map { it.url } + newLive.map { it.url }).toSet()
                data.copy(
                    sources = data.sources + newVod,
                    selected = (data.selected + newVod.map { it.key }).distinct(),
                    liveSources = data.liveSources + newLive,
                    liveSelected = (
                        data.liveSelected + newLive.filter { it.key in defaultLiveSelected }.map { it.key }
                        ).distinct(),
                    removedDefaultUrls = data.removedDefaultUrls.filter { it !in restored },
                )
            }
            showToast("已恢复内置默认源")
        }
    }
}
