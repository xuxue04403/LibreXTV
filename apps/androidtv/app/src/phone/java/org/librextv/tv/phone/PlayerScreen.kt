package org.librextv.tv.phone

import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
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
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.librextv.tv.AppViewModel
import org.librextv.tv.Screen
import org.librextv.tv.data.AdFilteringPlaylistParserFactory
import org.librextv.tv.data.Playback
import org.librextv.tv.data.SegmentPrefetch
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

private const val SEEK_STEP_MS = 10_000L

/** HLS 播放列表判定：只有 HLS 才有分片可预取 */
private val HLS_URL = Regex("""\.m3u8($|[?#&/])""", RegexOption.IGNORE_CASE)

/**
 * 连续多久「一点进展都没有」才判定卡死并换源（秒）。
 *
 * 判据是「缓冲位置不再前进」，不是「一直 buffering」：快进/拖动时播放器会丢弃
 * 在途分片按新位置重新取数据，buffering 是常态。阈值同时放大到 30 秒。
 */
private const val STALL_SECONDS = 30

/** 手机上没有遥控器，控件显示后静止这么久就自动隐藏，免得挡住画面 */
private const val CONTROLS_HIDE_MS = 4_000L

/**
 * 手机版播放页。
 *
 * 与电视版共用同一套播放内核（[Playback]、[SegmentPrefetch]、候选换源），
 * 区别全在操作方式：电视靠遥控器方向键映射全部操作、屏幕上只有提示文字；
 * 手机靠点击——点画面唤出/收起控件，进度条可拖动，选集走底部浮层。
 *
 * 换源、续播、后台暂停、卡死看门狗这些行为逐条对齐电视版：两边写的是同一份
 * 观看记录，行为不一致会让用户以为"手机版坏了"。
 */
