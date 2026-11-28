package org.librextv.tv.data

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.File
import kotlin.concurrent.thread

/**
 * 内置的「拼音首字母 → 中文片名」种子表。
 *
 * ## 为什么需要它
 *
 * 采集站只支持 `LIKE '%中文%'`，拼音检索只能在本地做。而 TV 端的本地索引只装得下
 * 「用户扫过的那些页」——实测设备上只有 1209 条，17 个源合计约 150 万条，
 * 覆盖率 0.08%。用户敲 `qmmk` 得到 0 条，就是这个原因。
 *
 * 唯二支持「拼音当 wd」的源（量子 lziapi、暴风 bfzyapi）在大陆直连不通，
 * 指望不上（见 `Repository.REMOTE_PINYIN_MATCHERS`）。
 *
 * ## 做法
 *
 * 把 `tools/gen-seed-index.mjs` 离线抓来的全量片名打进 APK，启动后后台线程解压、
 * 逐条算首字母、建「首字母 → 片名列表」的倒排表常驻内存。
 *
 * 关键洞察：**拼音索引不需要 vodId / sourceKey / 年份**，只要能给出真实中文片名。
 * 用户点一条建议，我们拿这个中文名去各源搜——中文 `wd` 是服务端 LIKE，覆盖全库、
 * 不受分页深度限制。实测《庆余年第一季》(id=4203) 要翻到第 3500 页才出现，
 * 但 `wd=庆余年` 一次就返回全部 8 条。
 *
 * ## 体积与性能
 *
 * 实测 9.9 万条片名：纯文本 1.9 MB，gzip 后约 770 KB（APK 当前 2.8 MB）。
 * 解压 + 建表约 300~600ms（中低端盒子可能到 1.5s），跑在后台线程，不阻塞首屏。
 */
object SeedTitles {
    private const val TAG = "SeedTitles"

    /**
     * assets 里的文件名。
     *
     * 打包时 aapt2 会把 `.gz` 解压成同名无后缀文件，所以仓库里放的是
     * `seed-titles.txt.gz`，装进 APK 后叫 `seed-titles.txt`。这里按后者读。
     */
    private const val SEED_ASSET = "seed-titles.txt"

    /** 「首字母 → 片名」倒排表；同一个首字母串下可能有几百个片名 */
    @Volatile
    private var byInitials: Map<String, List<String>> = emptyMap()

    /** 全部片名，按原顺序（用于「不按首字母、直接包含」的兜底匹配） */
    @Volatile
    private var all: List<String> = emptyList()

    /** 去重用的片名集合，与 [all] 同步维护 */
    @Volatile
    private var nameSet: Set<String> = emptySet()

    @Volatile
    var ready: Boolean = false
        private set

    /** 加载耗时（毫秒），用于设置页显示与日志排查 */
    @Volatile
    var loadMs: Long = 0
        private set

    /** 倒排表里有多个不同的首字母键（诊断用：为 0 说明拼音表没装好） */
    @Volatile
    var keys: Int = 0
        private set

    /**
     * 这批片名是从哪来的：`内置` 表示 APK 资产，`在线更新` 表示覆盖成了 OTA 版本。
     * 只用于设置页展示，用户想知道「我看到的片名有多新」。
     */
    @Volatile
    var origin: String = "内置"
        private set

    val size: Int get() = all.size

    /** 全部片名的快照（在线更新/增量落盘时写文件用） */
    fun allNames(): List<String> = all

    /**
     * 用户目录里缓存的「在线更新版」种子表。
     *
     * APK 里的那份是**发版快照**，新片不会自动进来。启动后如果拉到更新的版本，
     * 就写到这个文件，下次启动优先读它——不然每次冷启动都要重新下 1.9MB。
     */
    private fun cachedFile(context: Context) = File(context.filesDir, "seed-titles.txt")

    /**
     * 后台线程加载种子表。
     *
     * 优先读用户目录里的在线更新版，没有再读 APK 资产。重复调用安全（已加载直接返回）。
     * 文件缺失时保持「未就绪」，搜索退化成只用用户扫过的本地索引——也就是 v1.3.14
     * 的行为，不会崩。
     */
    fun install(context: Context, onLoaded: (() -> Unit)? = null) {
        if (ready) return
        thread(name = "seed-titles-load", isDaemon = true) {
            val started = System.currentTimeMillis()
            val app = context.applicationContext
            val cached = cachedFile(app)
            val fromCache = cached.isFile && cached.length() > 0
            runCatching {
                if (fromCache) {
                    cached.bufferedReader(Charsets.UTF_8).use { loadFrom(it) }
                    origin = "在线更新"
                } else {
                    app.assets.open(SEED_ASSET).bufferedReader(Charsets.UTF_8).use { loadFrom(it) }
                    origin = "内置"
                }
            }
                .onSuccess {
                    loadMs = System.currentTimeMillis() - started
                    ready = true
                    Log.i(TAG, "种子表就绪（$origin）：${size} 个片名 / $keys 个键，耗时 ${loadMs}ms")
                    onLoaded?.invoke()
                }
                .onFailure {
                    if (fromCache) {
                        // 在线更新版可能下了一半就断电，坏文件不能把搜索彻底废掉：
                        // 删掉它，回落到 APK 内置那份。
                        Log.w(TAG, "在线种子表损坏，回落到内置版本", it)
                        runCatching { cached.delete() }
                        runCatching {
                            app.assets.open(SEED_ASSET).bufferedReader(Charsets.UTF_8).use { loadFrom(it) }
                            origin = "内置"
                        }.onSuccess {
                            loadMs = System.currentTimeMillis() - started
                            ready = true
                            onLoaded?.invoke()
                        }.onFailure { e -> Log.e(TAG, "内置种子表也加载失败", e) }
                    } else {
                        // 不静默：这是「拼音搜索有没有东西」的唯一来源，吞掉异常等于让用户
                        // 面对一个永远 0 条的搜索框，却查不到原因。
                        Log.e(TAG, "种子表加载失败", it)
                    }
                }
        }
    }

