package org.librextv.tv.data

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayInputStream
import java.io.File
import java.util.zip.GZIPInputStream

/**
 * 种子表的「在线更新」与「每日增量」。
 *
 * ## 为什么需要
 *
 * 打进 APK 的种子表是**发版快照**：v1.3.15 里那 22 万条片名，是从 12 个采集站
 * 翻完全部分页抓来的，抓完就固定了。之后上新的片（尤其短剧、综艺，一周几十部）
 * 要等下个版本才进表——用户敲新剧的首字母，建议列表是空的。
 *
 * ## 两条路
 *
 * 1. **整表在线更新（OTA）**：仓库里的 `seed-titles.txt.gz` 由 jsDelivr 免费 CDN
 *    直接对外提供（实测 10.7MB/s），启动后先取一个几百字节的版本号文件比对，
 *    有新版本才下那 1.9MB 整表。下完写进 `filesDir`，下次启动直接读，不必重下。
 * 2. **每日增量**：每个已启用源的第 1 页就是「当天新片」（采集站按 `vod_time` 倒序），
 *    12 个源并发拉一页只要 3~6 秒、78KB，合并进内存表即可。
 *
 * 两条都不依赖自建服务器：CDN 是 jsDelivr，增量直接打采集站——和 App 平时搜索用的
 * 是同一批接口，不额外增加谁的负担。
 *
 * ## 为什么默认只在 Wi-Fi 下做
 *
 * 整表 1.9MB。用移动网络替用户花流量不合适，而电视盒子绝大多数常连 Wi-Fi，
 * 加这条限制几乎不影响覆盖率。
 */
object SeedUpdater {
    private const val TAG = "SeedUpdater"

    /** 版本号文件（几百字节），内容第一行是 `yyyyMMdd` 形式的整数 */
    private const val VERSION_URL =
        "https://fastly.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-version.txt"

    /** 整表（gzip，约 1.9MB）。jsDelivr 三个镜像任一可用即可。 */
    private val TABLE_URLS = listOf(
        "https://fastly.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-titles.txt.gz",
        "https://testingcf.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-titles.txt.gz",
        "https://cdn.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-titles.txt.gz",
    )

    private const val VERSION_TIMEOUT_MS = 8_000L
    private const val TABLE_TIMEOUT_MS = 60_000L
    private const val DELTA_TIMEOUT_MS = 10_000L

    /** 每日增量最多合并多少条：正常一天几十条，留足余量但不至于被异常数据灌爆 */
    private const val DELTA_MAX_NAMES = 2_000

    /** 上次整表更新到哪个版本（`yyyyMMdd`） */
    private fun versionFile(context: Context) = File(context.filesDir, "seed-version.txt")

    /**
     * 本地版本号。
     *
     * 用户目录里没有时，退到 APK 里同级的那份 `seed-version.txt`——它在打包时就写好了
     * （见 `tools/pack-seed-index.mjs`），代表「安装包里这份种子表是哪天抓的」。
     * 没有这个基线，全新安装的第一次启动必然判成「远端更新」白下 1.9MB。
     */
    fun localVersion(context: Context): Int {
        val fromFile = runCatching { versionFile(context).readText().trim().toIntOrNull() }.getOrNull()
        if (fromFile != null) return fromFile
        return runCatching {
            context.assets.open("seed-version.txt").bufferedReader(Charsets.UTF_8).use {
                it.readText().trim().toIntOrNull()
            }
        }.getOrNull() ?: 0
    }

    private fun saveVersion(context: Context, version: Int) {
        runCatching { versionFile(context).writeText(version.toString()) }
            .onFailure { Log.w(TAG, "写种子表版本号失败", it) }
    }

    /**
     * 远端整表的 ETag（jsDelivr 按文件内容算，内容一变它就变）。
     *
     * 为什么还需要它：版本号文件是后加的，已经在跑的旧版本客户端、以及
     * 「版本号文件还没来得及提交上去」的那段时间，只能靠 ETag 判断。
     * 两条路任意一条说「有新版」就下——版本号是快路径，ETag 是兜底。
     */
    private fun etagFile(context: Context) = File(context.filesDir, "seed-etag.txt")

    fun localEtag(context: Context): String =
        runCatching { etagFile(context).readText().trim() }.getOrDefault("")

    private fun saveEtag(context: Context, etag: String) {
        runCatching { etagFile(context).writeText(etag) }
            .onFailure { Log.w(TAG, "写种子表 ETag 失败", it) }
    }

