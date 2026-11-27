package org.librextv.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.AccentSoft
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.Panel2
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 电视端方形键盘。
 *
 * 与桌面端 `apps/desktop/src/renderer/src/components/LetterKeyboard.tsx` 同一套布局：
 *
 * ```
 * ┌───────────────────────────┐
 * │  拼音首字母输入框（只读展示）│
 * │  ⌫ 退格   清除   搜索       │
 * │  A B C D E F              │
 * │  G H I J K L              │
 * │  ...                       │
 * │  0-9                       │
 * └───────────────────────────┘
 * ```
 *
 * 为什么电视端必须这么做：遥控器上弹系统输入法找片名极其难受（一个汉字要按十几次
 * 方向键，而且实测很多电视盒子根本弹不出输入法）。「首字母 + 实时建议」把「输入」
 * 压缩到 1~4 次方向键 + OK，这正是桌面端一直在用的方案。
 *
 * 焦点顺序是**行优先**的：上下换行、左右换列，与遥控器直觉一致。第一行是输入框
 * 展示行（不可聚焦），第二行是三个操作键，之后是字母和数字。初始焦点落在「退格」上，
 * 而不是某个字母：进页面时用户多半想接着改上一个词，而 `A` 是左上角最容易被误按的。
 */
@Composable
fun LetterKeyboard(
    value: String,
    onAppend: (String) -> Unit,
    onBackspace: () -> Unit,
    onClear: () -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
    firstKeyFocus: FocusRequester? = null,
    submitFocus: FocusRequester? = null,
    enabled: Boolean = true,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(KEY_GAP)) {
        // 输入框：电视上不弹软键盘，所以这里只是「显示当前串 + 光标」的展示条。
        KeyboardDisplay(value)

        // 操作行
        Row(horizontalArrangement = Arrangement.spacedBy(KEY_GAP)) {
            KeyButton(
                text = "退格",
                onClick = onBackspace,
                modifier = Modifier.weight(1f),
                focusRequester = firstKeyFocus,
                enabled = enabled,
            )
            KeyButton(text = "清除", onClick = onClear, modifier = Modifier.weight(1f), enabled = enabled)
            KeyButton(
                text = "搜索",
                onClick = onSubmit,
                modifier = Modifier.weight(1f),
                primary = true,
                focusRequester = submitFocus,
                // 空串时搜索没有意义，但**不能禁用**：禁用后焦点会跳过它，
                // 遥控器从「清除」按 → 会直接跳到字母区，用户以为键盘坏了。
                enabled = enabled,
            )
        }

        LETTER_ROWS.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(KEY_GAP)) {
                row.forEach { ch ->
                    KeyButton(
                        text = ch.uppercase(),
                        onClick = { onAppend(ch) },
                        modifier = Modifier.weight(1f),
                        enabled = enabled,
                    )
                }
                // 末行只有 2 个字母：补占位，保证每行格子宽度一致、焦点列对齐
                repeat(LETTER_ROW_SIZE - row.size) {
                    Box(Modifier.weight(1f))
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(KEY_GAP)) {
            DIGITS.forEach { ch ->
                KeyButton(
                    text = ch,
                    onClick = { onAppend(ch) },
                    modifier = Modifier.weight(1f),
                    compact = true,
                    enabled = enabled,
                )
            }
        }
    }
}

/**
 * 键间距。
 *
 * 6dp 而不是 8dp：1080p 屏（dp 高度只有 540）上，输入框 + 3 秒操作行 + 5 行字母 +
 * 1 行数字已经吃掉 340 多 dp，间距每多 2dp 就从右侧建议栏抠走 12dp 可视高度。
 */
private val KEY_GAP = 6.dp

/** 显示当前输入的串；为空时给一句占位提示 */
@Composable
private fun KeyboardDisplay(value: String) {
    val shape = RoundedCornerShape(10.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(shape)
            .background(Panel)
            .border(1.dp, if (value.isEmpty()) Line else Accent, shape)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (value.isEmpty()) {
            Text(
                "拼音首字母，如 qyn = 庆余年",
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodyMedium.fontSize,
            )
        } else {
            Text(
                value.uppercase(),
                color = TextPrimary,
                fontSize = 26.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 4.sp,
            )
            // 光标：闪动交给 Compose 的动画太啰嗦，静态竖线已经够表达「还能继续敲」
            Box(
                Modifier
                    .padding(start = 3.dp)
                    .width(2.dp)
                    .height(22.dp)
                    .background(Accent)
            )
        }
    }
}

/**
 * 键盘上的一个键。
 *
 * 不用 [TvCard]：那个是给海报卡用的，`focusedScale = 1.05f` 在 24 个键同时存在时
 * 会互相重叠，而且圆角 14dp 显得太圆。这里要的是「方块 + 描边 + 轻微放大」。
 */
@Composable
private fun KeyButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    compact: Boolean = false,
    focusRequester: FocusRequester? = null,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(9.dp)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val height = if (compact) 40.dp else 46.dp

    Box(
        modifier
            .height(height)
            .clip(shape)
            .background(
                when {
                    focused && primary -> Accent
                    focused -> Panel
                    primary -> AccentSoft
                    else -> Panel2
                }
            )
            .border(
                2.dp.takeIf { focused } ?: 1.dp,
                when {
                    focused -> Accent
                    primary -> Accent
                    else -> Line
                },
                shape,
            )
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
            .selectable(
                selected = false,
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = when {
                focused && primary -> Color(0xFF1A0D07)
                focused -> Accent
                primary -> Color(0xFFFFC4B0)
                else -> TextPrimary
            },
            fontSize = if (compact) 14.sp else MaterialTheme.typography.labelLarge.fontSize,
            fontWeight = if (focused || primary) FontWeight.SemiBold else FontWeight.Normal,
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
    }
}

/**
 * 每行几个字母。
 *
 * 用 6 而不是 TVBox 那种 7~9：电视遥控器是「上下左右 + OK」的十字键，一行 9 个字母时
 * 从左到右要按 8 次才到头，误按率高；6 个刚好一屏塞得下且列宽足够（1920 宽下每键约 90dp，
 * 30 寸以上电视从 3 米看仍然清楚）。
 */
const val LETTER_ROW_SIZE = 6

/** 字母行：字母表顺序，与桌面端 `LETTER_ROWS` 完全一致 */
val LETTER_ROWS: List<List<String>> = listOf(
    listOf("a", "b", "c", "d", "e", "f"),
    listOf("g", "h", "i", "j", "k", "l"),
    listOf("m", "n", "o", "p", "q", "r"),
    listOf("s", "t", "u", "v", "w", "x"),
    listOf("y", "z"),
)

val DIGITS: List<String> = listOf("0", "1", "2", "3", "4", "5", "6", "7", "8", "9")

/** 键盘整体宽度，供搜索页给右侧建议栏留出剩余空间 */
val KeyboardWidth = 470.dp
