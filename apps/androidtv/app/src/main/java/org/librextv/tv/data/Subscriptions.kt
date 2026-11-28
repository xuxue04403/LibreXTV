package org.librextv.tv.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * 数据源订阅解析：同一入口兼容 LibreTV-SourceList 与 TVBOX 配置。
 * 与桌面端 packages/core/subscriptions.ts 语义一致（跳过 Spider/XML/不可搜索条目）。
 */
object Subscriptions {

    private const val MAX_VOD = 100
    private const val MAX_LIVE = 50
    private val SPIDER = Regex("""^csp_|\.(?:jar|js|py)(?:[?#].*)?$""", RegexOption.IGNORE_CASE)
    // 只有 ./、../ 才是「随订阅文件一起下发的本地文件」。原来的 ^\.{0,2}/ 还会
    // 匹配 "/api.php/provide/vod" 这种同域绝对路径 —— 那些条目本来会在下面
    // 因为不是 http 开头被跳过，但先被这里认成「本地资源」，让跳过原因
    // 完全指错方向（用户看到「跳过 N 条」却找不到原因）。
    private val LOCAL_ASSET = Regex("""^\.{1,2}/""")
    private val CMS_API = Regex("""/api\.php/provide/vod(?![^?#]*/at/xml)(?:[/?#]|$)""", RegexOption.IGNORE_CASE)
    private val M3U = Regex("""\.m3u8?(?:[?#].*)?$""", RegexOption.IGNORE_CASE)

    fun parse(text: String, subscriptionUrl: String?): ParsedSubscription {
        val cleaned = stripTrailingCommas(stripComments(text.removePrefix("\uFEFF")))
        val root = runCatching { LooseJson.parseToJsonElement(cleaned) }
            .getOrElse { throw IllegalArgumentException("订阅内容不是合法的 JSON") }

        val name = subscriptionUrl?.let { runCatching { java.net.URI(it).host }.getOrNull() }
        val prefix = "sub_" + Parsers.stableId(subscriptionUrl ?: cleaned.take(48))

        if (root is JsonArray) {
            val (vod, skipped) = parseVodArray(root, prefix, "array")
            return ParsedSubscription(name, vod, emptyList(), skipped, "array")
        }
        val obj = root as? JsonObject ?: throw IllegalArgumentException("订阅内容格式不正确")

        val isTvbox = obj["sites"] is JsonArray || obj["lives"] is JsonArray
        return if (isTvbox) parseTvbox(obj, prefix, name) else parseLibreXtv(obj, prefix, name)
    }

    private fun parseVodArray(arr: JsonArray, prefix: String, format: String): Pair<List<VodSource>, Int> {
        var skipped = 0
        val seen = HashSet<String>()
        val sources = mutableListOf<VodSource>()
        arr.forEachIndexed { index, element ->
            val obj = element as? JsonObject
            val url = obj?.str("url")?.trim()?.trimEnd('/')
            if (obj == null || url == null || !url.startsWith("http")) {
                skipped++
                return@forEachIndexed
            }
            if (!seen.add(url)) return@forEachIndexed
            if (sources.size >= MAX_VOD) {
                skipped++
                return@forEachIndexed
            }
            sources += VodSource(
                key = "${prefix}_$index",
                name = obj.str("name") ?: url,
                url = url,
                detail = obj.str("detail"),
                isAdult = obj.str("isAdult")?.toBoolean() ?: false,
            )
        }
        return sources to skipped
    }

    private fun parseLibreXtv(obj: JsonObject, prefix: String, hostName: String?): ParsedSubscription {
        val (sources, skippedVod) = parseVodArray(obj["sources"] as? JsonArray ?: JsonArray(emptyList()), prefix, "libretv")
        var skipped = skippedVod
        val seen = HashSet<String>()
        val live = mutableListOf<LiveSource>()
        (obj["liveSources"] as? JsonArray)?.forEachIndexed { index, element ->
            val item = element as? JsonObject
            val url = item?.str("url")?.trim()?.trimEnd('/')
            if (item == null || url == null || !url.startsWith("http")) {
                skipped++
                return@forEachIndexed
            }
            if (!seen.add(url)) return@forEachIndexed
            if (live.size >= MAX_LIVE) {
                skipped++
                return@forEachIndexed
            }
            live += LiveSource("${prefix}_live_$index", item.str("name") ?: url, url, item.str("epg"))
        }
        if (sources.isEmpty() && live.isEmpty()) throw IllegalArgumentException("订阅内容格式不正确")
        return ParsedSubscription(obj.str("name") ?: hostName, sources, live, skipped, "libretv")
    }