    /**
     * 检查并应用整表更新。已在后台线程里跑，调用方 `launch` 即可。
     *
     * 判定顺序：先取版本号（最快、最省），拿不到再退到 ETag 比对（只读响应头，
     * 不下载正文）。两条都失效就跳过，等下次启动。
     *
     * @return 是否真的更新了
     */
    suspend fun updateTableIfNeeded(context: Context, allowCellular: Boolean = false): Boolean {
        if (!allowCellular && !Network.isUnmetered(context)) {
            Log.i(TAG, "当前不是 Wi-Fi，跳过整表更新")
            return false
        }
        val remote = runCatching {
            withTimeout(VERSION_TIMEOUT_MS) {
                Net.getText(VERSION_URL).trim().lineSequence().firstOrNull()?.toIntOrNull()
            }
        }.getOrNull()

        // ETag 顺手取一次：既用于版本号缺失时的兜底判定，也用于更新成功后记账
        val remoteEtag = runCatching { withTimeout(VERSION_TIMEOUT_MS) { Net.headEtag(TABLE_URLS[0]) } }
            .getOrNull()
            .orEmpty()

        if (remote != null) {
            val local = localVersion(context)
            if (remote <= local) {
                Log.i(TAG, "种子表已是最新（本地 $local，远端 $remote）")
                return false
            }
        } else {
            // 版本号文件还没有（或 CDN 抖动）：退到 ETag。只读响应头，成本很低。
            val localEtag = localEtag(context)
            if (remoteEtag.isEmpty() || remoteEtag == localEtag) {
                // 拿不到版本号是常态（CDN 抖动、被墙、仓库还没发新版本），不该报错刷日志
                Log.i(TAG, "取不到远端种子表版本号，跳过")
                return false
            }
        }

        val names = runCatching { downloadTable() }.getOrElse {
            Log.w(TAG, "下载种子表失败", it)
            return false
        }
        if (names.size < 10_000) {
            // 明显不完整的下载不要覆盖本地：宁可继续用旧的
            Log.w(TAG, "下载到的种子表只有 ${names.size} 条，疑似不完整，放弃")
            return false
        }

        // 解析、合并、落盘全部挪到 IO 线程：
        // 22 万条要建 58 万个键，加上写 5MB 明文，在主线程上会卡出明显掉帧
        val added = withContext(Dispatchers.IO) {
            SeedTitles.merge(names).also {
                SeedTitles.cacheForNextLaunch(context, SeedTitles.allNames())
                if (remote != null) saveVersion(context, remote)
                if (remoteEtag.isNotEmpty()) saveEtag(context, remoteEtag)
            }
        }
        Log.i(TAG, "种子表已更新：远端 ${names.size} 条，新增 $added 条，当前 ${SeedTitles.size} 条")
        return true
    }

    private suspend fun downloadTable(): List<String> {
        var lastError: Throwable? = null
        for (url in TABLE_URLS) {
            val result = runCatching {
                val (bytes, _) = withTimeout(TABLE_TIMEOUT_MS) { Net.getBytes(url) }
                // 解压 1.9MB gzip 得到 5MB 文本再切行，同样是 CPU 活，不能在主线程跑
                withContext(Dispatchers.IO) {
                    GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader(Charsets.UTF_8).use {
                        it.readText()
                    }.lineSequence().map { line -> line.trim() }.filter { it.isNotEmpty() }.toList()
                }
            }
            if (result.isSuccess) return result.getOrThrow()
            lastError = result.exceptionOrNull()
            Log.w(TAG, "镜像失败，换下一个：$url", lastError)
        }
        throw lastError ?: IllegalStateException("所有镜像都失败")
    }

    /**
     * 每日增量：各源第 1 页就是当天新片，拉一遍合并进内存表。
     *
     * @return 新增条数
     */
    suspend fun pullDailyDelta(
        context: Context,
        sources: List<VodSource>,
        allowCellular: Boolean = false,
    ): Int {
        if (!allowCellular && !Network.isUnmetered(context)) {
            Log.i(TAG, "当前不是 Wi-Fi，跳过每日增量")
            return 0
        }
        if (sources.isEmpty()) return 0
        val collected = java.util.Collections.synchronizedList(ArrayList<String>())
        coroutineScope {
            sources.forEach { source ->
                launch {
                    runCatching {
                        val base = source.url.trimEnd('/')
                        val text = withTimeout(DELTA_TIMEOUT_MS) {
                            Net.getText("$base?ac=list&pg=1")
                        }
                        Parsers.parseSearchList(text, source)
                            .map { it.name.trim() }
                            .filter { it.isNotEmpty() && it.length <= 60 }
                            .forEach { collected.add(it) }
                    }.onFailure { Log.d(TAG, "增量拉取失败：${source.name}", it) }
                }
            }
        }
        if (collected.isEmpty()) return 0
        val names = collected.distinct().take(DELTA_MAX_NAMES)
        // 合并要重建倒排表、落盘要写 5MB，都在主线程会把界面卡住
        val added = withContext(Dispatchers.IO) {
            SeedTitles.merge(names).also { n ->
                // 增量也落盘：不然下次冷启动又要等 OTA 才能看到这些新片
                if (n > 0) SeedTitles.cacheForNextLaunch(context, SeedTitles.allNames())
            }
        }
        if (added > 0) Log.i(TAG, "每日增量：拉取 ${names.size} 条，新增 $added 条")
        return added
    }

    /** 清掉在线更新版，回落到 APK 内置那份 */
    fun resetToBuiltin(context: Context): Boolean = runCatching {
        File(context.filesDir, "seed-titles.txt").delete()
        versionFile(context).delete()
        true
    }.getOrDefault(false)
}
