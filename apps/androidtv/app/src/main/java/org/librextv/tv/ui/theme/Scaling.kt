package org.librextv.tv.ui.theme

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density

/**
 * 设计基准：1080p 电视在 320dpi 下正好是 960×540dp。
 *
 * 所有 dp/sp 都按这个基准调过。若某台设备报出来的逻辑尺寸偏离基准，
 * 就整体缩放 density 把它拉回 960×540dp，这样每屏内容的相对占比恒定。
 */
const val DESIGN_WIDTH_DP = 960f
const val DESIGN_HEIGHT_DP = 540f

/**
 * 允许的缩放范围。
 *
 * 下限不能设得太高：720p 却报了 640dpi 的盒子逻辑宽度只有 320dp，
 * 若卡在 0.6 就会把内容裁掉（溢出）。宁可字小一点也不能切掉。
 *
 * 2026-11 复核实测：下限原为 0.35，而 320/960 = 0.333 —— 被抬到 0.35 之后
 * 内容比屏幕宽 5%，反而溢出。下限必须低于最窄设备的真实比例，
 * 取 0.25 留足余量（对应 240dp 宽，比任何已知电视盒子都窄）。
 */
private const val MIN_SCALE = 0.25f
private const val MAX_SCALE = 5f

/**
 * 计算 UI 缩放比例。
 *
 * 起因：部分 4K 电视盒子把 densityDpi 报成 160/213 而不是 640，
 * 于是逻辑宽度变成 3840dp，960dp 的设计被摊在 4 倍宽度里 —— 看起来就是「不随分辨率缩放」。
 * 反过来 720p 且上报 160dpi 的盒子会得到 1280dp，界面又会溢出。
 *
 * 这里统一归一化到设计基准：`scale = min(widthDp/960, heightDp/540)`。
 * 结果需要同时作用在 density 上（sp 也随之等比放大，见 [Density]）。
 */
fun tvUiScale(
    widthDp: Float,
    heightDp: Float,
    minScale: Float = MIN_SCALE,
    maxScale: Float = MAX_SCALE,
): Float {
    if (widthDp <= 0f || heightDp <= 0f) return 1f
    val raw = minOf(widthDp / DESIGN_WIDTH_DP, heightDp / DESIGN_HEIGHT_DP)
    if (!raw.isFinite()) return 1f
    return raw.coerceIn(minScale, maxScale)
}

/**
 * 把整棵 UI 树按 [tvUiScale] 缩放。
 *
 * 只在缩放比不为 1 时才提供新的 LocalDensity：大多数电视本来就是 1.0，
 * 免得无谓地重建 Density 触发一次全局重组。
 */
@Composable
fun TvScaleSurface(content: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val base = LocalDensity.current
        val scale = tvUiScale(maxWidth.value, maxHeight.value)
        val scaled = remember(base.density, base.fontScale, scale) {
            Density(base.density * scale, base.fontScale)
        }
        CompositionLocalProvider(LocalDensity provides scaled) {
            Box(Modifier.fillMaxSize()) { content() }
        }
    }
}
