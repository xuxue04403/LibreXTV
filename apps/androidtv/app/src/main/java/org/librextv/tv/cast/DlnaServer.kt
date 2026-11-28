package org.librextv.tv.cast

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * 极简 DLNA 接收端（UPnP MediaRenderer / DMR）。
 *
 * 让手机视频 App（优酷、腾讯、B 站、nPlayer 等）的「投屏」列表里出现「LibreXTV 电视」，
 * 选中后把视频地址推给电视播放。只实现投屏真正用到的动作：
 * SetAVTransportURI / Play / Pause / Stop / Seek / GetTransportInfo / GetPositionInfo /
 * GetVolume / SetVolume / GetProtocolInfo 等，其余返回可接受的默认值。
 *
 * 协议栈是自己写的（SSDP 组播发现 + HTTP/SOAP 控制），不依赖已停止维护的 Cling：
 * - SSDP：监听 239.255.255.250:1900 的 M-SEARCH 并单播回应，附带 LOCATION
 * - HTTP：/description.xml 设备描述，/AVTransport/control 等 SOAP 端点
 *
 * 注意：Android TV 需要持有 WifiManager.MulticastLock，否则收不到组播。
 */
class DlnaServer(
    private val context: Context,
    private val onCast: (url: String, title: String) -> Unit,
) {
    companion object {
        private const val TAG = "DlnaServer"
        private const val SSDP_ADDRESS = "239.255.255.250"
        private const val SSDP_PORT = 1900
        private const val DEVICE_TYPE = "urn:schemas-upnp-org:device:MediaRenderer:1"
        private const val UDN = "uuid:6d2f0f5a-1f2b-4f6e-9a1d-0c9b7a5e4d21"
        const val DEVICE_NAME = "LibreXTV 电视"

        private const val AVT_SERVICE = "urn:schemas-upnp-org:service:AVTransport:1"
        private const val RCS_SERVICE = "urn:schemas-upnp-org:service:RenderingControl:1"
        private const val CMS_SERVICE = "urn:schemas-upnp-org:service:ConnectionManager:1"

        /**
         * 请求体上限（**字节**）：SOAP 报文正常几 KB，给 64KB 足够，
         * 防止伪造的 Content-Length 打爆内存。注意是字节而不是字符——
         * 旧实现按字符数读，中文标题会永远读不满而超时（投屏必失败）。
         */
        private const val MAX_BODY_BYTES = 64 * 1024
        private const val MAX_HEADERS = 64
        private const val MAX_CLIENTS = 4
        private const val CLIENT_TIMEOUT_MS = 5_000

        fun start(context: Context, onCast: (url: String, title: String) -> Unit): DlnaServer {
            val server = DlnaServer(context, onCast)
            server.start()
            return server
        }
    }

    @Volatile
    var running: Boolean = false
        private set

    @Volatile
    var address: String = ""
        private set

    private var httpServer: ServerSocket? = null
    private var ssdpSocket: MulticastSocket? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var ssdpThread: Thread? = null
    private var httpThread: Thread? = null

    /** 固定大小线程池：局域网异常连接不应让线程无限增长 */
    private val workerPool: ExecutorService = Executors.newFixedThreadPool(MAX_CLIENTS)

    private var lastCastUrl: String = ""
    private var lastCastTitle: String = ""

    fun start() {
        if (running) return
        val ip = localIpv4()
        if (ip == null) {
            Log.w(TAG, "找不到局域网 IPv4 地址，DLNA 未启动")
            return
        }
        val server = ServerSocket(0).also { httpServer = it }
        val port = server.localPort
        address = "http://$ip:$port/description.xml"

        acquireMulticastLock()

        // SSDP socket 必须在这里同步建好：1900 端口被别的 DLNA（或上次残留）占着时，
        // 建 socket / joinGroup 会抛异常。放在 ssdpLoop 里建、失败只打日志的话，
        // 下面照样 running = true，界面显示「投屏接收已就绪」并给出局域网地址，
        // 但手机端永远搜不到这台设备，用户完全无从判断哪里出了问题。
        val ssdp = runCatching {
            MulticastSocket(SSDP_PORT).apply {
                reuseAddress = true
                joinGroup(InetSocketAddress(InetAddress.getByName(SSDP_ADDRESS), SSDP_PORT), null)
                soTimeout = 0
            }
        }.getOrElse { e ->
            Log.w(TAG, "SSDP 监听启动失败（1900 端口可能被占用）：${e.message}")
            runCatching { server.close() }
            httpServer = null
            multicastLock?.let { if (it.isHeld) it.release() }
            multicastLock = null
            return
        }
        ssdpSocket = ssdp

        httpThread = thread(name = "dlna-http", isDaemon = true) { acceptLoop(server) }
        ssdpThread = thread(name = "dlna-ssdp", isDaemon = true) { ssdpLoop(ssdp, port, ip) }
        running = true
        Log.i(TAG, "DLNA 接收端已启动：$address")
    }

    fun stop() {
        val wasRunning = running
        running = false
        runCatching { httpServer?.close() }
        runCatching { ssdpSocket?.close() }
        // 关闭 socket 后阻塞中的 readLine/receive 会抛异常退出，这里再唤醒一次
        runCatching { ssdpSocket?.close() }
        if (wasRunning) {
            workerPool.shutdownNow()
        }
        multicastLock?.let { if (it.isHeld) it.release() }
        multicastLock = null
        ssdpSocket = null
        httpServer = null
    }

    private fun acquireMulticastLock() {
        runCatching {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifi.createMulticastLock("librextv-dlna").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun acceptLoop(server: ServerSocket) {
        while (running && !server.isClosed) {
            val client = runCatching { server.accept() }.getOrNull() ?: break
            // 固定大小线程池：局域网内异常连接不应让线程无限增长
            runCatching {
                workerPool.execute { handleClient(client) }
            }.onFailure {
                runCatching { client.close() }
            }
        }
    }

    private fun handleClient(client: Socket) {
        client.use { socket ->
            runCatching { socket.soTimeout = CLIENT_TIMEOUT_MS }
            // 头与体必须从同一个字节流顺序读（旧实现用 BufferedReader 读头 + 按
            // Content-Length 读字符，中文标题会让它永远凑不满而超时），解析细节见 DlnaHttp。
            val request = runCatching {
                DlnaHttp.readRequest(
                    input = socket.getInputStream(),
                    maxBodyBytes = MAX_BODY_BYTES,
                    maxHeaders = MAX_HEADERS,
                )
            }.getOrElse {
                Log.w(TAG, "请求解析失败：${it.message}")
                return
            } ?: return

            val response = runCatching {
                route(request.method, request.path, request.body, request.headers)
            }.getOrElse {
                // 路由内部抛异常（畸形 SOAP、越界下标等）不能让这个 worker 线程带着
                // 未捕获异常退出：客户端会一个字节都收不到，只能干等到超时。
                Log.w(TAG, "处理请求失败：${it.message}")
                "500 Internal Server Error" to "internal error"
            }
            runCatching { writeResponse(socket.getOutputStream(), response.first, response.second) }
                .onFailure { Log.w(TAG, "写响应失败：${it.message}") }
        }
    }

    /**
     * 写响应。Content-Length 必须按**字节**算（body.toByteArray），
     * 与请求侧读 body 的口径一致。
     */
    private fun writeResponse(out: OutputStream, status: String, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val header = buildString {
            append("HTTP/1.1 $status\r\n")
            append("Content-Type: text/xml; charset=\"utf-8\"\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("Connection: close\r\n")
            append("Server: Android/UPnP/1.0 LibreXTV/1.0\r\n")
            append("\r\n")
        }
        out.write(header.toByteArray(Charsets.UTF_8))
        out.write(bytes)
        out.flush()
    }

    private fun route(
        method: String,
        path: String,
        body: String,
        headers: Map<String, String>,
    ): Pair<String, String> = when {
        path.startsWith("/description.xml") -> "200 OK" to descriptionXml()
        path.startsWith("/AVTransport/scpd.xml") -> "200 OK" to AVT_SCPD
        path.startsWith("/RenderingControl/scpd.xml") -> "200 OK" to RCS_SCPD
        path.startsWith("/ConnectionManager/scpd.xml") -> "200 OK" to CMS_SCPD
        path.startsWith("/AVTransport/control") ->
            "200 OK" to handleAvTransport(resolveAction(headers, body), body)
        path.startsWith("/RenderingControl/control") ->
            "200 OK" to handleRenderingControl(resolveAction(headers, body), body)
        path.startsWith("/ConnectionManager/control") ->
            "200 OK" to handleConnectionManager(resolveAction(headers, body), body)
        method == "HEAD" -> "200 OK" to ""
        else -> "404 Not Found" to "not found"
    }

    /**
     * 解析 SOAP 动作名。
     *
     * 动作名**不在** body 的某个 `<Action>` 标签里，而是：
     * 1) HTTP 头 `SOAPACTION: "urn:schemas-upnp-org:service:AVTransport:1#Play"`
     * 2) body 中 `<s:Body>` 下的第一个元素，如 `<u:Play xmlns:u="...">`
     *
     * 之前只看 body 里不存在的 `Action` 标签，导致动作恒为空、
     * SetAVTransportURI 永不执行——手机能发现设备但点投屏毫无反应。
     */
    private fun resolveAction(headers: Map<String, String>, body: String): String {
        val fromHeader = headers["soapaction"]
            ?.trim()
            ?.trim('"')
            ?.substringAfterLast('#')
            ?.trim()
        if (!fromHeader.isNullOrEmpty()) return fromHeader

        val bodyTag = Regex("""<(?:[\w-]+:)?Body[^>]*>\s*<([\w-]+:)?([\w]+)""", RegexOption.IGNORE_CASE)
            .find(body)
            ?.groupValues
            ?.getOrNull(2)
        return bodyTag ?: ""
    }

    // —— SOAP 动作实现 ——

    private fun handleAvTransport(action: String, body: String): String {
        val currentUri = extractTag(body, "CurrentURI").orEmpty()
        val metadata = extractTag(body, "CurrentURIMetaData").orEmpty()
        return when (action) {
            "SetAVTransportURI" -> {
                if (currentUri.isNotBlank()) {
                    lastCastUrl = currentUri
                    lastCastTitle = extractTag(metadata, "title") ?: ""
                    onCast(currentUri, lastCastTitle)
                }
                soapResponse(AVT_SERVICE, action, "")
            }
            // 这几个以前是空实现：手机端按暂停/停止/拖动进度条，电视毫无反应，
            // 控制条也永远显示「播放中 00:00:00」。现在都落到 CastRuntime，
            // 由 CastPlayerScreen 注册的 transport 真正作用到 ExoPlayer 上。
            "Stop" -> {
                CastRuntime.stop()
                soapResponse(AVT_SERVICE, action, "")
            }
            "Pause" -> {
                CastRuntime.pause()
                soapResponse(AVT_SERVICE, action, "")
            }
            "Play" -> {
                CastRuntime.play()
                soapResponse(AVT_SERVICE, action, "")
            }
            "Seek" -> {
                DlnaTime.parse(extractTag(body, "Target")).let { if (it >= 0) CastRuntime.seek(it) }
                soapResponse(AVT_SERVICE, action, "")
            }
            // 投屏只承载单个地址，没有播放列表，下一集/上一集无对应语义
            "Next", "Previous", "SetNextAVTransportURI" ->
                soapResponse(AVT_SERVICE, action, "")
            "GetTransportInfo" -> soapResponse(
                AVT_SERVICE,
                action,
                "<InstanceID>0</InstanceID><CurrentTransportState>${CastRuntime.playbackState}</CurrentTransportState>" +
                    "<CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>"
            )
            "GetPositionInfo" -> soapResponse(
                AVT_SERVICE,
                action,
                "<Track>1</Track><TrackDuration>${DlnaTime.format(CastRuntime.durationMs)}</TrackDuration>" +
                    "<TrackMetaData></TrackMetaData>" +
                    "<TrackURI>${xmlEscape(lastCastUrl)}</TrackURI>" +
                    "<RelTime>${DlnaTime.format(CastRuntime.positionMs)}</RelTime>" +
                    "<AbsTime>${DlnaTime.format(CastRuntime.positionMs)}</AbsTime><RelCount>0</RelCount><AbsCount>0</AbsCount>"
            )
            "GetMediaInfo" -> soapResponse(
                AVT_SERVICE,
                action,
                "<NrTracks>0</NrTracks><MediaDuration>00:00:00</MediaDuration><CurrentURI>${xmlEscape(lastCastUrl)}</CurrentURI>" +
                    "<CurrentURIMetaData></CurrentURIMetaData><NextURI></NextURI><NextURIMetaData></NextURIMetaData>" +
                    "<PlayMedium>NETWORK</PlayMedium><RecordMedium>NOT_IMPLEMENTED</RecordMedium><WriteStatus>NOT_IMPLEMENTED</WriteStatus>"
            )
            "GetTransportSettings" -> soapResponse(
                AVT_SERVICE,
                action,
                "<PlayMode>NORMAL</PlayMode><RecQualityMode>NOT_IMPLEMENTED</RecQualityMode>"
            )
            "GetCurrentTransportActions" -> soapResponse(AVT_SERVICE, action, "<Actions>Play,Stop,Pause,Seek</Actions>")
            "GetDeviceCapabilities" -> soapResponse(
                AVT_SERVICE,
                action,
                "<PlayMedia>NETWORK</PlayMedia><RecMedia>NOT_IMPLEMENTED</RecMedia><RecQualityModes>NOT_IMPLEMENTED</RecQualityModes>"
            )
            else -> soapResponse(AVT_SERVICE, action, "")
        }
    }

    private fun handleRenderingControl(action: String, @Suppress("UNUSED_PARAMETER") body: String): String {
        return when (action) {
            "GetVolume" -> soapResponse(
                RCS_SERVICE,
                action,
                "<CurrentVolume>50</CurrentVolume>",
            )
            "SetVolume", "SetMute", "SelectPreset" -> soapResponse(RCS_SERVICE, action, "")
            "GetMute" -> soapResponse(RCS_SERVICE, action, "<CurrentMute>0</CurrentMute>")
            "ListPresets" -> soapResponse(RCS_SERVICE, action, "<CurrentPresetNameList>FactoryDefaults</CurrentPresetNameList>")
            else -> soapResponse(RCS_SERVICE, action, "")
        }
    }

    private fun handleConnectionManager(action: String, @Suppress("UNUSED_PARAMETER") body: String): String {
        return when (action) {
            "GetProtocolInfo" -> soapResponse(
                CMS_SERVICE,
                action,
                "<Source></Source><Sink>http-get:*:video/mp4:*,http-get:*:video/x-matroska:*," +
                    "http-get:*:application/vnd.apple.mpegurl:*,http-get:*:video/mp2t:*,http-get:*:*:*</Sink>"
            )
            "GetCurrentConnectionIDs" -> soapResponse(CMS_SERVICE, action, "<ConnectionIDs>0</ConnectionIDs>")
            "GetCurrentConnectionInfo" -> soapResponse(
                CMS_SERVICE,
                action,
                "<RcsID>0</RcsID><AVTransportID>0</AVTransportID><ProtocolInfo></ProtocolInfo>" +
                    "<PeerConnectionManager></PeerConnectionManager><PeerConnectionID>-1</PeerConnectionID>" +
                    "<Direction>Input</Direction><Status>OK</Status>"
            )
            else -> soapResponse(CMS_SERVICE, action, "")
        }
    }

    /** 响应的 serviceType 必须与实际被调用的服务一致，否则部分控制点会判为非法响应 */
    private fun soapResponse(service: String, action: String, payload: String): String =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
            "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body><u:${action}Response xmlns:u=\"$service\">" +
            payload +
            "</u:${action}Response></s:Body></s:Envelope>"

    // —— SSDP ——

    private fun ssdpLoop(socket: MulticastSocket, port: Int, ip: String) {
        try {
            val buffer = ByteArray(2048)
            while (running) {
                val packet = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(packet)
                } catch (e: Exception) {
                    if (!running) break
                    continue
                }
                val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                if (!text.startsWith("M-SEARCH", ignoreCase = true)) continue
                val st = Regex("""(?im)^ST:\s*(.+)$""").find(text)?.groupValues?.get(1)?.trim() ?: continue
                val targets = listOf(DEVICE_TYPE, "ssdp:all", "upnp:rootdevice", UDN)
                if (targets.none { st.equals(it, ignoreCase = true) || st == "urn:schemas-upnp-org:service:AVTransport:1" }) continue

                val reply = buildString {
                    append("HTTP/1.1 200 OK\r\n")
                    append("CACHE-CONTROL: max-age=1800\r\n")
                    append("EXT:\r\n")
                    append("LOCATION: http://$ip:$port/description.xml\r\n")
                    append("SERVER: Android/8.0 UPnP/1.0 LibreXTV/1.0\r\n")
                    append("ST: $st\r\n")
                    append("USN: $UDN")
                    if (st != UDN) append("::$st")
                    append("\r\n")
                    append("Content-Length: 0\r\n")
                    append("\r\n")
                }.toByteArray(Charsets.UTF_8)
                try {
                    socket.send(DatagramPacket(reply, reply.size, packet.address, packet.port))
                } catch (e: Exception) {
                    Log.w(TAG, "SSDP 回应失败：${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "SSDP 监听失败：${e.message}")
        }
    }

    // —— 设备描述 ——

    private fun descriptionXml(): String {
        val ipPort = address.removePrefix("http://").removeSuffix("/description.xml")
        return """<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>$DEVICE_TYPE</deviceType>
    <friendlyName>$DEVICE_NAME</friendlyName>
    <manufacturer>LibreXTV</manufacturer>
    <manufacturerURL>https://github.com/LibreSpark/LibreTV</manufacturerURL>
    <modelName>LibreXTV TV</modelName>
    <modelNumber>0.1.0</modelNumber>
    <UDN>$UDN</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/AVTransport/control</controlURL>
        <eventSubURL>/AVTransport/event</eventSubURL>
        <SCPDURL>/AVTransport/scpd.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/RenderingControl/control</controlURL>
        <eventSubURL>/RenderingControl/event</eventSubURL>
        <SCPDURL>/RenderingControl/scpd.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <controlURL>/ConnectionManager/control</controlURL>
        <eventSubURL>/ConnectionManager/event</eventSubURL>
        <SCPDURL>/ConnectionManager/scpd.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>"""
    }

    // —— SCPD（服务描述，投屏端会读取接口清单） ——

    private val AVT_SCPD = """<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>SetAVTransportURI</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>CurrentURI</name><direction>in</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
        <argument><name>CurrentURIMetaData</name><direction>in</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>Play</name>
      <argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Speed</name><direction>in</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument></argumentList>
    </action>
    <action><name>Pause</name>
      <argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument></argumentList>
    </action>
    <action><name>Stop</name>
      <argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument></argumentList>
    </action>
    <action><name>Seek</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Unit</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekMode</relatedStateVariable></argument>
        <argument><name>Target</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekTarget</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetTransportInfo</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>CurrentTransportState</name><direction>out</direction><relatedStateVariable>TransportState</relatedStateVariable></argument>
        <argument><name>CurrentTransportStatus</name><direction>out</direction><relatedStateVariable>TransportStatus</relatedStateVariable></argument>
        <argument><name>CurrentSpeed</name><direction>out</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetPositionInfo</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Track</name><direction>out</direction><relatedStateVariable>CurrentTrack</relatedStateVariable></argument>
        <argument><name>TrackDuration</name><direction>out</direction><relatedStateVariable>CurrentTrackDuration</relatedStateVariable></argument>
        <argument><name>TrackMetaData</name><direction>out</direction><relatedStateVariable>CurrentTrackMetaData</relatedStateVariable></argument>
        <argument><name>TrackURI</name><direction>out</direction><relatedStateVariable>CurrentTrackURI</relatedStateVariable></argument>
        <argument><name>RelTime</name><direction>out</direction><relatedStateVariable>RelativeTimePosition</relatedStateVariable></argument>
        <argument><name>AbsTime</name><direction>out</direction><relatedStateVariable>AbsoluteTimePosition</relatedStateVariable></argument>
        <argument><name>RelCount</name><direction>out</direction><relatedStateVariable>RelativeCounterPosition</relatedStateVariable></argument>
        <argument><name>AbsCount</name><direction>out</direction><relatedStateVariable>AbsoluteCounterPosition</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetMediaInfo</name>
      <argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>NrTracks</name><direction>out</direction><relatedStateVariable>NumberOfTracks</relatedStateVariable></argument>
      <argument><name>MediaDuration</name><direction>out</direction><relatedStateVariable>CurrentMediaDuration</relatedStateVariable></argument>
      <argument><name>CurrentURI</name><direction>out</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
      <argument><name>CurrentURIMetaData</name><direction>out</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
      <argument><name>NextURI</name><direction>out</direction><relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>
      <argument><name>NextURIMetaData</name><direction>out</direction><relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>
      <argument><name>PlayMedium</name><direction>out</direction><relatedStateVariable>PlaybackStorageMedium</relatedStateVariable></argument>
      <argument><name>RecordMedium</name><direction>out</direction><relatedStateVariable>RecordStorageMedium</relatedStateVariable></argument>
      <argument><name>WriteStatus</name><direction>out</direction><relatedStateVariable>RecordMediumWriteStatus</relatedStateVariable></argument></argumentList>
    </action>
    <action><name>GetTransportSettings</name>
      <argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>PlayMode</name><direction>out</direction><relatedStateVariable>CurrentPlayMode</relatedStateVariable></argument>
      <argument><name>RecQualityMode</name><direction>out</direction><relatedStateVariable>CurrentRecordQualityMode</relatedStateVariable></argument></argumentList>
    </action>
    <action><name>GetCurrentTransportActions</name>
      <argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Actions</name><direction>out</direction><relatedStateVariable>CurrentTransportActions</relatedStateVariable></argument></argumentList>
    </action>
    <action><name>SetNextAVTransportURI</name>
      <argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>NextURI</name><direction>in</direction><relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>
      <argument><name>NextURIMetaData</name><direction>in</direction><relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument></argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportState</name><dataType>string</dataType>
      <allowedValueList><allowedValue>STOPPED</allowedValue><allowedValue>PLAYING</allowedValue><allowedValue>PAUSED_PLAYBACK</allowedValue></allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>TransportStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportPlaySpeed</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrack</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackDuration</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentMediaDuration</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NumberOfTracks</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PlaybackStorageMedium</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RecordStorageMedium</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RecordMediumWriteStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentPlayMode</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentRecordQualityMode</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTransportActions</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekMode</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekTarget</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>"""

    private val RCS_SCPD = """<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>CurrentVolume</name><direction>out</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>DesiredVolume</name><direction>in</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetMute</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>CurrentMute</name><direction>out</direction><relatedStateVariable>Mute</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetMute</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>DesiredMute</name><direction>in</direction><relatedStateVariable>Mute</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>ListPresets</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>CurrentPresetNameList</name><direction>out</direction><relatedStateVariable>PresetNameList</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Channel</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>Volume</name><dataType>ui2</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>Mute</name><dataType>boolean</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PresetNameList</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>"""

    private val CMS_SCPD = """<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name><argumentList>
      <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
      <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetCurrentConnectionIDs</name><argumentList>
      <argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetCurrentConnectionInfo</name><argumentList>
      <argument><name>ConnectionID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
      <argument><name>RcsID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_RcsID</relatedStateVariable></argument>
      <argument><name>AVTransportID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_AVTransportID</relatedStateVariable></argument>
      <argument><name>ProtocolInfo</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ProtocolInfo</relatedStateVariable></argument>
      <argument><name>PeerConnectionManager</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionManager</relatedStateVariable></argument>
      <argument><name>PeerConnectionID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
      <argument><name>Direction</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Direction</relatedStateVariable></argument>
      <argument><name>Status</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionStatus</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_RcsID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_AVTransportID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionManager</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Direction</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionStatus</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>"""

    // —— 工具 ——

    private fun extractTag(xml: String, tag: String): String? {
        val regex = Regex("<(?:[\\w-]+:)?${Regex.escape(tag)}(?:\\s[^>]*)?>(.*?)</(?:[\\w-]+:)?${Regex.escape(tag)}>", RegexOption.DOT_MATCHES_ALL)
        val raw = regex.find(xml)?.groupValues?.get(1) ?: return null
        return xmlUnescape(raw.trim())
    }

    private fun xmlEscape(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    private fun xmlUnescape(value: String): String = value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")

    private fun localIpv4(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList().asSequence() }
            .filterIsInstance<java.net.Inet4Address>()
            .firstOrNull { it.isSiteLocalAddress }
            ?.hostAddress
    }.getOrNull()
}
