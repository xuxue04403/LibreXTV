package org.librextv.tv.ui

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.librextv.tv.Screen
import org.librextv.tv.data.LiveChannel
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 锁住「退出直播播放页后焦点回到直播列表」这条链路（H4）。
 *
 * 现场：直播播放页整屏替换掉「导航栏 + 内容区」，返回时再换回来。播放页根 Box 是
 * 当时的焦点持有者，它被移除后 Compose 会清空焦点；此时列表页若没有节点认领焦点，
 * 第一次按方向键就会落到整棵树第一个可聚焦项 —— 顶栏的「首页」，而导航栏的设计是
 * 「焦点移上去就切页」，于是页面被直接切到首页（用户看到的就是「退出直播后跳到首页」）。
 *
 * 这里用真实的 [NavRail] 搭场景（它才是「焦点变了就切页」的来源），内容区用与
 * `LiveScreen` 同一套写法（`rememberAutoFocusState` + 逐帧重试抢焦点）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveReturnFocusUiTest {
    @get:Rule
    val rule = createComposeRule()

    /** 内容区「认领首焦点」的写法，与 `LiveScreen` 一致 */
    @Composable
    private fun LiveListStub(navFocusHold: Boolean, contentTick: Int, requester: FocusRequester) {
        val autoFocus = rememberAutoFocusState(contentTick)
        var claimed by remember { mutableStateOf(false) }
        LaunchedEffect(contentTick) {
            if (claimed) return@LaunchedEffect
            if (!autoFocus.consume(navFocusHold, contentTick)) return@LaunchedEffect
            repeat(4) { attempt ->
                if (attempt > 0) withFrameNanos { }
                if (runCatching { requester.requestFocus() }.isSuccess) {
                    autoFocus.handledTick = contentTick
                    claimed = true
                    return@LaunchedEffect
                }
            }
        }
        Text("CCTV-1", Modifier.testTag("channel").focusRequester(requester).focusable())
    }

    /** 播放页：拿住焦点（与 `LivePlayerScreen` 的根 Box 同构） */
    @Composable
    private fun PlayerStub() {
        val requester = remember { FocusRequester() }
        LaunchedEffect(Unit) { runCatching { requester.requestFocus() } }
        Text("直播播放中", Modifier.testTag("player").focusRequester(requester).focusable())
    }

    @Test
    fun `退出直播播放页后焦点落在直播列表，不会被顶栏切到首页`() {
        val channel = LiveChannel(id = "http://a/1", name = "CCTV-1", url = "http://a/1")
        var screen by mutableStateOf<Screen>(Screen.LivePlayer(channel))
        var selected by mutableStateOf<Screen?>(null)
        // 进播放页前焦点本来就在内容区，不在导航栏里
        val navFocusHold = false
        var contentTick by mutableIntStateOf(0)
        val channelFocus = FocusRequester()

        rule.setContent {
            Column(Modifier.fillMaxSize()) {
                NavRail(
                    current = screen,
                    onSelect = { selected = it },
                )
                if (screen is Screen.LivePlayer) {
                    PlayerStub()
                } else {
                    LiveListStub(navFocusHold, contentTick, channelFocus)
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithTag("player").assertIsFocused()

        // 返回：播放页被移除，列表页重新组合
        screen = Screen.Live
        contentTick += 1
        rule.waitForIdle()

        rule.onNodeWithTag("channel").assertIsFocused()
        // 顶栏没有被「焦点移上去就切页」带着跳走
        assertNull(selected)
    }
}