@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(vm: AppViewModel, target: Screen.Player, onExit: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    /** 当前播放目标：换源后指向新源（不是入参 target） */
    var current by remember { mutableStateOf(target) }
    var index by remember {
        mutableIntStateOf(target.startIndex.coerceIn(0, (target.episodes.size - 1).coerceAtLeast(0)))
    }
    val currentIndex by rememberUpdatedState(index)

    var playing by remember { mutableStateOf(true) }
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    var buffering by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var ended by remember { mutableStateOf(false) }
    var failingOver by remember { mutableStateOf(false) }
    /**
     * 换源/重试时要续上的播放位置（毫秒，-1 表示不续）。
     *
     * 换源只换「从哪个站取同一集」，用户看的位置不该丢。之前换源后总是从 0:00
     * 重播，而且 4 秒一次的进度落盘会把 0 附近的位置写进历史，把正确的续播点覆盖掉。
     */
    var resumeAt by remember { mutableStateOf<Pair<Int, Long>?>(null) }
    /** 「重试」按钮的重置计数：参与看门狗键，按下后卡死计数从头算 */
    var retryNonce by remember { mutableIntStateOf(0) }
    var resumedOnce by remember { mutableStateOf(false) }
    var rate by remember { mutableFloatStateOf(1f) }
    var controlsVisible by remember { mutableStateOf(true) }
    var sheetVisible by remember { mutableStateOf(false) }

    /** 拖动进度条时暂停刷新，否则手指还没松开就被播放位置拽回去 */
    var scrubbing by remember { mutableStateOf(false) }
    var scrubValue by remember { mutableFloatStateOf(0f) }

    val tried = remember { mutableStateListOf("${target.source.key}:${target.vodId}") }
    var discovered by remember { mutableStateOf(false) }

    val exo = remember { Playback.build(context) }

    /** 倍速统一入口，换集/换源后由 LaunchedEffect(index) 重新挂一次 */
    fun applyRate(next: Float) {
        rate = next
        runCatching { exo.playbackParameters = PlaybackParameters(next) }
    }

    /**
     * 统一的「放这个地址」入口。
     *
     * HLS 必须显式构造 [HlsMediaSource] 才能挂上 [AdFilteringPlaylistParserFactory]
     * 摘掉播放列表里的中插广告段；并且只能用 `prefetchingDataSourceFactory()`，
     * 用裸工厂会绕开 `Playback.build()` 的配置，预取全失效、每个分片白下两次。
     */
    fun play(url: String) {
        val item = MediaItem.fromUri(url)
        if (HLS_URL.containsMatchIn(url)) {
            val factory = Playback.prefetchingDataSourceFactory()
            val hls = if (vm.data.value.settings.adFilter) {
                HlsMediaSource.Factory(factory).setPlaylistParserFactory(AdFilteringPlaylistParserFactory(true))
            } else {
                HlsMediaSource.Factory(factory)
            }
            exo.setMediaSource(hls.createMediaSource(item))
        } else {
            exo.setMediaItem(item)
        }
        exo.prepare()
    }

    DisposableEffect(Unit) {
        onDispose {
            // 已播完的集不要再写一次，否则会把 finished=true 覆盖成 false
            if (!ended) {
                vm.saveProgress(current, currentIndex, exo.currentPosition.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
            }
            exo.release()
            // 预取缓存是进程级单例，退出播放页就还给系统（手机 heap 同样紧张）
            SegmentPrefetch.clear()
        }
    }

    /** 失败转移：优先用候选链，全部失败后按片名反查补充 */
    val tryFailover: (String, Boolean) -> Unit = { reason, manual ->
        if (!failingOver) {
            failingOver = true
            note = "$reason，正在切换片源…"
            scope.launch {
                // finally 必须写：换源请求在飞行中用户按返回/切后台，协程被取消
                // （failoverPlayback 内部有 8s/12s 的 withTimeoutOrNull，取消点很多），
                // failingOver 不归位的话，此后所有手动换源和错误自动换源都会被
                // 「if (!failingOver)」静默跳过。
                try {
                    val result = vm.failoverPlayback(current, tried.toSet(), currentIndex, discovered)
                    if (result == null) {
                        if (manual) {
                            // 手动换源时画面还在正常播，不能弹整屏错误把正在看的片子判死
                            note = "没有更多可用片源了"
                            error = null
                            delay(2_400)
                            note = null
                        } else {
                            note = null
                            error = "$reason（已尝试全部片源）"
                            buffering = false
                        }
                    } else {
                        tried += result.candidate.key
                        discovered = discovered || result.target.candidates.any { it.key !in target.candidates.map { c -> c.key } }
                        error = null
                        note = "已切换到「${result.candidate.sourceName}」"
                        // 换的是「同一集的另一条线」，用户看的位置必须续上
                        resumeAt = index to exo.currentPosition.coerceAtLeast(0)
                        // 这里不能再调 play()：下面的 LaunchedEffect 会因 current/index 变化重跑，
                        // 两处都调会连续 setMediaSource+prepare 两次，表现为换源后多等一个超时周期
                        current = result.target
                        index = result.episodeIndex
                        delay(2_400)
                        note = null
                    }
                } finally {
                    failingOver = false
                }
            }
        }
    }

    // 退到后台暂停、回前台恢复。守卫用 playWhenReady 而非 isPlaying（缓冲中 isPlaying 为 false）
    var resumeOnStart by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) {
        resumeOnStart = exo.playWhenReady
        exo.pause()
        // 与 onDispose 一致：已播完的集不能再写，否则 finished=true 会被覆盖成 false
        if (!ended) {
            vm.saveProgress(current, currentIndex, exo.currentPosition.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_START) {
        if (resumeOnStart) {
            resumeOnStart = false
            exo.play()
        }
    }

    // 切集 / 首次进入
    LaunchedEffect(current.source.key, current.vodId, index) {
        error = null
        buffering = true
        val url = current.episodes.getOrNull(index) ?: return@LaunchedEffect
        // 先让分片预取跑起来再 prepare：m3u8 要现拉，预取与它并行，
        // 等播放器要点首个分片时它多半已经在内存里了
        if (HLS_URL.containsMatchIn(url)) {
            SegmentPrefetch.start(url, adFilter = vm.data.value.settings.adFilter)
        }
        play(url)
        exo.playWhenReady = true
        if (!resumedOnce) {
            resumedOnce = true
            val hist = vm.data.value.history.firstOrNull { it.id == "${current.source.key}:${current.vodId}" }
            if (vm.data.value.settings.resumePlayback && hist != null && hist.episodeIndex == index && hist.positionMs > 15_000) {
                exo.seekTo(hist.positionMs)
                vm.showToast("已从 ${formatMs(hist.positionMs)} 继续播放")
            }
        }
        // 换源/重试带过来的位置（优先级高于历史续播：用户刚刚正在看这里）。
        // 只在「还是同一集」时续用：中途换了集就按新集从头播。
        val pending = resumeAt
        if (pending != null && pending.first == index) {
            resumeAt = null
            exo.seekTo(pending.second)
        }
    }

    DisposableEffect(exo) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                buffering = playbackState == Player.STATE_BUFFERING || playbackState == Player.STATE_IDLE
                if (playbackState == Player.STATE_ENDED) {
                    ended = true
                    val next = currentIndex + 1
                    val total = exo.duration.coerceAtLeast(0)
                    vm.saveProgress(current, currentIndex, total, total, finished = true)
                    if (vm.data.value.settings.autoplayNext && next < current.episodes.size) {
                        tried.clear()
                        tried += "${current.source.key}:${current.vodId}"
                        discovered = false
                        index = next
                    }
                } else {
                    ended = false
                }
            }

            override fun onPlayerError(playerError: PlaybackException) {
                buffering = false
                error = playerError.errorCodeName + "：" + (playerError.message ?: "播放失败").take(120)
                tryFailover("播放失败", false)
            }
        }
        exo.addListener(listener)
        onDispose { exo.removeListener(listener) }
    }

    // 进度刷新 + 自动保存 + 卡死看门狗
    LaunchedEffect(Unit) {
        var tick = 0
        var stalled = 0
        var lastBuffered = -1L
        var lastPos = -1L
        var stallKey = ""
        while (true) {
            // 换源 / 换集 / 按过「重试」都要把卡死计数清零：上一轮攒下的计数若留着，
            // 新源刚 prepare 的 1~2 秒内就会凑满 30 拍，把用户刚选中的源立刻换走。
            val key = "${current.source.key}:${current.vodId}:$index:$retryNonce"
            if (key != stallKey) {
                stallKey = key
                stalled = 0
                lastBuffered = -1L
                lastPos = -1L
            }
            val pos = exo.currentPosition.coerceAtLeast(0)
            if (!scrubbing) {
                position = pos
                val d = exo.duration
                duration = if (d > 0) d else 0
            }
            tick++
            // 「卡死」= 缓冲中、不在拖动进度条、且缓冲位置和播放位置都不再前进。
            // 旧判据只看 buffering：连续快进时 buffering 是常态，会把能播的源换走。
            // ExoPlayer 没有公开 seeking 状态，用位置跳变判跳转（1 秒最多 2 倍速）。
            // 用 playWhenReady 排除「用户自己暂停 / 退到后台」：那时本来就没有进展。
            val buffered = exo.bufferedPosition
            val delta = if (lastPos < 0) 0L else pos - lastPos
            val jumped = delta > 2_500L || delta < -2_500L
            val progressed = buffered > lastBuffered || delta != 0L
            lastBuffered = buffered
            lastPos = pos
            val frozen = buffering && exo.playWhenReady && !exo.isPlaying && !scrubbing && !jumped && !progressed
            stalled = if (frozen) stalled + 1 else 0
            if (stalled >= STALL_SECONDS && error == null && !failingOver) {
                stalled = 0
                tryFailover("加载超时", false)
            }
            // STATE_ENDED 之后不能再写：那时 position == duration，
            // 每 4 秒写一条 finished=false 会把刚写的 finished=true 覆盖掉
            if (tick % 4 == 0 && position > 0 && !ended) {
                vm.saveProgress(current, currentIndex, position, duration)
            }
            delay(1000)
        }
    }

    // 控件自动隐藏：播着、没开选集浮层、也没报错时才隐藏
    LaunchedEffect(controlsVisible, playing, sheetVisible, error) {
        if (controlsVisible && playing && !sheetVisible && error == null) {
            delay(CONTROLS_HIDE_MS)
            controlsVisible = false
        }
    }

    // 换集后把用户选的倍速重新挂上
    LaunchedEffect(index) {
        runCatching { exo.playbackParameters = PlaybackParameters(rate) }
    }

    // 选集浮层开着时，系统返回键先收浮层，不要直接退出播放页
    BackHandler(enabled = sheetVisible) { sheetVisible = false }

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
                    setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                    keepScreenOn = true
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        if (buffering && error == null) {
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .width(24.dp)
                        .height(24.dp)
                        .background(Accent.copy(alpha = 0.25f), CircleShape),
                )
                Spacer(Modifier.width(10.dp))
                Text("正在缓冲…", color = TextPrimary)
            }
        }

        // 「已切换到 XX」这类纯文本提示：里面没有可点元素，不拦截点击
        note?.let { message ->
            Box(
                Modifier
                    .align(Alignment.Center)
                    .background(Color(0xCC0E1117), RoundedCornerShape(10.dp))
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Text(message, color = Accent)
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
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("播放失败", color = TextPrimary, fontWeight = FontWeight.Bold)
                Text(error ?: "", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                Text(
                    "候选片源 ${current.candidates.size} 个 · 当前「${current.sourceName}」",
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PhoneButton("换源重试", primary = true, onClick = {
                        error = null
                        buffering = true
                        // 候选链耗尽后 tried 是满的，不清掉的话 failoverPlayback
                        // 第一轮就 untried.isEmpty() 返回 null，按钮点了没反应
                        tried.clear()
                        tried += "${current.source.key}:${current.vodId}"
                        discovered = false
                        tryFailover("手动切换", true)
                    })
                    PhoneButton("重试", onClick = {
                        error = null
                        // 位置与卡死计数一起归零，否则「重试」等于从头播 + 立刻再被判死
                        resumeAt = index to exo.currentPosition.coerceAtLeast(0)
                        retryNonce += 1
                        buffering = true
                        exo.prepare()
                        exo.play()
                    })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PhoneButton("下一集", onClick = {
                        if (index + 1 < current.episodes.size) {
                            // 与其它换集入口一致：不重置 tried 的话，新一集第一次出错
                            // 就会因「候选链已耗尽」直接放弃，明明有可用源也不试
                            resumeAt = null
                            tried.clear()
                            tried += "${current.source.key}:${current.vodId}"
                            discovered = false
                            index += 1
                        } else {
                            note = "已经是最后一集"
                        }
                    })
                    PhoneButton("返回", onClick = onExit)
                }
            }
        }

        // 顶部：返回 + 标题
        AnimatedVisibility(
            visible = controlsVisible && error == null,
            modifier = Modifier.align(Alignment.TopStart),
        ) {
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
                    Text(
                        current.title,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        "${current.sourceName} · 第 ${index + 1}/${current.episodes.size} 集" +
                            if (current.candidates.size > 1) " · ${current.candidates.size} 个片源" else "",
                        color = Color(0xFFB7C0CE),
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                    )
                }
            }
        }

        // 底部：进度 + 操作
        AnimatedVisibility(
            visible = controlsVisible && error == null,
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE6000000))))
                    .padding(horizontal = 14.dp, vertical = 12.dp),
            ) {
                val shown = when {
                    scrubbing -> scrubValue
                    duration > 0 -> position.toFloat() / duration
                    else -> 0f
                }
                Slider(
                    value = shown.coerceIn(0f, 1f),
                    onValueChange = { v ->
                        scrubbing = true
                        scrubValue = v
                    },
                    onValueChangeFinished = {
                        if (duration > 0) {
                            // 必须夹到片尾之前：越界会被 ExoPlayer 夹到 duration，
                            // 立刻触发 STATE_ENDED，用户只想拖到结尾却被记成看完并跳下一集
                            val targetMs = (duration * scrubValue).toLong()
                            exo.seekTo(targetMs.coerceAtMost(duration - 1_000L).coerceAtLeast(0L))
                        }
                        scrubbing = false
                    },
                    colors = SliderDefaults.colors(
                        thumbColor = Accent,
                        activeTrackColor = Accent,
                        inactiveTrackColor = Color(0xFF3A4250),
                    ),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        formatMs(if (scrubbing) (duration * scrubValue).toLong() else position),
                        color = TextPrimary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(" / ${formatMs(duration)}", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.weight(1f))
                    Text("${rate}×", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PhoneButton(if (playing) "⏸ 暂停" else "▶ 播放", primary = true, onClick = {
                        if (exo.isPlaying) exo.pause() else exo.play()
                    })
                    PhoneButton("« 10s", onClick = {
                        exo.seekTo((exo.currentPosition - SEEK_STEP_MS).coerceAtLeast(0))
                    })
                    PhoneButton("10s »", onClick = {
                        val limit = exo.duration
                        val target2 = exo.currentPosition + SEEK_STEP_MS
                        exo.seekTo(if (limit > 0) target2.coerceAtMost(limit - 1_000L) else target2)
                    })
                }
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PhoneButton("选集", onClick = { sheetVisible = true })
                    PhoneButton("下一集", onClick = {
                        if (index + 1 < current.episodes.size) {
                            index += 1
                            tried.clear()
                            tried += "${current.source.key}:${current.vodId}"
                            discovered = false
                        } else {
                            note = "已经是最后一集"
                        }
                    })
                    PhoneButton("换源", onClick = { tryFailover("手动切换", true) })
                }
            }
        }

        // 选集 / 倍速浮层
        AnimatedVisibility(
            visible = sheetVisible,
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .background(Color(0xF20E1117), RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp))
                    .padding(horizontal = 14.dp, vertical = 14.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("选集", color = TextPrimary, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.weight(1f))
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .clickable { sheetVisible = false }
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    ) {
                        Text("收起", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("倍速", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                    listOf(1f, 1.25f, 1.5f, 1.75f, 2f).forEach { option ->
                        PhoneChip(
                            text = if (option == 1f) "1×" else "${option}×",
                            active = kotlin.math.abs(rate - option) < 0.01f,
                            onClick = { applyRate(option) },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                LazyVerticalGrid(
                    columns = GridCells.Fixed(4),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    itemsIndexed(current.episodes) { i, _ ->
                        PhoneCard(
                            onClick = {
                                index = i
                                sheetVisible = false
                                tried.clear()
                                tried += "${current.source.key}:${current.vodId}"
                                discovered = false
                            },
                            containerColor = if (i == index) Color(0xFF3A1D12) else Panel,
                            borderColor = if (i == index) Accent else Line,
                        ) {
                            Box(
                                Modifier.fillMaxWidth().height(40.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    "第 ${i + 1} 集",
                                    color = if (i == index) Accent else TextPrimary,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

internal fun formatMs(ms: Long): String {
    if (ms <= 0) return "00:00"
    val total = ms / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}
