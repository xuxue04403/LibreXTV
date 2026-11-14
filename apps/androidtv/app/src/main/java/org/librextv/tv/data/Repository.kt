package org.librextv.tv.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.net.URLEncoder
import kotlinx.serialization.json.jsonObject

/** 拼音检索最多翻到「各源最新列表」的第几页 */
private const val PINYIN_MAX_PAGES = 24

/** 拼音检索的总预算：太短会扫不到（「师兄啊师兄」在 ffzyapi 第 11 页），太长用户等不起 */
private const val PINYIN_BUDGET_MS = 30_000L

/** 单源单页的超时：一个源挂住不能拖住整轮 */
private const val PINYIN_PAGE_TIMEOUT_MS = 6_000L

/** 每个源一次并发抓几页（滑动窗口）。串行翻页每页都要付一次完整 TTFB，太慢 */
private const val PINYIN_WINDOW = 5

/** 拼音扫描自己的并发上限：不走全局闸门（FIFO 会排在目录刷新后面），但要防打爆采集站 */
private const val PINYIN_CONCURRENCY = 12

/** 已经找到这么多条就不再往下翻，剩下的留给下次 */
private const val PINYIN_ENOUGH_HITS = 8

/** 本地已命中但不足 [PINYIN_ENOUGH_HITS] 时，补扫网络的短预算（首帧已出，不阻塞观感） */
private const val PINYIN_ENRICH_BUDGET_MS = 12_000L

/** 启动预热：每个源补扫到第几页 */
private const val PINYIN_WARM_PAGES = 20

/** 启动预热的预算（后台跑，不挡用户操作） */
private const val PINYIN_WARM_BUDGET_MS = 60_000L

/**
 * 业务仓库：把「抓取 + 解析」封装成挂起函数。
 * 桌面端由 packages/core 承担同一职责，两端行为保持一致。
 */
class Repository(private val net: Net = Net) {
    /**
     * 会话内见过的条目，作为拼音检索的本地索引。
     *
     * 拼音只能在本地比对（采集站不支持），所以「已经搜过/浏览过」的东西
     * 必须留在内存里：用户先翻过动漫分类再敲 `qmmk`，不该再去抓一遍网络。
     *
     * 用 LinkedHashMap 而不是 ConcurrentHashMap：落盘时按 `take(PINYIN_INDEX_LIMIT)`
     * 截断，注释与实现都假设「新的在前」。ConcurrentHashMap.values 没有顺序保证，
     * 超过上限后淘汰掉的是哈希序里的任意子集 —— 刚浏览过的片名可能根本进不了索引，
     * 用户敲拼音搜不到自己五分钟前才看过的片子。这里按插入顺序维护（重复插入时
     * 提到最近），并显式设上限，避免长时间使用后无限增长。
     */
    private val seenLock = Any()
    private val seenItems = LinkedHashMap<String, SearchItem>(256, 0.75f, false)

    /** 内存里最多留多少条（与落盘上限一致，避免两者语义分叉） */
    private val seenLimit = 6000

    /** 当前已见过的条目快照（拼音索引持久化用）：按插入顺序，最近的在后 */
    fun seenSnapshot(): List<SearchItem> = synchronized(seenLock) { seenItems.values.toList() }

    fun rememberItems(items: List<SearchItem>) {
        synchronized(seenLock) {
            for (item in items) {
                val key = "${item.sourceKey}:${item.vodId}"
                // 先删再放：重复出现的条目要挪到「最近」，而不是停留在首次位置
                seenItems.remove(key)
                seenItems[key] = item
            }
            // 超上限就丢最老的
            while (seenItems.size > seenLimit) {
                val oldest = seenItems.keys.firstOrNull() ?: break
                seenItems.remove(oldest)
            }
        }
    }

    /**
     * 落盘目录缓存（由 ViewModel 在初始化时注入 store 里读出来的快照）。
     *
     * 缓存放这里而不是 ViewModel：`browseCategory` 是决定「要不要打网络」的地方，
     * 判断必须和读取在同一处，否则容易出现「界面说有缓存、数据层还是照抓一遍」。
     */
    @Volatile
    private var catalog: CatalogSnapshot? = null

