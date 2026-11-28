package org.librextv.tv.data

import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 统一网络层：所有采集站/直播源请求都从这里走，便于注入 UA 与超时 */
object Net {
    const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

    /**
     * 分类浏览的全局并发闸门。
     *
     * 一次分类浏览要打「源数 × 子分类数」个请求，启动预热再叠上来，
     * 峰值能到三十几个并发；采集站的容忍度很低，会直接 503 / 断开，
     * 表现就是「所有源都失败、这个分类一部片子都没有」。
     */
    private val catalogSemaphore = Semaphore(6)

    /** 单个源自己的闸门：一个源内部的请求不要扎堆，否则它最容易把本机 IP 限掉 */
    private val sourceSemaphores = ConcurrentHashMap<String, Semaphore>()

    private fun sourceSemaphore(url: String): Semaphore =
        sourceSemaphores.getOrPut(url) { Semaphore(3) }

    /** 走分类闸门执行一次请求 */
    suspend fun <T> gated(host: String, block: suspend () -> T): T =
        catalogSemaphore.withPermit { sourceSemaphore(host).withPermit { block() } }

    /**
     * 响应体上限。
     *
     * 采集站与 EPG 都可能是任意第三方：没有上限时，一个「返回 500MB JSON」
     * 或「无限 chunked」的地址就能把电视盒子的堆直接吃光（OOM 崩溃，且没有
     * 任何可读的错误信息）。桌面端同类问题已修（M1），电视端此前完全没有。
     */
    private const val MAX_TEXT_BYTES = 8L * 1024 * 1024

    /** 预取分片单片上限：HLS 分片再大也远小于这个值 */
    private const val MAX_MEDIA_BYTES = 32L * 1024 * 1024

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * 播放器专用的 OkHttp 客户端。
     *
     * 和 [client] 分开：播放要多路并发拉分片、且片段大、需要复用连接；
     * 元数据请求走小连接池即可，混在一起会让播放卡在分类请求后面排队。
     */
    val playbackClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * 图片专用客户端：复用 [client] 的连接池，但**换一个 Dispatcher**。
     *
     * 默认 Dispatcher 对同一个 host 只给 5 个并发；图床与采集站同域时，
     * 一屏海报就能把元数据请求全部排队等在图后面。
     */
    private val imageDispatcher = Dispatcher().apply {
        maxRequests = 64
        maxRequestsPerHost = 16
    }

    private val imageHttpClient: OkHttpClient = client.newBuilder()
        .dispatcher(imageDispatcher)
        .build()

