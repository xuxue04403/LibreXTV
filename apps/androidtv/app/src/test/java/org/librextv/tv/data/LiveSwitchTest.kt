package org.librextv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveSwitchTest {

    private fun ch(name: String, url: String) = LiveChannel(id = url, name = name, url = url)

    private val list = listOf(
        ch("CCTV-1", "http://a/1"),
        ch("CCTV-2", "http://a/2"),
        ch("CCTV-3", "http://a/3"),
    )

    @Test
    fun `按下从末位回到首位`() {
        assertEquals(0, stepChannelIndex(3, 2, 1))
    }

    @Test
    fun `按上从首位回到末位`() {
        assertEquals(2, stepChannelIndex(3, 0, -1))
    }

    @Test
    fun `中间位置正常步进`() {
        assertEquals(2, stepChannelIndex(3, 1, 1))
        assertEquals(0, stepChannelIndex(3, 1, -1))
    }

    @Test
    fun `当前位置未知时按方向落到两端`() {
        assertEquals(0, stepChannelIndex(3, -1, 1))
        assertEquals(2, stepChannelIndex(3, -1, -1))
    }

    @Test
    fun `空列表返回 -1`() {
        assertEquals(-1, stepChannelIndex(0, 0, 1))
        assertEquals(-1, stepChannelIndex(0, -1, -1))
    }

    @Test
    fun `下标越界先取模再步进`() {
        // 换台时列表可能因过滤变短，当前下标还停在旧位置
        assertEquals(0, stepChannelIndex(3, 5, 1))
        assertEquals(1, stepChannelIndex(3, 5, -1))
    }

    @Test
    fun `单个频道按下取模不崩`() {
        assertEquals(0, stepChannelIndex(1, 0, 1))
        assertEquals(0, stepChannelIndex(1, 0, -1))
    }

    @Test
    fun `按 url 定位当前频道`() {
        assertEquals(1, indexOfChannel(list, "http://a/2"))
    }

    @Test
    fun `找不到或空 url 返回 -1`() {
        assertEquals(-1, indexOfChannel(list, "http://a/9"))
        assertEquals(-1, indexOfChannel(list, null))
        assertEquals(-1, indexOfChannel(list, ""))
    }

    @Test
    fun `越界取频道返回 null`() {
        assertEquals("CCTV-2", channelAt(list, 1)?.name)
        assertNull(channelAt(list, 3))
        assertNull(channelAt(list, -1))
    }

    @Test
    fun `退出播放页后首焦点回到刚看的那台`() {
        assertEquals(2, liveFocusIndex(list, "http://a/3"))
    }

    @Test
    fun `刚看的那台不在当前列表里时首焦点落在第一台`() {
        // 换了分组 / 关键词把正在看的台过滤掉了：列表里找不到，退回第一台
        assertEquals(0, liveFocusIndex(list, "http://other/9"))
        assertEquals(0, liveFocusIndex(list, null))
    }

    @Test
    fun `没有频道时首焦点下标为 -1`() {
        assertEquals(-1, liveFocusIndex(emptyList(), "http://a/1"))
    }
}