    /** 目录缓存变更后通知外面落盘 */
    var onCatalogChanged: ((CatalogSnapshot) -> Unit)? = null

    fun installCatalog(snapshot: CatalogSnapshot?) {
        catalog = snapshot
    }

    fun catalogSnapshot(): CatalogSnapshot = catalog ?: CatalogSnapshot(signature = "")

    /**
     * 目录缓存的读-改-写锁。
     *
     * `cacheCatalogItems` 与 `markCatalogChecked` 都是「读当前快照 → 造新快照 → 写回」。
     * 首页会并行抓 8 个分类，没有锁时后写的会把先写的整份覆盖掉，
     * 表现为「明明抓到了，切回来又变成空的」。
     */
    private val catalogLock = Any()

    /** 写入某个分类的缓存条目（内存 + 回调落盘） */
    fun cacheCatalogItems(key: CategoryKey, items: List<SearchItem>) {
        val changed = synchronized(catalogLock) {
            val current = catalog ?: return
            val next = current.withEntry(key, items)
            if (next === current) return
            catalog = next
            next
        }
        onCatalogChanged?.invoke(changed)
    }

    /**
     * 只记「这个分类刚查过」，不动内容。
     *
     * 空结果分不清「本来就没有」和「这次网络抽风」，两种情况都不该清空已有内容；
     * 但不记时间的话，空分类永远不算新鲜，后台每小时都为它重打一轮请求。
     */
    fun markCatalogChecked(key: CategoryKey) {
        val changed = synchronized(catalogLock) {
            val current = catalog ?: return
            val next = current.markChecked(key)
            catalog = next
            next
        }
        onCatalogChanged?.invoke(changed)
    }

    /** 缓存里这个分类的内容；已过期也返回（界面先用旧内容顶上，后台再刷） */
    fun cachedCategory(key: CategoryKey): List<SearchItem>? = catalog?.itemsOf(key)

    /** 全局搜索用的关键词缓存由 ViewModel 持有，这里只暴露「有没有可用的源签名」 */
    fun catalogSignature(): String? = catalog?.signature?.takeIf { it.isNotEmpty() }