    /**
     * 把 OkHttp 的同步 `execute()` 换成可取消的 `enqueue()`。
     *
     * `execute()` 是阻塞调用，`withTimeout`/`cancel` 只能取消协程，已经发出去的
     * 请求仍会占着 IO 线程直到 readTimeout（20 秒）。用户切页面/换分类时就会
     * 堆起一批「没人要了但还在跑」的请求，正好撞上采集站的限流阈值。
     */
    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation {
            runCatching { cancel() }
        }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isCancelled) return
                cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                // 已被取消：直接把响应关掉，否则连接会一直挂在池里
                if (cont.isCancelled) {
                    runCatching { response.close() }
                    return
                }
                cont.resume(response)
            }
        })
    }

    /** 按上限读取响应体：超过就抛错，而不是把内存吃光 */
    private fun ResponseBody.bytesLimited(limit: Long): ByteArray {
        val declared = contentLength()
        if (declared > limit) throw IOException("响应体过大：$declared 字节")
        val source: BufferedSource = source()
        val out = Buffer()
        var total = 0L
        while (true) {
            val read = source.read(out, 64L * 1024)
            if (read == -1L) break
            total += read
            if (total > limit) throw IOException("响应体过大：超过 $limit 字节")
        }
        return out.readByteArray()
    }

    /** 闸门按 host 分组：同一个采集站的请求互相排队，不同站之间并行 */
    private fun hostOf(url: String): String = runCatching {
        java.net.URI(url).let { "${it.scheme}://${it.host}" }
    }.getOrDefault(url)

    /**
     * 读文本（走闸门）。
     *
     * 闸门必须包在**最外层**且不能嵌套：`getText` 自身不加闸，
     * 由这个入口统一申请「全局 + 单源」两层许可。
     * 早先只有分类浏览走 `gated`，搜索/详情/拼音/直播列表全绕过去，
     * 结果是首页刚预热完、用户一搜索又瞬间打出十几个并发，仍然被采集站限流。
     */
    suspend fun getTextGated(url: String, headers: Map<String, String> = emptyMap()): String =
        gated(hostOf(url)) { getText(url, headers) }

    /** 读文本并带回最终地址（走闸门） */
    suspend fun getTextWithUrlGated(
        url: String,
        headers: Map<String, String> = emptyMap()
    ): Pair<String, String> = gated(hostOf(url)) { getTextWithUrl(url, headers) }

    /** 读字节（走闸门） */
    suspend fun getBytesGated(url: String): Pair<ByteArray, String> =
        gated(hostOf(url)) { getBytes(url) }

    suspend fun getText(url: String, headers: Map<String, String> = emptyMap()): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(url).header("User-Agent", UA).header("Accept", "*/*")
            headers.forEach { (k, v) -> builder.header(k, v) }
            client.newCall(builder.build()).await().use { response ->
                if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
                val body = response.body ?: return@use ""
                String(body.bytesLimited(MAX_TEXT_BYTES), Charsets.UTF_8)
            }
        }

    /**
     * 读文本，同时把**最终地址**（跟随重定向之后）带回来。
     *
     * 预取分片时必须用最终地址当相对路径的基准：CDN 常把 m3u8 302 到另一个目录，
     * 用入口地址去拼相对分片会拼到错的路径上，结果是「预取静默抓一堆 404、
     * 播放本身却正常」，几乎不可能靠现象发现。
     */
    suspend fun getTextWithUrl(
        url: String,
        headers: Map<String, String> = emptyMap()
    ): Pair<String, String> = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url).header("User-Agent", UA).header("Accept", "*/*")
        headers.forEach { (k, v) -> builder.header(k, v) }
        client.newCall(builder.build()).await().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body?.let { String(it.bytesLimited(MAX_TEXT_BYTES), Charsets.UTF_8) } ?: ""
            body to response.request.url.toString()
        }
    }

    /**
     * 整块读取字节（预取分片用）。
     *
     * 和 [getText] 分开是因为分片是二进制，走 string 会先按 UTF-8 解码再编码回来，
     * 既浪费一次全量拷贝，也会损坏非 UTF-8 字节。
     */
    suspend fun getBytes(url: String): Pair<ByteArray, String> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Accept", "*/*")
            .header("Accept-Encoding", "identity")
            .build()
        client.newCall(request).await().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body ?: throw IOException("空响应")
            val type = response.header("Content-Type") ?: "video/mp2t"
            body.bytesLimited(MAX_MEDIA_BYTES) to type
        }
    }

    /**
     * 只取响应头里的 ETag（不下载正文）。
     *
     * 用于「远端文件变了没有」的廉价判断：种子表 1.9MB，每次启动都重下太浪费，
     * 而 jsDelivr 的 ETag 是按文件内容算的，内容一变它就变。
     */
    suspend fun headEtag(url: String): String? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .head()
            .build()
        runCatching {
            client.newCall(request).await().use { response ->
                if (!response.isSuccessful) null else response.header("ETag")
            }
        }.getOrNull()
    }

    /** 流式读取（直播/EPG 用），调用方负责关闭 */
    suspend fun stream(url: String): InputStream = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).header("User-Agent", UA).build()
        val response = client.newCall(request).await()
        if (!response.isSuccessful) {
            response.close()
            throw IOException("HTTP ${response.code}")
        }
        response.body?.byteStream() ?: run {
            response.close()
            throw IOException("空响应")
        }
    }

    /**
     * 统计真实读到的字节数。
     *
     * `BufferedReader.readLine()` 只给字符数，拿 `line.length + 1` 当字节用在中英混排
     * （频道名几乎全是中文）时会严重偏小，进度条永远走不满、百分比明显偏低。
     */
    private class CountingInputStream(private val delegate: InputStream) : InputStream() {
        var count: Long = 0L
            private set

        override fun read(): Int {
            val b = delegate.read()
            if (b >= 0) count += 1
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = delegate.read(b, off, len)
            if (n > 0) count += n
            return n
        }

        override fun close() = delegate.close()
        override fun available(): Int = delegate.available()
    }

    /**
     * 逐行流式读取并回调。
     *
     * 为什么不用 getText：iptv-org 的 index.m3u 有 2.46MB，服务器限速到 ~35KB/s，
     * 整串读完要 70 秒以上；解析本身只要十几毫秒。边读边解析，第一个频道约 1 秒
     * 就能上屏，用户不必盯着空列表等一分钟。
     *
     * @param onLine 每读到一行回调一次（已去掉行尾 \r）；返回 false 可提前终止。
     *   允许挂起：渐进解析要在攒够一批时切回主线程刷新列表，若回调是同步的就没法做
     * @param onBytes 已读真实字节数回调（用于进度显示）
     */
    suspend fun forEachLine(
        url: String,
        headers: Map<String, String> = emptyMap(),
        onBytes: (Long) -> Unit = {},
        onLine: suspend (String) -> Boolean,
    ): Long = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url).header("User-Agent", UA).header("Accept", "*/*")
        headers.forEach { (k, v) -> builder.header(k, v) }
        client.newCall(builder.build()).await().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body ?: throw IOException("空响应")
            // 上限按真实字节卡：直播源列表再大也不该超过 8MB
            val declared = body.contentLength()
            if (declared > MAX_TEXT_BYTES) throw IOException("播放列表过大：$declared 字节")
            val counting = CountingInputStream(body.byteStream())
            var lastReport = 0L
            counting.bufferedReader(Charsets.UTF_8).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    val total = counting.count
                    // 每 64KB 报一次，避免进度回调本身成为开销
                    if (total - lastReport >= 64 * 1024) {
                        lastReport = total
                        onBytes(total)
                    }
                    if (total > MAX_TEXT_BYTES) throw IOException("播放列表超过 $MAX_TEXT_BYTES 字节")
                    if (!onLine(line)) break
                }
            }
            val total = counting.count
            onBytes(total)
            total
        }
    }

    /** 给 Coil 用的图片请求：带上 UA/Referer，绕部分图床防盗链 */
    fun imageRequest(url: String): Request =
        Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Referer", runCatching { java.net.URI(url).let { "${it.scheme}://${it.host}/" } }.getOrDefault(""))
            .build()

    /** 图片客户端：独立 Dispatcher，避免海报把元数据请求挤在同一个 host 的并发配额后面 */
    val imageClient: OkHttpClient get() = imageHttpClient
}
