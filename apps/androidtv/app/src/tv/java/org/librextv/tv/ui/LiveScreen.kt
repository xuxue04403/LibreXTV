package org.librextv.tv.ui

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.focusable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import coil.request.ImageRequest
import org.librextv.tv.AppViewModel
import org.librextv.tv.Screen
import org.librextv.tv.data.AppData
import org.librextv.tv.data.LiveChannel
import org.librextv.tv.data.Net
import org.librextv.tv.data.Playback
import org.librextv.tv.data.channelAt
import org.librextv.tv.data.indexOfChannel
import org.librextv.tv.data.liveFocusIndex
import org.librextv.tv.data.stepChannelIndex
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.OkGreen
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 换台后多久没出画面就判定「这个台不通」。
 *
 * iptv 列表里死链很常见（返回 HTML 错误页、被地区限制），ExoPlayer 遇到这类
 * 情况既不报错也不进 READY，界面会永远停在「正在连接直播流…」，用户只能靠
 * 盲按换台。设个死线，到点就给结论。
 */
private const val LIVE_START_TIMEOUT_MS = 15_000L

// 注意用的是 kotlin.OptIn：本文件为 media3 的 @UnstableApi 导入了 androidx.annotation.OptIn，
// 它会遮蔽默认导入的 kotlin.OptIn，而 ExperimentalLayoutApi 是 Kotlin 侧 @RequiresOptIn，
// 用 androidx 那个版本不会生效，编译仍会报 "The API of this layout is experimental"。
@kotlin.OptIn(ExperimentalLayoutApi::class)
@Composable
fun LiveScreen(vm: AppViewModel, data: AppData) {
    val live = vm.live
    LaunchedEffect(Unit) {
        if (!live.loading && live.channels.isEmpty()) vm.loadLive()
    }

    val channels = remember(live.channels, live.selectedGroup, live.keyword) {
        live.channels.filter { ch ->
            val groupOk = live.selectedGroup == "全部" || (ch.group ?: "未分组") == live.selectedGroup
            val keywordOk = live.keyword.isBlank() ||
                ch.name.contains(live.keyword, ignoreCase = true) ||
                (ch.group ?: "").contains(live.keyword, ignoreCase = true)
            groupOk && keywordOk
        }
    }

    // 分组计数一次遍历算好：原来是每个分组各 count 一遍（近万频道 × 上百分组 = 每次重组上百万次比较）
    val counts = remember(live.channels, live.groups) {
        val map = HashMap<String, Int>()
        live.channels.forEach { ch ->
            val g = ch.group ?: "未分组"
            map[g] = (map[g] ?: 0) + 1
        }
        map
    }

    // 首焦点：本页原来一个 FocusRequester 都没有，是唯一不认领焦点的主页级页面。
    // 从直播播放页返回时，持有焦点的播放页根 Box 已被移除、Compose 清空焦点，
    // 这里又没人认领，于是第一次按方向键落到整棵树第一个可聚焦项 —— 顶栏的「首页」，
    // 它的 onFocusChange 走「导航焦点即切页」→ 页面直接被切到首页。
    val autoFocus = rememberAutoFocusState(vm.contentFocusTick)
    val gridState = rememberLazyGridState()
    val focusTarget = remember { FocusRequester() }
    // 只为「进入本页这一次」抢焦点：列表随后变化（切分组、列表从空变满）不能再抢，
    // 否则用户刚把焦点移走就会被拽回来。
    var focusClaimed by remember { mutableStateOf(false) }

    // 退出播放页后把焦点还给刚看的那台；没看过（或不在当前分组里）就落在第一台
    val focusIndex = remember(channels, vm.liveFocusUrl) {
        liveFocusIndex(channels, vm.liveFocusUrl)
    }

    LaunchedEffect(channels.isEmpty(), vm.contentFocusTick) {
        if (channels.isEmpty() || focusClaimed) return@LaunchedEffect
        // 焦点还在导航栏里（用户只是把焦点移进本页）时不抢，否则 ↓ 走不到导航第二项
        if (!autoFocus.consume(vm.navFocusHold, vm.contentFocusTick)) return@LaunchedEffect
        // 必须重试：组合第一次跑时目标节点可能还没挂载/还没放置，
        // scrollToItem 与 requestFocus 都会抛（被 runCatching 吞掉后焦点就没人认领）
        repeat(4) { attempt ->
            if (attempt > 0) kotlinx.coroutines.delay(80L)
            runCatching { gridState.scrollToItem(focusIndex) }
            if (runCatching { focusTarget.requestFocus() }.isSuccess) {
                autoFocus.handledTick = vm.contentFocusTick
                focusClaimed = true
                return@LaunchedEffect
            }
        }
    }

    Row(Modifier.fillMaxSize().padding(ScreenPadding)) {
        Column(Modifier.width(226.dp)) {
            SectionHeader("分组", if (live.groups.isEmpty()) "" else "${live.groups.size - 1} 个")
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxSize()) {
                items(live.groups) { group ->
                    val count = if (group == "全部") live.channels.size else counts[group] ?: 0
                    GroupRow(group, count, group == live.selectedGroup) { vm.setLiveGroup(group) }
                }
            }
        }

        Spacer(Modifier.width(20.dp))

        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "直播频道",
                    color = TextPrimary,
                    fontSize = MaterialTheme.typography.headlineMedium.fontSize,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    when {
                        live.channels.isNotEmpty() && live.loading -> "已加载 ${live.channels.size} 个频道，仍在读取…"
                        live.loading -> if (vm.liveBytes > 0) {
                            "正在读取直播源 ${vm.liveBytes / 1024} KB…"
                        } else {
                            "连接直播源…"
                        }
                        live.fromCache -> "${channels.size} / ${live.channels.size} 个频道（缓存）"
                        else -> "${channels.size} / ${live.channels.size} 个频道"
                    },
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.weight(1f))
                TvButton("重新加载", onClick = { vm.loadLive(force = true) })
            }

            if (live.statuses.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                // 用 FlowRow 而不是 Row：每个源一个状态 Chip，源多了（默认 2 个，
                // 用户可加十几个）单行摆不下，Row 会直接把超出的部分裁掉，
                // 表现为「后面几个源的状态永远看不到」。
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    live.statuses.forEach { (name, status) ->
                        Chip("$name · $status", active = status.endsWith("频道"))
                    }
                }
            }

            Spacer(Modifier.height(14.dp))

            if (live.channels.isEmpty() && !live.loading) {
                EmptyState(
                    "没有可用的直播频道",
                    "请在设置里添加 M3U 直播源，或点击「恢复默认源」导入 iptv-org 公开频道列表。",
                ) {
                    TvButton("去设置", onClick = { vm.go(Screen.Settings) })
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(238.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    state = gridState,
                    modifier = Modifier.fillMaxSize(),
                ) {
                    // 首焦点目标：`focusTarget` 只能挂在一个节点上，挂空（列表还没到时）没关系
                    val targetUrl = channels.getOrNull(focusIndex)?.url
                    items(channels, key = { "${it.sourceKey}:${it.url}" }) { channel ->
                        ChannelRow(
                            channel = channel,
                            favorite = data.liveFavorites.any { it.url == channel.url },
                            focusRequester = if (channel.url == targetUrl) focusTarget else null,
                            // 把当前可见列表一并带进播放页：遥控器上下键就在这个列表里循环换台，
                            // 而不是全量频道（用户已选分组/搜过关键词，换到列表外的频道会莫名其妙）
                            onPlay = { vm.go(Screen.LivePlayer(channel, channels)) },
                            onToggleFavorite = { vm.toggleLiveFavorite(channel) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun GroupRow(label: String, count: Int, active: Boolean, onClick: () -> Unit) {    TvCard(
        onClick = onClick,
        containerColor = if (active) org.librextv.tv.ui.theme.Panel2 else Panel,
        shape = RoundedCornerShape(10.dp),
        focusedScale = 1.03f,
    ) { focused ->
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                color = when {
                    focused -> Accent
                    active -> Color(0xFFFFC4B0)
                    else -> TextPrimary
                },
                fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            Text("$count", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }
    }
}

@Composable
private fun ChannelRow(
    channel: LiveChannel,
    favorite: Boolean,
    /** 首焦点目标：只有「刚看的那台」（或第一台）会被挂上 */
    focusRequester: FocusRequester? = null,
    onPlay: () -> Unit,
    onToggleFavorite: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TvCard(
            onClick = onPlay,
            modifier = Modifier.weight(1f),
            focusedScale = 1.03f,
            focusRequester = focusRequester,
        ) { focused ->
            Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(44.dp).background(Color(0xFF0C0F14), RoundedCornerShape(9.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    if (!channel.logo.isNullOrBlank()) {
                        AsyncImage(
                            model = ImageRequest.Builder(LocalContext.current)
                                .data(channel.logo)
                                .addHeader("User-Agent", Net.UA)
                                .build(),
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(40.dp).padding(4.dp),
                        )
                    } else {
                        Text("TV", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    }
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        channel.name,
                        color = if (focused) Accent else TextPrimary,
                        fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                        maxLines = 1,
                    )
                    Text(
                        channel.group ?: "未分组",
                        color = TextMuted,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        maxLines = 1,
                    )
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        TvCard(
            onClick = onToggleFavorite,
            modifier = Modifier.size(46.dp),
            containerColor = Panel,
            focusedScale = 1.06f,
        ) { focused ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (favorite) "★" else "☆",
                    color = if (favorite || focused) Accent else TextMuted,
                    fontSize = MaterialTheme.typography.titleMedium.fontSize,
                )
            }
        }
    }
}

/**
 * 直播播放页：方向键上下换台，OK 暂停/继续。
 *
 * 换台在 `playlist`（进播放页时的可见频道列表）里循环，与桌面端的 ↑/↓ 行为一致。
 * playlist 为空（例如从首页直播收藏直接进来）时上下键不响应——那里没有列表语境。
 */
@OptIn(UnstableApi::class)
@Composable
fun LivePlayerScreen(
    vm: AppViewModel,
    channel: LiveChannel,
    playlist: List<LiveChannel>,
    onExit: () -> Unit,
) {
    val context = LocalContext.current
    var current by remember(channel.url) { mutableStateOf(channel) }
    var error by remember { mutableStateOf<String?>(null) }
    var buffering by remember { mutableStateOf(true) }
    var overlay by remember { mutableStateOf(true) }
    // 信息条每次按键都要重新计时：overlay 已经是 true 时再赋 true 不会重启
    // LaunchedEffect，4 秒的倒计时会按第一次显示的时间走完，用户连按也照样消失。
    var overlayTick by remember { mutableIntStateOf(0) }
    // 「重试」也要重启看门狗：它只依赖 current.url，不改 url 的话重试后
    // 该台仍然空转时就没有第二次兜底了，界面会静默停住。
    var retryTick by remember { mutableIntStateOf(0) }
    var switching by remember { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }
    // 错误面板里的「重试」按钮：面板一出现就把焦点交给它，
    // 否则根 Box 一直持有焦点、方向键被 onPreviewKeyEvent 吃掉，三个按钮永远点不到
    val errorFocus = remember { FocusRequester() }

    val index = indexOfChannel(playlist, current.url)
    val total = playlist.size

    // 播放器整屏复用一个实例，切台只换 MediaItem。
    // 旧写法是 remember(current.url) { Playback.build(...) } + onDispose release，
    // 每换一台就新建一个 ExoPlayer 再销毁一个：连按换台时（每秒 1-2 次）低端盒子
    // 的 codec 申请来不及释放，会出现「切到某台就黑屏/报解码错误」，甚至
    // MediaCodec 池耗尽。复用实例只做 setMediaItem + prepare，开销小得多。
    val exo = remember { Playback.build(context).apply { playWhenReady = true } }

    DisposableEffect(Unit) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                buffering = playbackState == Player.STATE_BUFFERING || playbackState == Player.STATE_IDLE
                if (playbackState == Player.STATE_READY) {
                    switching = false
                    // 已经在放了，之前那条错误就是过期信息（直播流常见「某个分片
                    // 404 报错后自己恢复」），不清掉会让错误面板一直盖着正常画面。
                    error = null
                }
            }

            override fun onPlayerError(playerError: PlaybackException) {
                error = (playerError.message ?: "直播流加载失败").take(120)
                buffering = false
                switching = false
            }
        }
        exo.addListener(listener)
        onDispose {
            exo.removeListener(listener)
            exo.release()
        }
    }

    // 换台：同一个播放器换源
    LaunchedEffect(current.url) {
        // 记下当前这台：退出后列表页据此把焦点还给「刚看的那台」，
        // 而不是退回第一台（换台之后尤其明显）
        vm.rememberLiveChannel(current.url)
        error = null
        buffering = true
        runCatching {
            exo.setMediaItem(MediaItem.fromUri(current.url))
            exo.prepare()
        }.onFailure { error = "无法打开这个频道：${it.message ?: "未知错误"}" }
    }

    // 看门狗：有的台返回的是 HTML 错误页，ExoPlayer 既不报错也不出画面，
    // 界面会永远停在「正在连接直播流…」。超时就直接给结论并允许换台。
    LaunchedEffect(current.url, retryTick) {
        kotlinx.coroutines.delay(LIVE_START_TIMEOUT_MS)
        if (exo.playbackState != Player.STATE_READY && error == null) {
            buffering = false
            switching = false
            error = "这个频道 ${LIVE_START_TIMEOUT_MS / 1000} 秒内没有出画面，可能已下线或被地区限制"
        }
    }

    /**
     * 退到后台就暂停：直播是持续拉流的，不暂停的话按 Home 之后
     * 声音照放、解码器与带宽全占着，低端盒子回来还会掉帧。
     */
    var resumeOnStart by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) {
        resumeOnStart = exo.playWhenReady
        exo.pause()
    }
    LifecycleEventEffect(Lifecycle.Event.ON_START) {
        if (resumeOnStart) {
            resumeOnStart = false
            exo.play()
        }
    }

    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }

    /**
     * 焦点归属随错误面板来回切换。
     *
     * 面板出现时把焦点交给「重试」，根 Box 就不再持有焦点、下面那段
     * onPreviewKeyEvent 也不会再吃掉所有按键；面板消失（重试成功或换台）
     * 时再把焦点还给根 Box，恢复「方向键换台」。
     */
    LaunchedEffect(error != null) {
        if (error != null) {
            // 等一帧让面板的节点先组合出来，否则 requestFocus 会抛
            kotlinx.coroutines.delay(60)
            runCatching { errorFocus.requestFocus() }
        } else {
            runCatching { focusRequester.requestFocus() }
        }
    }

    // 换台闸门兜底：某些流迟迟不到 READY 也不报错，不设死线会让上下键永久失灵
    LaunchedEffect(current.url) {
        if (switching) {
            kotlinx.coroutines.delay(8_000)
            switching = false
        }
    }

    // 信息条 4 秒后自动隐藏：常驻会一直压住画面上沿
    LaunchedEffect(overlay, overlayTick, current.url) {
        if (overlay) {
            kotlinx.coroutines.delay(4_000)
            overlay = false
        }
    }

    // 换台：在可见列表里循环，动画期间忽略重复按键避免连跳
    val switchTo: (Int) -> Unit = { dir ->
        if (!switching && playlist.size > 1) {
            val next = channelAt(playlist, stepChannelIndex(playlist.size, index, if (dir > 0) 1 else -1))
            if (next != null && next.url != current.url) {
                switching = true
                current = next
                overlay = true
            }
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(focusRequester)
            .focusable()
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                // 错误面板可见时把所有按键让给面板里的按钮。
                // 不这么写的话这里对方向键无条件 return true，焦点永远上不到 TvButton，
                // 「重试 / 下一个频道 / 返回」三个按钮在遥控器上就是死的。
                if (error != null) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionCenter, Key.Enter -> {
                        if (exo.isPlaying) exo.pause() else exo.play()
                        overlay = true
                        overlayTick++
                        true
                    }
                    // 上下键换台，左右键做上一台/下一台（遥控器上左右更顺手）
                    Key.DirectionUp, Key.DirectionLeft, Key.ChannelUp -> {
                        switchTo(-1); true
                    }
                    Key.DirectionDown, Key.DirectionRight, Key.ChannelDown -> {
                        switchTo(1); true
                    }
                    Key.MediaNext -> {
                        switchTo(1); true
                    }
                    Key.MediaPrevious -> {
                        switchTo(-1); true
                    }
                    // 返回键交给 Activity 的 BackHandler，避免 KeyDown 消费 + KeyUp 不消费
                    // 导致 BackHandler 再触发一次、一次退两级
                    else -> {
                        overlay = true
                        overlayTick++
                        false
                    }
                }
            },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    player = exo
                    keepScreenOn = true
                }
            },
            modifier = Modifier.fillMaxSize(),
            update = { it.player = exo },
        )

        if (buffering && error == null) {
            Text("正在连接直播流…", color = TextPrimary, modifier = Modifier.align(Alignment.Center))
        }
        if (error != null) {
            Column(Modifier.align(Alignment.Center).width(520.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("直播播放失败", color = TextPrimary, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text(error ?: "", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TvButton("重试", onClick = { error = null; buffering = true; retryTick++; exo.prepare() }, focusRequester = errorFocus)
                    if (playlist.size > 1) {
                        TvButton("下一个频道", onClick = { switchTo(1) })
                    }
                    TvButton("返回", onClick = onExit)
                }
            }
        }

        // 顶部信息条：按键后出现，4 秒无操作淡出，避免长时间遮挡画面
        if (overlay) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color(0xCC000000), Color.Transparent)))
                .padding(horizontal = 34.dp, vertical = 22.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.background(Accent, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp)
            ) {
                Text("LIVE", color = Color(0xFF1A0D07), fontSize = MaterialTheme.typography.bodySmall.fontSize, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(10.dp))
            Column {
                Text(current.name, color = TextPrimary, fontSize = MaterialTheme.typography.titleLarge.fontSize, fontWeight = FontWeight.Bold)
                Text(current.group ?: "未分组", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
            Spacer(Modifier.weight(1f))
            if (total > 1) {
                Text(
                    "${index + 1} / $total",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.width(16.dp))
            }
            Text(
                if (total > 1) "↑↓ 换台 · OK 暂停/继续 · 返回 退出" else "OK 暂停/继续 · 返回 退出",
                color = Color(0xFF9AA4B4),
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            )
        }
        }
    }
}