    private fun loadFrom(reader: BufferedReader) {
        val map = HashMap<String, MutableList<String>>(1 shl 17)
        val plain = ArrayList<String>(240_000)
        val seen = HashSet<String>(240_000)

        var line = reader.readLine()
        while (line != null) {
            val name = line.trim()
            if (name.isNotEmpty() && seen.add(name)) {
                plain.add(name)
                for (key in keysOf(name)) {
                    map.getOrPut(key) { ArrayList(8) }.add(name)
                }
            }
            line = reader.readLine()
        }

        byInitials = map
        all = plain
        nameSet = seen
        keys = map.size
    }

    /**
     * 把每日增量得到的片名并进当前表（去重，已存在的不重复加）。
     *
     * @return 真正新增的条数
     */
    fun merge(names: Collection<String>): Int {
        if (!ready) return 0
        val added = ArrayList<String>()
        val seen = HashSet(nameSet)
        for (raw in names) {
            val name = raw.trim()
            if (name.isEmpty() || !seen.add(name)) continue
            added.add(name)
        }
        if (added.isEmpty()) return 0
        val map = HashMap(byInitials)
        // 倒排表里存的是不可变 List，逐键复制一次代价可控：
        // 单日增量几十条、涉及的键也就几十个。
        for (name in added) {
            for (key in keysOf(name)) {
                val old = map[key]
                map[key] = if (old == null) listOf(name) else old + name
            }
        }
        byInitials = map
        all = all + added
        nameSet = seen
        keys = map.size
        return added.size
    }

    /**
     * 把在线更新下来的整份片名表写进用户目录，供下次启动读取。
     *
     * 先写临时文件再改名：中途断电不会留下半截文件把搜索废掉。
     */
    fun cacheForNextLaunch(context: Context, names: List<String>): Boolean {
        if (names.isEmpty()) return false
        return runCatching {
            val target = cachedFile(context.applicationContext)
            val tmp = File(target.parentFile, "${target.name}.tmp")
            tmp.bufferedWriter(Charsets.UTF_8).use { w ->
                for (name in names) {
                    w.write(name)
                    w.write("\n")
                }
            }
            if (target.exists() && !target.delete()) throw IllegalStateException("删不掉旧种子表")
            if (!tmp.renameTo(target)) throw IllegalStateException("改名失败")
            true
        }.onFailure { Log.w(TAG, "缓存在线种子表失败", it) }.getOrDefault(false)
    }

    /**
     * 一个片名贡献的查询键。
     *
     * 只要**前缀**键：用户敲 `qyn` 想找「庆余年第一季」，敲 `q` 也该看到它。
     * 全长键天然被前缀键覆盖（`qyn` 是 `qynd` 的前缀），所以只存前缀就够，
     * 内存能省一半以上。
     */
    private fun keysOf(name: String): List<String> {
        val initials = Pinyin.initials(name)
        if (initials.length < 2) return emptyList()
        // 太长的片名（30+ 字）只在头 12 个字母上建键，否则单条就能灌几十个键
        val limit = minOf(initials.length, 12)
        return List(limit) { initials.substring(0, it + 1) }
    }

    /**
     * 按首字母前缀取候选片名。
     *
     * @param needle 小写字母串
     * @param limit 最多返回多少条
     */
    fun lookup(needle: String, limit: Int = 200): List<String> {
        if (!ready || needle.isEmpty()) return emptyList()
        val key = needle.lowercase()
        val hits = byInitials[key] ?: return emptyList()
        return if (hits.size <= limit) hits else hits.subList(0, limit)
    }

    /**
     * 兜底：按原始字符串包含匹配（用户直接输中文时走这条）。
     */
    fun containsRaw(word: String, limit: Int = 200): List<String> {
        if (!ready || word.isEmpty()) return emptyList()
        val needle = word.lowercase()
        val out = ArrayList<String>(minOf(limit, 64))
        for (name in all) {
            if (name.lowercase().contains(needle)) {
                out.add(name)
                if (out.size >= limit) break
            }
        }
        return out
    }

    /** 仅供单元测试 */
    @androidx.annotation.VisibleForTesting
    fun installForTest(names: List<String>) {
        val map = HashMap<String, MutableList<String>>()
        val plain = ArrayList<String>(names.size)
        for (name in names) {
            plain.add(name)
            for (key in keysOf(name)) map.getOrPut(key) { ArrayList(4) }.add(name)
        }
        byInitials = map
        all = plain
        nameSet = plain.toHashSet()
        ready = true
        origin = "内置"
    }

    @androidx.annotation.VisibleForTesting
    fun clearForTest() {
        byInitials = emptyMap()
        all = emptyList()
        nameSet = emptySet()
        ready = false
        loadMs = 0
        keys = 0
        origin = "内置"
    }
}