    private fun parseTvbox(obj: JsonObject, prefix: String, hostName: String?): ParsedSubscription {
        var skipped = 0
        val seenVod = HashSet<String>()
        val sources = mutableListOf<VodSource>()

        (obj["sites"] as? JsonArray)?.forEach { element ->
            val site = element as? JsonObject ?: return@forEach
            val api = (site.str("api") ?: site.str("url"))?.trim() ?: run { skipped++; return@forEach }
            if (SPIDER.containsMatchIn(api) || LOCAL_ASSET.containsMatchIn(api)) {
                skipped++
                return@forEach
            }
            if (!api.startsWith("http")) {
                skipped++
                return@forEach
            }
            if (site.str("searchable") == "0") {
                skipped++
                return@forEach
            }
            val type = site.str("type")?.toIntOrNull() ?: -1
            val isJsonApi = type == 1 || (type != 3 && CMS_API.containsMatchIn(api))
            if (!isJsonApi) {
                skipped++
                return@forEach
            }
            val url = api.trimEnd('/')
            if (!seenVod.add(url)) return@forEach
            if (sources.size >= MAX_VOD) {
                skipped++
                return@forEach
            }
            sources += VodSource("${prefix}_${sources.size}", site.str("name") ?: url, url)
        }

        val seenLive = HashSet<String>()
        val live = mutableListOf<LiveSource>()
        (obj["lives"] as? JsonArray)?.forEach { element ->
            val item = element as? JsonObject ?: return@forEach
            val url = item.str("url")?.trim()?.trimEnd('/') ?: run { skipped++; return@forEach }
            if (!url.startsWith("http") || !M3U.containsMatchIn(url)) {
                skipped++
                return@forEach
            }
            if (!seenLive.add(url)) return@forEach
            if (live.size >= MAX_LIVE) {
                skipped++
                return@forEach
            }
            live += LiveSource("${prefix}_live_${live.size}", item.str("name") ?: url, url, item.str("epg"))
        }

        if (sources.isEmpty() && live.isEmpty()) throw IllegalArgumentException("订阅内容格式不正确")
        return ParsedSubscription(obj.str("name") ?: hostName, sources, live, skipped, "tvbox")
    }

    // —— 宽容 JSON：剥离注释与尾随逗号（共享配置常见） ——

    private fun stripComments(text: String): String {
        val out = StringBuilder(text.length)
        var inString = false
        var inLine = false
        var inBlock = false
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            val next = if (i + 1 < text.length) text[i + 1] else '\u0000'
            if (inLine) {
                if (ch == '\n' || ch == '\r') {
                    inLine = false
                    out.append(ch)
                }
                i++
                continue
            }
            if (inBlock) {
                if (ch == '*' && next == '/') {
                    inBlock = false
                    i += 2
                    continue
                }
                i++
                continue
            }
            if (inString) {
                out.append(ch)
                if (ch == '\\' && i + 1 < text.length) {
                    out.append(next)
                    i += 2
                    continue
                }
                if (ch == '"') inString = false
                i++
                continue
            }
            if (ch == '"') {
                inString = true
                out.append(ch)
                i++
                continue
            }
            if (ch == '/' && next == '/') {
                inLine = true
                i += 2
                continue
            }
            if (ch == '/' && next == '*') {
                inBlock = true
                i += 2
                continue
            }
            out.append(ch)
            i++
        }
        return out.toString()
    }

    private fun stripTrailingCommas(text: String): String {
        val out = StringBuilder(text.length)
        var inString = false
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            if (inString) {
                out.append(ch)
                if (ch == '\\' && i + 1 < text.length) {
                    out.append(text[i + 1])
                    i += 2
                    continue
                }
                if (ch == '"') inString = false
                i++
                continue
            }
            if (ch == '"') {
                inString = true
                out.append(ch)
                i++
                continue
            }
            if (ch == ',') {
                var j = i + 1
                while (j < text.length && text[j].isWhitespace()) j++
                if (j < text.length && (text[j] == '}' || text[j] == ']')) {
                    i++
                    continue
                }
            }
            out.append(ch)
            i++
        }
        return out.toString()
    }
}

private fun kotlinx.serialization.json.JsonElement?.isNull(): Boolean = this == null || this is JsonNull
