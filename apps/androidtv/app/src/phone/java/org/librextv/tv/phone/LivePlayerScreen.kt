package org.librextv.tv.phone

import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import org.librextv.tv.AppViewModel
import org.librextv.tv.data.LiveChannel
import org.librextv.tv.data.channelAt
import org.librextv.tv.data.indexOfChannel
import org.librextv.tv.data.stepChannelIndex
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/** 起播看门狗：这么久还没 READY 就提示可能下线 */
private const val LIVE_START_TIMEOUT_MS = 15_000L

/**
 * 手机版直播播放页。
 *
 * 与电视版一致：**整个页面复用一个 ExoPlayer 实例**，切台只 setMediaItem + prepare。
 * 每切一台就新建播放器会耗尽 MediaCodec 池，切十几个台之后整机都放不出画面。
 *
 * 手机上额外的交互是左右滑动切台——用可点击的上/下一台按钮代替手势，
 * 逻辑复用 [stepChannelIndex]，与电视版遥控器上下键走同一条路径。
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
    var controlsVisible by remember { mutableStateOf(true) }
    var overlayVisible by remember { mutableStateOf(false) }
    var retryTick by remember { mutableIntStateOf(0) }
    var switching by remember { mutableStateOf(false) }

    val exo = remember {
        org.librextv.tv.data.Playback.build(context).apply { playWhenReady = true }
    }

    val channels = remember(playlist) { playlist.ifEmpty { listOf(channel) } }
    val index = remember(current.url, channels) { indexOfChannel(channels, current.url).coerceAtLeast(0) }
    val total = channels.size

    DisposableEffect(Unit) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) {
                    switching = false
                    // 成功出画面就把上一次的过期错误清掉，否则用户点重试成功后面板还在
                    error = null
                }
            }

            override fun onPlayerError(playerError: androidx.media3.common.PlaybackException) {
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

    // 切台：只换媒体项，播放器实例不动
    LaunchedEffect(current.url, retryTick) {
        buffering = true
        error = null
        exo.setMediaItem(MediaItem.fromUri(current.url))
        exo.prepare()
    }

    // 起播看门狗：15 秒没出画面就提示可能下线
    LaunchedEffect(current.url, retryTick) {
        delay(LIVE_START_TIMEOUT_MS)
        if (exo.playbackState != Player.STATE_READY && error == null) {
            error = "这个频道 15 秒内没有出画面，可能已下线或被地区限制"
            buffering = false
        }
    }

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

    // 控件自动隐藏
    LaunchedEffect(controlsVisible, overlayVisible, error) {
        if (controlsVisible && !overlayVisible && error == null) {
            delay(3_500)
            controlsVisible = false
        }
    }

    BackHandler(enabled = overlayVisible) { overlayVisible = false }

    fun switchTo(direction: Int) {
        val nextIndex = stepChannelIndex(total, index, direction)
        val channel2 = channelAt(channels, nextIndex) ?: return
        switching = true
        current = channel2
    }

    // 浮层里点某一台要「直接跳过去」。不能复用 switchTo(i - index)：stepChannelIndex
    // 会把 direction 归一成 ±1，点第 5 台只会走到相邻那台。
    fun selectAt(i: Int) {
        val channel2 = channelAt(channels, i) ?: return
        if (channel2.url == current.url) return
        switching = true
        current = channel2
    }

    val interaction = remember { MutableInteractionSource() }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .clickable(interactionSource = interaction, indication = null) {
                controlsVisible = !controlsVisible
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
        )

        if (buffering && error == null) {
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .width(22.dp)
                        .height(22.dp)
                        .background(Accent.copy(alpha = 0.25f), CircleShape),
                )
                Spacer(Modifier.width(10.dp))
                Text("正在连接频道…", color = TextPrimary)
            }
        }

        if (error != null) {
            Column(
                Modifier
                    .align(Alignment.Center)
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp)
                    .background(Color(0xE612161D), RoundedCornerShape(14.dp))
                    .padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("无法播放", color = TextPrimary, fontWeight = FontWeight.Bold)
                Text(error ?: "", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PhoneButton("重试", primary = true, onClick = {
                        error = null
                        buffering = true
                        retryTick++
                    })
                    PhoneButton("下一个频道", onClick = { switchTo(1) })
                    PhoneButton("返回", onClick = onExit)
                }
                if (total > 1) {
                    PhoneButton("打开频道列表", onClick = { overlayVisible = true })
                }
            }
        }

        // 顶部信息条
        if (controlsVisible && error == null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color(0xD9000000), Color.Transparent)))
                    .statusBarsPadding()
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(Color(0x66000000))
                        .clickable(onClick = onExit)
                        .padding(horizontal = 13.dp, vertical = 7.dp),
                ) {
                    Text("‹ 返回", color = TextPrimary)
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(Accent)
                                .padding(horizontal = 5.dp, vertical = 1.dp),
                        ) {
                            Text(
                                "LIVE",
                                color = Color(0xFF1A0D07),
                                style = MaterialTheme.typography.bodySmall,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(
                            current.name,
                            color = TextPrimary,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                        )
                    }
                    Text(
                        listOfNotNull(current.group, current.sourceName.takeIf { it.isNotBlank() })
                            .joinToString(" · ") +
                            if (total > 1) "  ·  ${index + 1}/$total" else "",
                        color = Color(0xFFB7C0CE),
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                    )
                }
            }
        }

        // 底部：切台
        if (controlsVisible && error == null) {
            Row(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE6000000))))
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PhoneButton("‹ 上一台", onClick = { switchTo(-1) })
                PhoneButton("下一台 ›", onClick = { switchTo(1) })
                Spacer(Modifier.weight(1f))
                PhoneButton("频道", onClick = { overlayVisible = true })
                PhoneButton(
                    if (current.url in vm.data.value.liveFavorites.map { it.url }) "已收藏" else "收藏",
                    onClick = { vm.toggleLiveFavorite(current) },
                )
            }
        }

        // 频道浮层
        if (overlayVisible) {
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Color(0xF20E1117), RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp))
                    .padding(horizontal = 14.dp, vertical = 14.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("频道列表", color = TextPrimary, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.weight(1f))
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .clickable { overlayVisible = false }
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    ) {
                        Text("收起", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                    }
                }
                Spacer(Modifier.padding(top = 8.dp))
                androidx.compose.foundation.lazy.LazyColumn(
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(channels.size) { i ->
                        val ch = channels[i]
                        val active = ch.url == current.url
                        PhoneCard(
                            onClick = {
                                selectAt(i)
                                overlayVisible = false
                            },
                            containerColor = if (active) Color(0xFF3A1D12) else androidx.compose.ui.graphics.Color(0xFF10141B),
                            borderColor = if (active) Accent else org.librextv.tv.ui.theme.Line,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    ch.name,
                                    color = if (active) Accent else TextPrimary,
                                    maxLines = 1,
                                    modifier = Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                ch.group?.let {
                                    Text(it, color = TextMuted, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
