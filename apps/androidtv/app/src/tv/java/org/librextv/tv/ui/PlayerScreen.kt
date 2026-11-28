package org.librextv.tv.ui

import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
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
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

private const val SEEK_STEP_MS = 10_000L

/** 连按两次「下」切下一集的判定窗口；再慢就当成两次单独的按键 */
private const val DOUBLE_DOWN_MS = 700L

/** HLS 播放列表判定：只有 HLS 才有分片可预取 */
private val HLS_URL = Regex("""\.m3u8($|[?#&/])""", RegexOption.IGNORE_CASE)
/**
 * 连续多久「一点进展都没有」才判定卡死并换源（秒）。
 *
 * 判据是「缓冲位置和播放位置都不再前进」，而不是「一直处于 buffering」：
 * 连续快进时 ExoPlayer 会不停丢弃在途分片、按新位置重新取数据，buffering 是常态，
 * 旧实现只要 buffering 满 15 秒就换源，把一个本来能正常播放的源换走了。
 * 阈值也放大到 30 秒——只有真的连续半分钟取不到任何数据，才算这个源不可用。
 */
private const val STALL_SECONDS = 30

/**
 * 播放页：ExoPlayer + 遥控器友好控件。
 *
 * 电视端不做可聚焦按钮条（遥控器在控件间移动很烦），而是把常用操作
 * 全部映射到方向键与 OK 键，屏幕上只显示状态与快捷键提示。
 *
 * 播放失败时按候选链自动换源：电视频道上「这个源挂了」很常见，
 * 让用户按返回、重新搜索、再点一次是很差的体验。
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
    /**
     * 控件显示/隐藏。
     *
     * [controlsTick] 让「每次操作都重新计时」成立：只靠 `controlsVisible` 当 key 的话，
     * 控件本来就可见时再按键不会重启 LaunchedEffect，3.5 秒的隐藏计时照旧走完——
     * 表现为连续快进时控件突然消失。
     */
    var controlsVisible by remember { mutableStateOf(true) }
    var controlsTick by remember { mutableIntStateOf(0) }
    fun showControls() {
        controlsVisible = true
        controlsTick++
    }
    var drawerVisible by remember { mutableStateOf(false) }
    // 连按两次「下」切下一集：电视遥控器上没有专门的「下一集」键，进选集抽屉
    // 再挑太绕。记下上一次按下「下」的时间，窗口内再来一次就切集。
    var lastDownAt by remember { mutableLongStateOf(0L) }
    // 按住不放会连发 KeyDown，靠「有没有收到过 KeyUp」判断这是新的按下还是一次长按
    var downHeld by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var rate by remember { mutableFloatStateOf(1f) }
    var resumedOnce by remember { mutableStateOf(false) }
    var buffering by remember { mutableStateOf(true) }
    /**
     * 当前集是否已播完（STATE_ENDED）。
     *
     * ticker 与 onDispose 都要靠它闭嘴：播完之后 currentPosition == duration，
     * 再写一次进度就会把「已看完」覆盖成「看到片尾」，下次进入直接秒结束。
     */
    var ended by remember { mutableStateOf(false) }
    /** 换源过程中的提示（「正在切换到 XX…」） */
    var note by remember { mutableStateOf<String?>(null) }
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

    /** 已试过且失败的候选；换集时重置，让新一集仍可从当前源开始 */
    val tried = remember { mutableSetOf("${target.source.key}:${target.vodId}") }
    var discovered by remember { mutableStateOf(false) }

    val focusRequester = remember { FocusRequester() }
    /**
     * 每个选集卡片的 FocusRequester。
     *
     * 根 Box 自己是 focusable 的，Compose 的方向键搜索只在「当前焦点节点的兄弟」之间找，
     * 不会进到它的子节点里，所以抽屉弹出来以后左右键根本没东西可移 —— 必须由代码
     * 主动把焦点送进抽屉。同理，收起时要把焦点还给根节点，否则左右键快进/快退会失灵。
     */
    val chipsFocus = remember { mutableMapOf<Int, FocusRequester>() }
    val errorFocus = remember { FocusRequester() }
    val drawerState = rememberLazyListState()
    val exo = remember { Playback.build(context) }

    /**
     * 倍速统一入口。
     *
     * ExoPlayer 的 PlaybackParameters 默认会跨媒体项保留，但换源时我们可能重建播放器
     * （见 tryFailover），所以换集/换源后由 [LaunchedEffect] 统一重新应用一次。
     */
    fun applyRate(next: Float) {
        rate = next
        runCatching { exo.playbackParameters = PlaybackParameters(next) }
        showControls()
    }

    /**
     * 统一的「放这个地址」入口。
     *
     * HLS 走显式的 [HlsMediaSource]（而不是 `MediaItem` + 默认工厂），因为只有这样
     * 才能挂上 [AdFilteringPlaylistParserFactory] 把播放列表里的中插广告段摘掉——
     * Media3 默认解析器原样接受源站列表，广告会照播。
     */
    fun play(url: String) {
        val item = MediaItem.fromUri(url)
        if (HLS_URL.containsMatchIn(url)) {
            // 这里必须用 `prefetchingDataSourceFactory()`，不能是裸的 dataSourceFactory：
            // 手工构造的 HlsMediaSource 自带数据源工厂，会绕开 `Playback.build()` 里
            // `setMediaSourceFactory(...)` 的配置。用错了预取就 100% 失效 —— 分片被
            // 预取进内存，播放器却重新从网上下一遍，等于每个分片白下两次。
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
            // 已经播完的集不要再写一次：此时 currentPosition == duration，
            // 写下去会把 onPlaybackStateChanged 里刚写的 finished=true 覆盖成 false
            if (!ended) {
                vm.saveProgress(current, currentIndex, exo.currentPosition.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
            }
            exo.release()
            // 预取缓存是进程级单例，退出播放页就该还给系统：
            // 电视盒子 heap 常见只有 192MB，留着几十 MB 的 ByteArray 没有收益
            SegmentPrefetch.clear()
        }
    }

    /** 失败转移：优先用候选链，全部失败后按片名反查补充 */
    val tryFailover: (String, Boolean) -> Unit = { reason, manual ->
        if (!failingOver) {
            failingOver = true
            note = "$reason，正在切换片源…"
            scope.launch {
                // finally 必须写：换源在飞行中用户按返回/切集，协程被取消时
                // failingOver 若不归位，此后所有换源都会被「if (!failingOver)」静默跳过
                try {
                    val result = vm.failoverPlayback(current, tried.toSet(), currentIndex, discovered)
                    if (result == null) {
                        if (manual) {
                            // 手动按菜单键只是「想换条线看看」，画面还在正常播：
                            // 不能弹整屏「播放失败」，否则等于把正在看的片子判死，
                            // 而且错误面板会吞掉除返回/重试以外所有按键。
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
                        // 注意：这里**不能**再调 play()。
                        // 下面那个 LaunchedEffect(current.source.key, current.vodId, index)
                        // 会因 current/index 变化而重跑，里面已经 play + playWhenReady。
                        // 两处都调会连续 setMediaSource + prepare 两次：第一次刚拉起的
                        // 清单解析被第二次顶掉，表现为换源后多等一个超时周期、甚至误报错误。
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

    /**
     * 退到后台（按 Home、切输入源、系统弹窗）时暂停。
     *
     * 不暂停的话电视盒子会继续解码：画面在后台不可见，声音照放，
     * 而且 CPU/带宽全占着——回来时还得手动补一次暂停。
     * 这里只处理 ON_STOP（真正的「不在前台」），不用 ON_PAUSE：
     * ON_PAUSE 在系统权限弹窗时也会触发，会让播放无故中断。
     *
     * 守卫**不能**用 `exo.isPlaying`：缓冲中（刚换源/刚换集/弱网）它就是 false，
     * 于是后台继续拉流，缓冲完还会自动出声，而且 ticker 还在跑，卡住 15 秒会在
     * 后台触发自动换源。以 playWhenReady 为准，回前台再按这个标记恢复。
     */
    var resumeOnStart by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) {
        resumeOnStart = exo.playWhenReady
        exo.pause()
        vm.saveProgress(current, currentIndex, exo.currentPosition.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
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
        // 先让预取跑起来，再 prepare：m3u8 要现拉，分片预取与它并行，
        // 等播放器要点首个分片时它多半已经在内存里了。非 HLS 直链没有分片可预取。
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
                    // 连播前把当前集记为「已看完」：位置 = 时长，但下次进入应从头播而不是跳到片尾
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
                val message = playerError.errorCodeName + "：" + (playerError.message ?: "播放失败").take(120)
                error = message
                // 自动换源：这是本次改动的核心，用户不必手动返回重选
                tryFailover("播放失败", false)
            }
        }
        exo.addListener(listener)
        onDispose { exo.removeListener(listener) }
    }

    // 进度与自动保存 + 卡死看门狗
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
            position = pos
            val d = exo.duration
            duration = if (d > 0) d else 0
            tick++
            // 「卡死」= 缓冲中、而且缓冲位置和播放位置都不再前进。
            // 连续快进时 ExoPlayer 会不停丢弃在途分片按新位置重新取数据，buffering
            // 是常态；旧判据只看 buffering，满 15 秒就把一个本来能播的源换走了。
            // media3 的 ExoPlayer 没有公开 seeking 状态，用「位置跳变」判跳转：
            // 1 秒正常推进最多 2 倍速 = 2000ms，超过 2500ms 只能是 seek。
            // 用 playWhenReady 排除「用户自己暂停 / 退到后台」：那时当然没有进展。
            val buffered = exo.bufferedPosition
            val delta = if (lastPos < 0) 0L else pos - lastPos
            val jumped = delta > 2_500L || delta < -2_500L
            val progressed = buffered > lastBuffered || delta != 0L
            lastBuffered = buffered
            lastPos = pos
            val frozen = buffering && exo.playWhenReady && !exo.isPlaying && !jumped && !progressed
            stalled = if (frozen) stalled + 1 else 0
            if (stalled >= STALL_SECONDS && error == null && !failingOver) {
                stalled = 0
                tryFailover("加载超时", false)
            }
            // STATE_ENDED 之后不能再写：那时 currentPosition == duration，
            // 每 4 秒写一条 finished=false、position=duration 的记录会把
            // onPlaybackStateChanged 里刚写的 finished=true 覆盖掉，
            // 下次进入就会按「续播到片尾」直接 seekTo(duration) 秒结束。
            if (tick % 4 == 0 && position > 0 && !ended) {
                vm.saveProgress(current, currentIndex, position, duration)
            }
            delay(1000)
        }
    }

    // 控件自动隐藏（controlsTick 变化即重新计时，见 showControls）
    LaunchedEffect(controlsVisible, controlsTick, playing, drawerVisible) {
        if (controlsVisible && playing && !drawerVisible) {
            delay(3500)
            controlsVisible = false
        }
    }

    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }

    // 换集后把用户选的倍速重新挂上：ExoPlayer 对同一实例通常会保留，但换源重建/重置时不一定
    LaunchedEffect(index) {
        runCatching { exo.playbackParameters = PlaybackParameters(rate) }
    }

    // 抽屉打开：把焦点送到当前集对应的卡片上，用户才能用左右键选其它集
    LaunchedEffect(drawerVisible) {
        if (drawerVisible) {
            runCatching { drawerState.scrollToItem(index.coerceAtLeast(0)) }
            // 等 AnimatedVisibility 展开一帧再请求焦点，否则节点还没进入组合
            delay(90)
            runCatching { chipsFocus.getOrPut(index) { FocusRequester() }.requestFocus() }
        } else {
            runCatching { focusRequester.requestFocus() }
        }
    }

    /**
     * 焦点归属随错误面板来回切换。
     *
     * 旧实现只在 `error != null` 时抢焦点，error 归 null 的四条路径
     * （自动换源成功、切集、换源重试、重试）都不归还——持有焦点的按钮被移出
     * 组合后 Compose 会 clearFocus，根 Box 的 onPreviewKeyEvent 再也收不到键，
     * 遥控器除返回键外全部失灵，只能退出重进。
     */
    LaunchedEffect(error) {
        if (error != null) {
            delay(60)
            runCatching { errorFocus.requestFocus() }
        } else {
            runCatching { focusRequester.requestFocus() }
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(focusRequester)
            .focusable()
            .onPreviewKeyEvent { event ->
                // 松开「下」才算一次按键结束：遥控器按住不放会一直发 KeyDown，
                // 不排掉的话「按住下」会被当成连按，一路跳集。
                if (event.key == Key.DirectionDown && event.type == KeyEventType.KeyUp) {
                    downHeld = false
                    return@onPreviewKeyEvent false
                }
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                // 选集抽屉或错误面板可见时，把方向键/OK 让给里面的卡片，否则它们永远拿不到焦点。
                // 注意不要在这里判 note：note 只是「已切换到 XX」这种纯文本提示，
                // 里面没有任何可聚焦元素，把它算进来会让提示显示的 2.4 秒内所有按键都被吞掉
                //（连暂停、快进、开抽屉都不响应，用户会以为播放器卡死了）。
                if (drawerVisible || error != null) {
                    return@onPreviewKeyEvent when (event.key) {
                        Key.DirectionDown -> {
                            drawerVisible = false
                            true
                        }
                        else -> false
                    }
                }
                when (event.key) {
                    Key.DirectionCenter, Key.Enter, Key.Spacebar -> {
                        if (exo.isPlaying) exo.pause() else exo.play()
                        showControls()
                        true
                    }
                    Key.DirectionLeft -> {
                        exo.seekTo((exo.currentPosition - SEEK_STEP_MS).coerceAtLeast(0))
                        showControls()
                        true
                    }
                    Key.DirectionRight -> {
                        // 必须自己夹到片尾之前：ExoPlayer 会把越界目标夹到 duration，
                        // 于是 STATE_ENDED 立刻触发 —— 用户只想快进看结尾，
                        // 却被记成「看完」并（开了自动连播时）直接跳下一集。
                        val limit = exo.duration
                        val target = exo.currentPosition + SEEK_STEP_MS
                        exo.seekTo(if (limit > 0) target.coerceAtMost(limit - 1_000L) else target)
                        showControls()
                        true
                    }
                    Key.DirectionUp -> {
                        drawerVisible = true
                        showControls()
                        true
                    }
                    // 「下」单击只是把控制条叫出来；连按两次切下一集。
                    // 遥控器按住不放会连发 KeyDown（repeatCount > 0），那不是「又按了一次」，
                    // 不排掉的话按住「下」会一路跳集。
                    Key.DirectionDown -> {
                        val now = System.currentTimeMillis()
                        // KeyUp 正常都会来，但焦点被抽屉/错误面板抢走时可能落空；
                        // 一旦漏掉一次，downHeld 就永远是 true，↓↓ 切集会整场失效。
                        // 隔得过久就当这次是新的按下，给它一条自愈路径。
                        if (now - lastDownAt > DOUBLE_DOWN_MS * 3) downHeld = false
                        val fresh = !downHeld
                        downHeld = true
                        if (fresh && lastDownAt > 0 && now - lastDownAt <= DOUBLE_DOWN_MS) {
                            lastDownAt = 0L
                            if (index + 1 < current.episodes.size) {
                                index += 1
                            } else {
                                note = "已经是最后一集"
                                showControls()
                            }
                        } else {
                            if (fresh) lastDownAt = now
                            showControls()
                        }
                        true
                    }
                    Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause -> {
                        if (exo.isPlaying) exo.pause() else exo.play()
                        // 与 OK 键一致：不呼出控件的话，用遥控器的播放/暂停键操作时
                        // 既看不到「已暂停」也看不到进度，控制条还按旧计时直接消失。
                        showControls()
                        true
                    }
                    Key.MediaNext -> {
                        if (index + 1 < current.episodes.size) {
                            index += 1
                            // 与抽屉里的「下一集」保持一致：换集必须清掉上一集的 tried
                            // 集合，否则新集首次出错时 failoverPlayback 会以为「片源都试过了」，
                            // 直接放弃自动换源。
                            tried.clear()
                            tried += "${current.source.key}:${current.vodId}"
                            discovered = false
                        }
                        true
                    }
                    Key.MediaPrevious -> {
                        if (index > 0) {
                            index -= 1
                            tried.clear()
                            tried += "${current.source.key}:${current.vodId}"
                            discovered = false
                        }
                        true
                    }
                    // 菜单键：手动换源（自动换源失败后的兜底，也给想主动换线的用户）
                    Key.Menu -> {
                        tryFailover("手动切换", true)
                        true
                    }
                    // 返回键不在这里消费：交给 Activity 的 BackHandler 统一处理，
                    // 否则 KeyDown 消费 + KeyUp 不消费会让 BackHandler 再触发一次，一次退两级
                    else -> false
                }
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
            Row(
                Modifier.align(Alignment.Center),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .width(26.dp)
                        .height(26.dp)
                        .background(Accent.copy(alpha = 0.25f), androidx.compose.foundation.shape.CircleShape)
                )
                Spacer(Modifier.width(12.dp))
                Text("正在缓冲…", color = TextPrimary, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
            }
        }

        if (note != null) {
            Box(
                Modifier
                    .align(Alignment.Center)
                    .background(Color(0xCC0E1117), androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
                    .padding(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Text(note ?: "", color = Accent, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
            }
        }

        if (error != null) {
            Column(
                Modifier
                    .align(Alignment.Center)
                    .width(560.dp)
                    .background(Color(0xE612161D), androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("播放失败", color = TextPrimary, fontSize = MaterialTheme.typography.titleMedium.fontSize, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text(error ?: "", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                Spacer(Modifier.height(6.dp))
                Text(
                    "候选片源 ${current.candidates.size} 个 · 当前「${current.sourceName}」",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TvButton("换源重试", focusRequester = errorFocus, onClick = {
                        error = null
                        buffering = true
                        // 候选链耗尽后 tried 已经是满的，不重置的话 failoverPlayback
                        // 第一轮就 untried.isEmpty() 直接返回 null —— 按钮点了没反应。
                        // 「重试」的语义就是把除当前源以外的记录清掉，重新从候选链开头找。
                        tried.clear()
                        tried += "${current.source.key}:${current.vodId}"
                        discovered = false
                        tryFailover("手动切换", true)
                    })
                    TvButton("重试", onClick = {
                        error = null
                        // 位置与卡死计数一起归零，否则「重试」等于从头播 + 立刻再被判死
                        resumeAt = index to exo.currentPosition.coerceAtLeast(0)
                        retryNonce += 1
                        buffering = true
                        exo.prepare()
                        exo.play()
                    })
                    TvButton("下一集", onClick = {
                        if (index + 1 < current.episodes.size) {
                            // 与其它换集入口保持一致：不重置 tried 的话，新一集第一次出错
                            // 就会因「候选链已耗尽」直接放弃，明明有可用源也不试
                            tried.clear()
                            tried += "${current.source.key}:${current.vodId}"
                            discovered = false
                            index += 1
                        } else {
                            // 末集点了毫无反馈，用户会以为按钮坏了
                            note = "已经是最后一集"
                        }
                    })
                    TvButton("返回", onClick = onExit)
                }
            }
        }

        AnimatedVisibility(visible = controlsVisible, modifier = Modifier.align(Alignment.TopStart)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color(0xD9000000), Color.Transparent)))
                    .padding(horizontal = 34.dp, vertical = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        current.title,
                        color = TextPrimary,
                        fontSize = MaterialTheme.typography.headlineMedium.fontSize,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "${current.sourceName} · 第 ${index + 1} 集 · 共 ${current.episodes.size} 集" +
                            if (current.candidates.size > 1) " · ${current.candidates.size} 个片源" else "",
                        color = Color(0xFFB7C0CE),
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    "OK 播放/暂停   ←→ 快退/快进 10s   ↑ 选集/倍速   ↓↓ 下一集   菜单 换源   返回 退出",
                    color = Color(0xFF9AA4B4),
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
            }
        }

        AnimatedVisibility(visible = controlsVisible, modifier = Modifier.align(Alignment.BottomStart)) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE6000000))))
                    .padding(horizontal = 34.dp, vertical = 22.dp),
            ) {
                val progress = if (duration > 0) position.toFloat() / duration else 0f
                ProgressBar(progress, Modifier.fillMaxWidth())
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(formatMs(position), color = TextPrimary, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    Text(" / ${formatMs(duration)}", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    Spacer(Modifier.width(18.dp))
                    Text(if (playing) "播放中" else "已暂停", color = if (playing) Accent else TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    Spacer(Modifier.weight(1f))
                    Text("${rate}×", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                }
            }
        }

        AnimatedVisibility(visible = drawerVisible, modifier = Modifier.align(Alignment.BottomStart)) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Color(0xF20E1117))
                    .padding(horizontal = 34.dp, vertical = 18.dp),
            ) {
                Text("选集 / 倍速（↑ 打开 / ↓ 收起）", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("倍速", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    listOf(1f, 1.25f, 1.5f, 1.75f, 2f).forEach { option ->
                        EpisodeChip(
                            label = if (option == 1f) "1×" else "${option}×",
                            selected = kotlin.math.abs(rate - option) < 0.01f,
                            onClick = { applyRate(option) },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("跳集", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    EpisodeChip(
                        label = "上一集",
                        selected = false,
                        onClick = {
                            if (index > 0) {
                                index -= 1
                                drawerVisible = false
                                tried.clear()
                                tried += "${current.source.key}:${current.vodId}"
                                discovered = false
                            } else {
                                note = "已经是第一集"
                            }
                        },
                    )
                    EpisodeChip(
                        label = "下一集",
                        selected = false,
                        onClick = {
                            if (index + 1 < current.episodes.size) {
                                index += 1
                                drawerVisible = false
                                tried.clear()
                                tried += "${current.source.key}:${current.vodId}"
                                discovered = false
                            } else {
                                note = "已经是最后一集"
                            }
                        },
                    )
                }
                Spacer(Modifier.height(10.dp))
                LazyRow(state = drawerState, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    itemsIndexed(current.episodes) { i, _ ->
                        EpisodeChip(
                            label = "第 ${i + 1} 集",
                            selected = i == index,
                            focusRequester = chipsFocus.getOrPut(i) { FocusRequester() },
                            onClick = {
                                index = i
                                drawerVisible = false
                                tried.clear()
                                tried += "${current.source.key}:${current.vodId}"
                                discovered = false
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EpisodeChip(
    label: String,
    selected: Boolean,
    focusRequester: FocusRequester? = null,
    onClick: () -> Unit,
) {
    TvCard(
        onClick = onClick,
        focusRequester = focusRequester,
        containerColor = if (selected) org.librextv.tv.ui.theme.Panel2 else Color(0xFF1A202B),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(10.dp),
        focusedScale = 1.08f,
    ) { focused ->
        Text(
            label,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            color = if (selected || focused) Accent else TextPrimary,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
        )
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