    /** 单源搜索：第一页拿 pagecount，再并行/顺序补齐后续页（默认最多 2 页，电视端不宜拖太久） */
    suspend fun search(
        source: VodSource,
        keyword: String,
        maxPages: Int = 2,
        timeoutMs: Long = 10_000,
    ): SourceOutcome {
        val started = System.currentTimeMillis()
        if (!source.url.startsWith("http")) {
            return SourceOutcome(source.key, source.name, false, error = "无效的源地址", ms = 0)
        }
        val base = source.url.trimEnd('/')
        val encoded = URLEncoder.encode(keyword, "UTF-8")

        val result = withTimeoutOrNull(timeoutMs) {
            try {
                val firstText = net.getTextGated("$base?ac=videolist&wd=$encoded&pg=1")
                val root = runCatching { LooseJson.parseToJsonElement(firstText).jsonObject }.getOrNull()
                val items = Parsers.parseSearchList(firstText, source).toMutableList()
                val pageCount = root?.str("pagecount")?.toIntOrNull() ?: 1
                val pages = minOf(maxPages, maxOf(1, pageCount))
                for (page in 2..pages) {
                    runCatching {
                        Parsers.parseSearchList(net.getTextGated("$base?ac=videolist&wd=$encoded&pg=$page"), source)
                    }.getOrNull()?.let { items.addAll(it) }
                }
                Result.success(items.distinctBy { it.vodId }.also { rememberItems(it) })
            } catch (e: kotlinx.coroutines.CancellationException) {
                // 取消不是「这个源失败」：必须原样抛出去。
                // runCatching 会连 CancellationException 一起吞掉，用户切分类/退出页面时
                // 就会看到一条英文的 "Timed out waiting for ..." 被当成源错误展示。
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

        val elapsed = System.currentTimeMillis() - started
        return when {
            result == null -> SourceOutcome(source.key, source.name, false, error = "请求超时", timedOut = true, ms = elapsed)
            result.isSuccess -> SourceOutcome(source.key, source.name, true, items = result.getOrThrow(), ms = elapsed)
            else -> SourceOutcome(
                source.key,
                source.name,
                false,
                error = result.exceptionOrNull()?.message ?: "失败",
                ms = elapsed,
            )
        }
    }

    /** 多源并行搜索：每个源结算即 send 一条，UI 边收边渲染 */
    fun searchAll(
        sources: List<VodSource>,
        keyword: String,
        adultFilter: Boolean,
        maxPages: Int = 2,
        timeoutMs: Long = 10_000,
    ): Flow<SourceOutcome> = channelFlow {
        sources.forEach { source ->
            launch {
                val outcome = search(source, keyword, maxPages, timeoutMs)
                send(filterOutcome(outcome, keyword, adultFilter))
            }
        }
    }

    private fun filterOutcome(outcome: SourceOutcome, keyword: String, adultFilter: Boolean): SourceOutcome {
        if (!outcome.ok) return outcome
        val filtered = Parsers.filterAdult(Parsers.filterRelevant(outcome.items, keyword), adultFilter)
        return outcome.copy(items = filtered)
    }

    /**
     * 只吞「真失败」，不吞取消。
     *
     * `runCatching` 会把 `CancellationException` 一起装进 `Result.failure`，
     * 于是用户切分类 / 退出页面触发的取消，会被当成「这个源失败了」上报，
     * 界面上就会出现一条英文的 `Timed out waiting for ...`。
     * 取消必须原样抛出去让协程正常结束。
     */
    private inline fun <T> catchingIo(block: () -> T): Result<T> =
        try {
            Result.success(block())
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }

    suspend fun detail(source: VodSource, vodId: String): VodDetail {
        if (!vodId.matches(Regex("^[\\w-]+$"))) throw IOException("无效的视频ID")
        val base = source.url.trimEnd('/')
        val api = "$base?ac=videolist&ids=${URLEncoder.encode(vodId, "UTF-8")}"

        catchingIo { net.getTextGated(api) }.getOrNull()?.let { text ->
            catchingIo { Parsers.parseDetail(text) }.getOrNull()
                ?.takeIf { it.episodes.isNotEmpty() }
                ?.let { return it }
        }

        val root = (source.detail ?: originOf(source.url))?.trimEnd('/') ?: throw IOException("获取详情失败")
        val html = net.getTextGated("$root/index.php/vod/detail/id/$vodId.html")
        val pageDetail = Parsers.parseDetailPage(html)
        if (pageDetail.episodes.isEmpty()) throw IOException("未找到播放资源")
        return pageDetail
    }

    /**
     * 按片名反查其它可用源。
     *
     * 从「观看记录」「收藏」进入播放时手里只有一个源，一旦它挂了就无路可走。
     * 这里用片名再搜一轮，把其它源的同名影片补进候选链 —— 只在候选全部
     * 失败后才调用，不影响正常起播速度。与桌面端 discoverCandidates 一致。
     */
    suspend fun discoverCandidates(
        title: String,
        sources: List<VodSource>,
        exclude: Set<String> = emptySet(),
        maxPages: Int = 1,
        timeoutMs: Long = 8_000,
    ): List<PlaybackCandidate> {
        // 搜索词用原片名：采集站是 LIKE '%wd%'，归一化后的 thematrix 匹配不到 The Matrix。
        // 归一化只用于比对结果，不能拿来查询。
        val keyword = title.trim()
        if (keyword.isEmpty() || sources.isEmpty()) return emptyList()

        val outcomes: List<SourceOutcome> = coroutineScope {
            sources.map { source ->
                async { search(source, keyword, maxPages, timeoutMs) }
            }.awaitAll()
        }

        // 比对用的关键字必须和 item.name 走同一套归一化（见 Parsers.sameTitle）：
        // 上面拿原片名去查询是对的，但如果比对时还用原片名，带空格或标点的片名
        // （The Matrix、名侦探柯南：黑铁的鱼影）在三条比较里全落空，
        // 跨源补源等于被关掉。
        val items = outcomes
            .filter { it.ok }
            .flatMap { it.items }
            .filter { item ->
                if ("${item.sourceKey}:${item.vodId}" in exclude) return@filter false
                Parsers.sameTitle(item.name, keyword)
            }
        return PlaybackCandidate.build(items, sources)
    }

    /**
     * 依次尝试候选链，返回第一个能拿到播放地址的结果。
     *
     * onSkip 用来把「某个源失败」反馈到界面；回调异常不影响整体流程。
     */
    suspend fun firstPlayable(candidates: List<PlaybackCandidate>): Pair<PlaybackCandidate, VodDetail>? {
        for (candidate in candidates) {
            // 用 catchingIo 而不是 runCatching：协程被取消时必须原样抛出，
            // 否则会被当成「这个源拿不到详情」继续试下一个，取消完全无效。
            val detail = catchingIo { detail(candidate.source, candidate.vodId) }.getOrNull()
            if (detail != null && detail.episodes.isNotEmpty()) return candidate to detail
        }
        return null
    }

    suspend fun liveChannels(source: LiveSource, adultFilter: Boolean = true): List<LiveChannel> {
        val text = net.getTextGated(source.url, mapOf("Accept" to "application/x-mpegURL, text/plain, */*"))
        val parsed = Parsers.parseM3u(text, source.url)
        if (parsed.isEmpty()) throw IOException("未解析到可用频道")
        // 直播此前完全没有成人过滤：用户自加的 M3U 成人类目会原样露出
        val channels = Parsers.filterAdultChannels(parsed, adultFilter)
        return channels.map { it.copy(sourceKey = source.key, sourceName = source.name) }
    }

    /**
     * 渐进式拉取直播源：边下边解析，每凑一批就回调。
     *
     * 为什么不用 liveChannels：index.m3u 有 2.46MB、服务器限速到 ~35KB/s，
     * 整串读完要 70 秒，而解析只要十几毫秒。边下边显示能把「看到第一个频道」
     * 从 70 秒压到 1 秒左右。
     *
     * @param onBatch 每批已过滤的新频道（调用方自行合并去重）
     * @return 全部频道；中途异常由调用方 runCatching 处理
     */
    suspend fun liveChannelsStream(
        source: LiveSource,
        adultFilter: Boolean = true,
        batchSize: Int = 120,
        onBytes: (Long) -> Unit = {},
        onBatch: suspend (List<LiveChannel>) -> Unit,
    ): List<LiveChannel> {
        val parser = Parsers.M3uLineParser(source.url)
        val all = ArrayList<LiveChannel>()
        var batch = ArrayList<LiveChannel>(batchSize)

        net.forEachLine(
            source.url,
            headers = mapOf("Accept" to "application/x-mpegURL, text/plain, */*"),
            onBytes = onBytes,
        ) { line ->
            val channel = parser.push(line) ?: return@forEachLine true
            if (!adultFilter || !Parsers.isAdultChannel(channel.name, channel.group, channel.tvgId)) {
                val decorated = channel.copy(sourceKey = source.key, sourceName = source.name)
                all += decorated
                batch += decorated
                if (batch.size >= batchSize) {
                    onBatch(batch)
                    batch = ArrayList(batchSize)
                }
            }
            true
        }
        if (batch.isNotEmpty()) onBatch(batch)
        if (all.isEmpty()) throw IOException("未解析到可用频道")
        return all
    }

    /** 分类表缓存（6 小时内复用，切分类不重复打上游）。分类页会并行抓多个源，必须并发安全 */
    private val categoryCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, List<SourceCategory>>>()

    /**
     * 正在拉取的分类表。
     *
     * 首页探测会同时问 8 个分类，而分类表缓存要等响应回来才写入 —— 只靠缓存的话
     * 这 8 个请求会全部落空，同一个 `?ac=list` 被每个源打 8 遍（13 源 = 104 次）。
     * 这里让同一地址的并发调用共用一次请求，后来的等前面的结果。
     */
    private val categoryInflight =
        java.util.concurrent.ConcurrentHashMap<String, CompletableDeferred<List<SourceCategory>>>()

    private suspend fun categoriesOf(source: VodSource): List<SourceCategory> {
        val cached = categoryCache[source.url]
        if (cached != null && System.currentTimeMillis() - cached.first < CATEGORY_TTL_MS) return cached.second

        val running = categoryInflight[source.url]
        if (running != null) {
            return try {
                running.await()
            } catch (err: CancellationException) {
                // 发起方被取消（切分类/离开首页）不代表这张表真的拿不到：
                // 换个协程重新拉一次，而不是把取消传染给等它的人。
                if (!currentCoroutineContext().isActive) throw err
                categoryInflight.remove(source.url, running)
                categoriesOf(source)
            }
        }

        val mine = CompletableDeferred<List<SourceCategory>>()
        if (categoryInflight.putIfAbsent(source.url, mine) != null) {
            // 极短窗口里被别人先占了：退回等待分支
            return categoriesOf(source)
        }
        try {
            val base = source.url.trimEnd('/')
            val categories = Categories.parse(Net.gated(source.url) { net.getText("$base?ac=list&pg=1") })
            categoryCache[source.url] = System.currentTimeMillis() to categories
            mine.complete(categories)
            return categories
        } catch (err: Throwable) {
            mine.completeExceptionally(err)
            throw err
        } finally {
            categoryInflight.remove(source.url, mine)
        }
    }

    /**
     * 按分类浏览：拉分类表 → 找叶子 type_id → 并行抓第一页。
     * 返回 (是否支持该分类, 条目, 说明)。
     *
     * adultFilter 默认开启：与搜索保持一致。「伦理片」名字带「片」会被归入电影桶，
     * 不过滤的话首页分类会直接露出成人内容。
     *
     * [useCache] 为 true 时优先返回落盘缓存（进程重启后依然有效），
     * 只有缓存缺失才打网络。后台刷新走 `useCache = false`。
     */
    suspend fun browseCategory(
        source: VodSource,
        key: CategoryKey,
        // 4 而不是 6：实测 typeLimit=6 要 6577ms / 459 部，=4 只要 3847ms / 300 部，
        // 少抓两个子分类省下近 3 秒，而首屏本来也看不完 460 部。
        typeLimit: Int = 4,
        timeoutMs: Long = 14_000,
        adultFilter: Boolean = true,
        useCache: Boolean = true,
    ): Triple<Boolean, List<SearchItem>, String?> {
        val started = System.currentTimeMillis()
        // 切回上一个分类时如果重新打一遍各源，体感就是「每次切分类都在重新加载播放源」。
        // 缓存 5 分钟：分类内的第一批内容在这个时间尺度上几乎不会变。
        val cacheKey = "${source.key}|$key|$typeLimit|${if (adultFilter) 1 else 0}"
        if (useCache) {
            browseCache[cacheKey]?.let { (at, cached) ->
                if (System.currentTimeMillis() - at < BROWSE_TTL_MS) return cached
            }
        }
        return try {
            val result = withTimeoutOrNull(timeoutMs) {
                val categories = categoriesOf(source)
                val ids = Categories.typeIds(categories, key, typeLimit)
                if (ids.isEmpty()) {
                    // 「源答了，但它没有这个分类」既不是成功也不是失败：算失败会让
                    // 界面上多出一个「N 个源失败」，用户以为网络出问题；算成功又会
                    // 把 supportedSources 抬高。用标记值单独表达，与桌面端
                    // categories.ts 的 ok:true + supported:false 对齐。
                    return@withTimeoutOrNull Triple(false, emptyList(), UNSUPPORTED_NOTE)
                }
                val base = source.url.trimEnd('/')
                // 子分类并行抓取：父分类不聚合子分类内容
                val lists = ids.map { typeId ->
                    async {
                        catchingIo {
                            Parsers.parseSearchList(
                                net.getTextGated("$base?ac=videolist&t=$typeId&pg=1"),
                                source,
                            )
                        }.getOrDefault(emptyList())
                    }
                }.awaitAll()
                val merged = Parsers.filterAdult(lists.flatten().distinctBy { it.vodId }, adultFilter)
                rememberItems(merged)
                Triple(true, merged, null)
            }
            result ?: Triple(false, emptyList(), "请求超时（>${timeoutMs / 1000}s）")
        } catch (err: kotlinx.coroutines.CancellationException) {
            // 取消不能被当成「这个源失败」：否则切分类时界面会冒出一条假错误
            throw err
        } catch (err: Exception) {
            Triple(false, emptyList(), err.message ?: "失败")
        }.also { final ->
            // 只缓存有结论的结果：失败的源下次还要重试，否则会一直显示「失败」
            if (final.first) browseCache[cacheKey] = System.currentTimeMillis() to final
            // 便于日志排查：单源耗时
            System.currentTimeMillis() - started
        }
    }

    /**
     * 从落盘缓存里还原某个分类（跨源合并后的条目）。
     *
     * 返回 null 表示缓存里没有这个分类，调用方应当走网络。
     */
    fun cachedCategoryItems(key: CategoryKey): List<SearchItem>? = cachedCategory(key)


    /** 分类浏览结果缓存：切回上一个分类应当立刻出内容 */
    private val browseCache =
        java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Triple<Boolean, List<SearchItem>, String?>>>()

    private companion object {
        const val BROWSE_TTL_MS = 5 * 60 * 1000L

        /** 分类表缓存时长：分类树很少变，6 小时足够，换源/重启后会重新拉 */
        const val CATEGORY_TTL_MS = 6 * 60 * 60 * 1000L

        /** 首页分类探测的总预算：到点就带已有结论返回，慢源不该拖住首屏 */
        const val PROBE_BUDGET_MS = 15_000L

        /** 「源没有这个分类」的标记：既不计数成功，也不计入失败数 */
        const val UNSUPPORTED_NOTE = "__unsupported__"
    }

    /** 这个源是否只是「没有该分类」，而不是请求失败 */
    fun isUnsupported(note: String?): Boolean = note == UNSUPPORTED_NOTE

    /**
     * 拼音首字母检索。
     *
     * 采集站的 `wd` 只支持中文 LIKE，拼音必然只能在本地做，所以先建索引：
     * 1. 本次会话已经见过的条目（搜索/分类浏览留下的），命中即出，零网络；
     * 2. 再按页码逐层扫每个源的「最新列表」（`?ac=videolist&pg=n`，不带 wd/t
     *    就是全站最新），某个源不满一页就从后续页码里剔除。
     *
     * 总预算见 [PINYIN_BUDGET_MS]，找到 [PINYIN_ENOUGH_HITS] 条就收手。
     */
    suspend fun pinyinSearch(
        sources: List<VodSource>,
        query: String,
        adultFilter: Boolean,
        maxPages: Int = PINYIN_MAX_PAGES,
        budgetMs: Long = PINYIN_BUDGET_MS,
        onProgress: ((pagesScanned: Int, hits: List<SearchItem>) -> Unit)? = null,
    ): List<SearchItem> {
        if (!Pinyin.ready || !Pinyin.isQuery(query)) return emptyList()
        val cached = synchronized(seenLock) { seenItems.values.filter { Pinyin.matches(it.name, query) } }
        // 本地索引命中时先把结果推给界面（零网络、首帧即出），
        // 但不再像以前那样「有 1 条就完全不打网络」——1 条命中就停会漏掉
        // 后面几页的同名续集/不同季；这里继续用一段短预算补全。
        val cachedRanked = rankPinyin(Parsers.filterAdult(cached, adultFilter), query)
        if (cachedRanked.isNotEmpty()) {
            onProgress?.invoke(0, cachedRanked)
            if (cachedRanked.size >= PINYIN_ENOUGH_HITS) return cachedRanked
        }
        val effectiveBudget =
            if (cachedRanked.isEmpty()) budgetMs else minOf(budgetMs, PINYIN_ENRICH_BUDGET_MS)

        // 扫描策略：源内滑动窗口并发 + 扫描专用限流。
        //
        // 为什么不用 gated()：它的 Semaphore(6) 是 FIFO 公平的，启动时的目录刷新
        // 会先排上几十个请求，用户的检索排在队尾；实测（AVD tv35）45 秒都翻不完
        // 第一页。这里改用扫描自己的 Semaphore(PINYIN_CONCURRENCY)，不走全局闸门。
        //
        // 为什么窗口并发：单源串行翻页时每页都要付一次完整 TTFB（实测 ffzyapi
        // 约 2.3s/页），「师兄啊师兄」在第 11 页 → 串行要 26 秒，超预算。
        // 一次并发 [PINYIN_WINDOW] 页后，11 页约 3 轮 ≈ 7 秒。
        val found = java.util.Collections.synchronizedList(ArrayList<SearchItem>())
        val deadline = System.nanoTime() + effectiveBudget * 1_000_000
        val scanGate = Semaphore(PINYIN_CONCURRENCY)
        coroutineScope {
            sources
                .map { source ->
                    async {
                        var next = 1
                        while (next <= maxPages &&
                            found.size < PINYIN_ENOUGH_HITS &&
                            System.nanoTime() < deadline
                        ) {
                            val window = (next until minOf(next + PINYIN_WINDOW, maxPages + 1)).toList()
                            val batches = window
                                .map { page ->
                                    async {
                                        // 这里不能用 runCatching：被取消时它会把
                                        // CancellationException 当普通失败吞掉。
                                        withTimeoutOrNull(PINYIN_PAGE_TIMEOUT_MS) {
                                            scanGate.withPermit {
                                                catchingIo {
                                                    val base = source.url.trimEnd('/')
                                                    val text = net.getText("$base?ac=videolist&pg=$page")
                                                    val parsed = Parsers.parseSearchList(text, source)
                                                    parsed.filter { Pinyin.matches(it.name, query) } to
                                                        (parsed.size < 20)
                                                }.getOrNull()
                                            }
                                        }
                                    }
                                }
                                .awaitAll()
                            var stop = false
                            for (batch in batches) {
                                // 本页超时/失败：这个源放弃，别在它身上继续耗预算
                                if (batch == null) {
                                    stop = true
                                    continue
                                }
                                val (hits, shortPage) = batch
                                if (hits.isNotEmpty()) {
                                    found.addAll(hits)
                                    rememberItems(hits)
                                    // 命中**不**终止本源的翻页：同名的续集/不同季往往分散在
                                    // 后面几页，一命中就停会把结果截成 1-2 条。
                                    // 是否收手交给循环条件里的 found.size >= PINYIN_ENOUGH_HITS。
                                }
                                if (shortPage) stop = true
                            }
                            next += window.size
                            // 每翻完一个窗口回报一次，界面可以显示「已翻到第 N 页」，
                            // 顺带按相关度排好，流式结果不会出现「先来的排前面」。
                            onProgress?.invoke(
                                next - 1,
                                rankPinyin(Parsers.filterAdult(found.toList(), adultFilter), query),
                            )
                            if (stop) break
                        }
                    }
                }
                .awaitAll()
        }

        return rankPinyin(Parsers.filterAdult(found.toList() + cached, adultFilter), query)
    }

    /**
     * 拼音结果排序：精确 > 前缀 > 包含 > 只有多音字备选命中；
     * 同分按片名短、再按字典序，保证同样的查询每次顺序一致。
     */
    private fun rankPinyin(items: List<SearchItem>, query: String): List<SearchItem> =
        items
            .distinctBy { "${it.sourceKey}:${it.vodId}" }
            .sortedWith(
                compareByDescending<SearchItem> { Pinyin.score(it.name, query) }
                    .thenBy { it.name.length }
                    .thenBy { it.name },
            )

    /**
     * 后台预热拼音索引。
     *
     * 拼音检索只能命中「本地已见过的片名」，而索引的来源只有首页分类刷新
     * （每分类一页）和历次搜索结果，覆盖面很窄 —— 按首字母搜什么都可能一条不出，
     * 用户看到的就是「拼音检索坏了」。这里在启动后空闲时把每个源的前
     * [pagesPerSource] 页标题补进索引，并由调用方落盘，之后长期有效。
     *
     * @return 本次新抓到的条目数（0 表示没补到东西）
     */
    suspend fun warmPinyinIndex(
        sources: List<VodSource>,
        pagesPerSource: Int = PINYIN_WARM_PAGES,
        budgetMs: Long = PINYIN_WARM_BUDGET_MS,
    ): Int {
        if (!Pinyin.ready || sources.isEmpty()) return 0
        val collected = java.util.Collections.synchronizedList(ArrayList<SearchItem>())
        val deadline = System.nanoTime() + budgetMs * 1_000_000
        coroutineScope {
            sources
                .map { source ->
                    async {
                        var page = 1
                        while (page <= pagesPerSource && System.nanoTime() < deadline) {
                            val lastPage = withTimeoutOrNull(PINYIN_PAGE_TIMEOUT_MS) {
                                catchingIo {
                                    val base = source.url.trimEnd('/')
                                    val text = net.getTextGated("$base?ac=videolist&pg=$page")
                                    val parsed = Parsers.parseSearchList(text, source)
                                    collected.addAll(parsed)
                                    // 每页都进一次索引：用户中途开口检索会取消预热，
                                    // 只留到最后一并 rememberItems 的话进度全丢。
                                    if (parsed.isNotEmpty()) rememberItems(parsed)
                                    parsed.size < 20
                                }.getOrNull()
                            }
                            if (lastPage == null || lastPage) break
                            page++
                        }
                    }
                }
                .awaitAll()
        }
        if (collected.isEmpty()) return 0
        rememberItems(collected.toList())
        return collected.size
    }


    suspend fun importSubscription(url: String): ParsedSubscription {
        val text = net.getTextGated(url)
        return Subscriptions.parse(text, url)
    }

    /**
     * 探测哪些分类真的有内容（首页只显示有内容的分类入口）。
     *
     * [fast] 默认开启：只看分类表里有没有对应 type_id，不发内容请求。
     * 老做法要 8 个分类 × 每个源各抓一次列表，13 个源实测两分钟级，首页启动时
     * 和用户点进分类抢同一批请求；只看分类表只需要源数那么多次（且有 6 小时缓存）。
     * 代价是「源声明了分类但内容为空」时会高估，那种情况用户点进去看到空页，
     * 比等两分钟好。
     *
     * [budgetMs] 是整轮探测的墙钟上限：到点就带已有结论返回，慢源不拖首屏。
     * 结果按 [CategoryKey.home] 的行程序返回。
     */
    suspend fun probeCategories(
        sources: List<VodSource>,
        adultFilter: Boolean = true,
        typeLimit: Int = 1,
        timeoutMs: Long = 12_000,
        fast: Boolean = true,
        budgetMs: Long = PROBE_BUDGET_MS,
    ): Map<CategoryKey, Int> = coroutineScope {
        if (sources.isEmpty()) return@coroutineScope CategoryKey.home.associateWith { 0 }

        if (fast) {
            val tables: List<List<SourceCategory>?> = withTimeoutOrNull(budgetMs) {
                sources.map { source ->
                    async {
                        // 单源失败/超时只影响它自己：null 表示这张表这次没拿到
                        withTimeoutOrNull(timeoutMs) { runCatching { categoriesOf(source) }.getOrNull() }
                    }
                }.awaitAll()
            } ?: List(sources.size) { null }
            return@coroutineScope CategoryKey.home.associateWith { key ->
                tables.count { table -> table != null && Categories.typeIds(table, key, 1).isNotEmpty() }
            }
        }

        CategoryKey.home.map { key ->
            async {
                var hits = 0
                for (source in sources) {
                    val (ok, list, _) = browseCategory(source, key, typeLimit, timeoutMs, adultFilter)
                    if (ok && list.isNotEmpty()) hits++
                }
                key to hits
            }
        }.awaitAll().toMap()
    }

    private fun originOf(url: String): String? = runCatching {
        val uri = java.net.URI(url)
        "${uri.scheme}://${uri.host}"
    }.getOrNull()
}

