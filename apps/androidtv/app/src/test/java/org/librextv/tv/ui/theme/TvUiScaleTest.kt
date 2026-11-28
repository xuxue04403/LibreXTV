package org.librextv.tv.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * UI 缩放归一化。
 *
 * 真实电视上报的 densityDpi 五花八门：1080p 报 320（960×540dp），
 * 4K 报 640（也是 960×540dp，正常），但不少廉价盒子 4K 只报 160/213，
 * 于是逻辑宽度变成 3840dp —— 界面缩在左上角、字小到看不清。
 */
class TvUiScaleTest {

    /**
     * 按「像素宽高 + 上报 dpi」算出缩放。
     *
     * 这个换算必须放在测试里做一遍：直接给 [tvUiScale] 喂 dp，等于假设
     * 「4K@640dpi 就是 960×540dp」，而这条假设本身才是要被验证的东西。
     */
    private fun scaleOf(pxW: Int, pxH: Int, dpi: Int): Float {
        val density = dpi / 160f
        return tvUiScale(pxW / density, pxH / density)
    }

    @Test
    fun `1080p 上报 320dpi 时保持原样`() {
        assertEquals(1f, scaleOf(1920, 1080, 320), 0.001f)
    }

    @Test
    fun `4K 上报 640dpi 时仍是 1`() {
        // 3840x2160 @ 640dpi = 960x540dp，与设计基准一致
        assertEquals(1f, scaleOf(3840, 2160, 640), 0.001f)
    }

    @Test
    fun `4K 只报 160dpi 时按 4 倍放大`() {
        // 3840x2160 @ 160dpi = 3840x2160dp，需要放大 4 倍才回到设计密度
        assertEquals(4f, tvUiScale(3840f, 2160f), 0.001f)
    }

    @Test
    fun `4K 报 213dpi 时按约 2_9 倍放大`() {
        // 3840x2160 @ 213dpi ≈ 2308x1298dp，廉价盒子里最常见的一档
        assertEquals(2308f / 960f, tvUiScale(2308f, 1298f), 0.01f)
    }

    @Test
    fun `720p 上报 320dpi 时按比例缩小`() {
        // 1280x720 @ 320dpi = 640x360dp
        assertEquals(640f / 960f, tvUiScale(640f, 360f), 0.001f)
    }

    @Test
    fun `超宽屏取较小的那个比例，避免纵向溢出`() {
        // 21:9 屏：宽度方向算出 2.0，高度方向算出 1.0 -> 取 1.0
        assertEquals(1f, tvUiScale(1920f, 540f), 0.001f)
    }

    @Test
    fun `缩放被夹在合理区间内`() {
        // 极端小尺寸不会把界面缩到看不见。
        // 下限是 0.25：100/960 = 0.104 被夹上来，但必须**低于**最窄真实设备的比例，
        // 否则夹取本身会把内容撑出屏幕（见下一条用例）。
        assertEquals(0.25f, tvUiScale(100f, 100f), 0.001f)
        // 极端大尺寸也不会放出天际
        assertEquals(5f, tvUiScale(20000f, 20000f), 0.001f)
    }

    @Test
    fun `非法尺寸回退到 1`() {
        assertEquals(1f, tvUiScale(0f, 540f), 0.001f)
        assertEquals(1f, tvUiScale(960f, -1f), 0.001f)
        assertEquals(1f, tvUiScale(Float.NaN, 540f), 0.001f)
    }

    @Test
    fun `竖屏尺寸按宽度归一化`() {
        // 开机瞬间报了竖屏尺寸 540x960dp：宽度方向 0.5625 更小，取它
        assertEquals(540f / 960f, tvUiScale(540f, 960f), 0.001f)
    }

    @Test
    fun `极端错报仍被下限保护，不会缩到不可读`() {
        // 1280x720 @ 640dpi 会算成 320x180dp；真实设备不该这样，兜底不让它无限缩小。
        // 但 320/960 = 0.333 本身比旧的 0.35 下限还小 —— 夹到 0.35 会把内容放大 5%
        // 撑出屏幕，所以下限必须低于它，这里断言「原样通过」。
        assertEquals(320f / 960f, tvUiScale(320f, 180f), 0.001f)
        // 再窄就该被兜住了：160dp 宽（320/960 的一半）已低于任何已知设备
        assertEquals(0.25f, tvUiScale(160f, 90f), 0.001f)
    }

    @Test
    fun `常见电视分辨率组合都能落到设计基准附近`() {
        // (宽 dp, 高 dp, 期望缩放) —— 覆盖 720p/1080p/4K 的各种 density 上报
        val cases = listOf(
            Triple(960f, 540f, 1f),          // 1080p @320dpi（标准）
            Triple(960f, 540f, 1f),          // 4K @640dpi（标准）
            Triple(1280f, 720f, 4f / 3f),    // 720p @160dpi
            Triple(640f, 360f, 2f / 3f),     // 720p @320dpi
            Triple(1920f, 1080f, 2f),        // 1080p @160dpi
            Triple(3840f, 2160f, 4f),        // 4K @160dpi
        )
        for ((w, h, expected) in cases) {
            assertEquals("${w}x${h}dp", expected, tvUiScale(w, h), 0.01f)
        }
    }

    /**
     * 「跟着分辨率自动缩放」的本质：同一个 128dp 卡片，无论屏幕是 720p 还是 4K、
     * 无论厂商把 densityDpi 报成多少，占屏宽的比例都必须一样。
     *
     * 渲染宽度 = dp × (dpi/160) × scale，于是占宽比 = 渲染宽度 / 像素宽。
     */
    @Test
    fun `同一张卡片在任何分辨率下占屏宽比例一致`() {
        val cardDp = 128f
        // (像素宽, 像素高, 上报 dpi)
        val screens = listOf(
            Triple(1280, 720, 320),   // 720p 标准
            Triple(1920, 1080, 320),  // 1080p 标准
            Triple(1920, 1080, 160),  // 1080p 误报 160
            Triple(1920, 1080, 213),  // 1080p 误报 213
            Triple(3840, 2160, 640),  // 4K 标准
            Triple(3840, 2160, 320),  // 4K 常见误报
            Triple(3840, 2160, 160),  // 4K 廉价盒子误报
        )
        val expected = 128f * 2f * 1f / 1920f // 1080p @320 基准：0.1333…

        for ((pxW, pxH, dpi) in screens) {
            val baseDensity = dpi / 160f
            val widthDp = pxW / baseDensity
            val heightDp = pxH / baseDensity
            val scale = tvUiScale(widthDp, heightDp)
            val renderedPx = cardDp * baseDensity * scale
            val fraction = renderedPx / pxW
            assertEquals("${pxW}x$pxH@${dpi}dpi", expected, fraction, 0.008f)
        }
    }
}
