package org.librextv.tv.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import org.librextv.tv.AppViewModel
import org.librextv.tv.Screen
import org.librextv.tv.data.AppData
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.OkGreen
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.Panel2
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 手机版设置页。
 *
 * 内容与电视版逐项对齐（源管理、订阅导入、播放开关、本地数据、关于），
 * 排布改成竖屏单列 + 可滚动的输入框，键盘弹出时 adjustResize 会自动让位。
 */
@Composable
fun SettingsScreen(vm: AppViewModel, data: AppData) {
    val context = LocalContext.current
    var vodName by remember { mutableStateOf("") }
    var vodUrl by remember { mutableStateOf("") }
    var vodDetail by remember { mutableStateOf("") }
    var liveName by remember { mutableStateOf("") }
    var liveUrl by remember { mutableStateOf("") }
    var liveEpg by remember { mutableStateOf("") }
    var subUrl by remember { mutableStateOf("") }
    var confirmText by remember { mutableStateOf<String?>(null) }
    var confirmAction by remember { mutableStateOf<(() -> Unit)?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(PhonePadding),
    ) {
        Text(
            "设置",
            color = TextPrimary,
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(12.dp))

        // ---------- 点播源 ----------
        PhoneSection("添加点播源", "苹果 CMS 标准采集接口")
        PanelBox {
            PhoneField(vodName, { vodName = it }, "名称，如「某某资源」", ImeAction.Next)
            Spacer(Modifier.height(8.dp))
            PhoneField(vodUrl, { vodUrl = it }, "接口地址 https://.../api.php/provide/vod", ImeAction.Next, KeyboardType.Uri)
            Spacer(Modifier.height(8.dp))
            PhoneField(vodDetail, { vodDetail = it }, "详情页根地址（可留空）", ImeAction.Done, KeyboardType.Uri)
            Spacer(Modifier.height(10.dp))
            PhoneButton("添加点播源", primary = true, onClick = {
                if (vm.addSource(vodName, vodUrl, vodDetail.ifBlank { null })) {
                    vodName = ""
                    vodUrl = ""
                    vodDetail = ""
                }
            })
        }

        PhoneSection("点播源", "${data.sources.count { it.key in data.selected }} / ${data.sources.size} 个已启用")
        data.sources.forEach { source ->
            val enabled = source.key in data.selected
            SourceRow(
                name = source.name,
                subtitle = buildString {
                    append(source.url)
                    if (source.builtin) append("  ·  内置")
                    // 停用原因只在「没启用」时显示：启用着的源写一长串「为什么默认关闭」
                    // 纯属噪音，用户还要为它多滑一段（TV 版也是这个口径）。
                    if (!enabled) source.note?.let { append("\n"); append(it) }
                },
                enabled = enabled,
                onToggle = { vm.toggleSource(source.key) },
                onDelete = {
                    confirmText = "删除点播源「${source.name}」？\n该源的观看历史与收藏也会一并清除。"
                    confirmAction = { vm.removeSource(source.key) }
                },
            )
        }

        // ---------- 直播源 ----------
        PhoneSection("添加直播源", "M3U / M3U8 播放列表地址")
        PanelBox {
            PhoneField(liveName, { liveName = it }, "名称", ImeAction.Next)
            Spacer(Modifier.height(8.dp))
            PhoneField(liveUrl, { liveUrl = it }, "播放列表地址", ImeAction.Next, KeyboardType.Uri)
            Spacer(Modifier.height(8.dp))
            PhoneField(liveEpg, { liveEpg = it }, "EPG 地址（可留空）", ImeAction.Done, KeyboardType.Uri)
            Spacer(Modifier.height(10.dp))
            PhoneButton("添加直播源", primary = true, onClick = {
                if (vm.addLiveSource(liveName, liveUrl, liveEpg.ifBlank { null })) {
                    liveName = ""
                    liveUrl = ""
                    liveEpg = ""
                }
            })
        }

        PhoneSection("直播源", "${data.liveSources.count { it.key in data.liveSelected }} / ${data.liveSources.size} 个已启用")
        data.liveSources.forEach { source ->
            SourceRow(
                name = source.name,
                subtitle = buildString {
                    append(source.url)
                    if (source.builtin) append("  ·  内置")
                    source.note?.let { append("\n"); append(it) }
                },
                enabled = source.key in data.liveSelected,
                onToggle = { vm.toggleLiveSource(source.key) },
                onDelete = {
                    confirmText = "删除直播源「${source.name}」？"
                    confirmAction = { vm.removeLiveSource(source.key) }
                },
            )
        }

        // ---------- 订阅导入 ----------
        PhoneSection("订阅导入", "粘贴包含 sites / lives 的 JSON 订阅")
        PanelBox {
            PhoneField(subUrl, { subUrl = it }, "订阅地址", ImeAction.Done, KeyboardType.Uri)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PhoneButton(
                    if (vm.importing) "导入中…" else "导入订阅",
                    primary = true,
                    enabled = !vm.importing,
                    onClick = { vm.importSubscription(subUrl) },
                )
                PhoneButton("恢复默认源", onClick = { vm.restoreBuiltinSources() })
            }
        }

        // ---------- 播放设置 ----------
        PhoneSection("播放设置")
        val settings = data.settings
        SettingToggle("成人内容过滤", "按分类名与片名过滤，可能误伤", settings.adultFilter) {
            vm.updateSettings { s -> s.copy(adultFilter = !s.adultFilter) }
        }
        SettingToggle("自动连播下一集", "一集播完自动续播", settings.autoplayNext) {
            vm.updateSettings { s -> s.copy(autoplayNext = !s.autoplayNext) }
        }
        SettingToggle("记住播放进度", "下次进入从上次位置继续", settings.resumePlayback) {
            vm.updateSettings { s -> s.copy(resumePlayback = !s.resumePlayback) }
        }
        SettingToggle("移除播放列表广告", "从 m3u8 里摘掉中插广告段", settings.adFilter) {
            vm.updateSettings { s -> s.copy(adFilter = !s.adFilter) }
        }

        // ---------- 本地数据 ----------
        PhoneSection("本地数据")
        PanelBox {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("观看记录", color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "收藏 ${data.favorites.size} 部 · 直播收藏 ${data.liveFavorites.size} 个",
                        color = TextMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                PhoneButton("清空历史（${data.history.size}）", onClick = {
                    confirmText = "清空全部观看记录？收藏不受影响。"
                    confirmAction = { vm.clearHistory() }
                })
            }
        }

        // ---------- 投屏 ----------
        PhoneSection("投屏接收", "让同一局域网里的手机/电脑把视频投过来")
        PanelBox {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        if (org.librextv.tv.cast.CastRuntime.running) "投屏接收已就绪" else "投屏接收未启动",
                        color = TextPrimary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        org.librextv.tv.cast.CastRuntime.address ?: "未获取到局域网地址",
                        color = TextMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                PhoneButton("查看", onClick = { vm.go(Screen.Cast) })
            }
        }

        // ---------- 关于 ----------
        PhoneSection("关于")
        PanelBox {
            val versionName = remember {
                runCatching {
                    context.packageManager.getPackageInfo(context.packageName, 0).versionName
                }.getOrNull() ?: "?"
            }
            Text(
                "LibreXTV 手机版 v$versionName",
                color = TextPrimary,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "内置源均为第三方公开接口，与本项目无隶属关系；仅作开箱即用的示例，" +
                    "可在上方随时停用或删除。本项目以 AGPL-3.0 授权，不提供任何影视内容。",
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(7.dp).height(7.dp).clip(RoundedCornerShape(999.dp)).background(OkGreen))
                Spacer(Modifier.width(6.dp))
                Text(
                    "手机版与电视版共用同一套采集与播放内核",
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Spacer(Modifier.height(24.dp))
    }

    val text = confirmText
    if (text != null) {
        ConfirmDialog(
            text = text,
            onConfirm = {
                confirmAction?.invoke()
                confirmText = null
                confirmAction = null
            },
            onDismiss = {
                confirmText = null
                confirmAction = null
            },
        )
    }
}

@Composable
private fun PanelBox(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF10141B))
            .padding(12.dp),
        content = content,
    )
}

@Composable
private fun PhoneField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    imeAction: ImeAction = ImeAction.Next,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth(),
        placeholder = { Text(placeholder, color = TextMuted, style = MaterialTheme.typography.bodySmall) },
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyMedium,
        shape = RoundedCornerShape(10.dp),
        keyboardOptions = KeyboardOptions(imeAction = imeAction, keyboardType = keyboardType),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Accent,
            unfocusedBorderColor = Line,
            focusedContainerColor = Panel,
            unfocusedContainerColor = Panel,
            cursorColor = Accent,
            focusedTextColor = TextPrimary,
            unfocusedTextColor = TextPrimary,
        ),
    )
}

/** 单个源条目：启用开关 + 删除，点击行本身也可切换启用。 */
@Composable
private fun SourceRow(
    name: String,
    subtitle: String,
    enabled: Boolean,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Color(0xFF10141B))
            .clickable(onClick = onToggle)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                name,
                color = if (enabled) TextPrimary else TextMuted,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
            Text(
                subtitle,
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 3,
            )
        }
        Spacer(Modifier.width(8.dp))
        Box(
            Modifier
                .clip(RoundedCornerShape(999.dp))
                .clickable(onClick = onDelete)
                .padding(horizontal = 8.dp, vertical = 6.dp),
        ) {
            Text("删除", color = Color(0xFFF2555A), style = MaterialTheme.typography.bodySmall)
        }
        Switch(
            checked = enabled,
            onCheckedChange = { onToggle() },
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color(0xFF1A0D07),
                checkedTrackColor = Accent,
                uncheckedThumbColor = TextMuted,
                uncheckedTrackColor = Panel2,
                uncheckedBorderColor = Line,
            ),
        )
    }
}

@Composable
private fun SettingToggle(title: String, subtitle: String, checked: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Color(0xFF10141B))
            .clickable(onClick = onToggle)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
            Text(subtitle, color = TextMuted, style = MaterialTheme.typography.bodySmall)
        }
        Switch(
            checked = checked,
            onCheckedChange = { onToggle() },
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color(0xFF1A0D07),
                checkedTrackColor = Accent,
                uncheckedThumbColor = TextMuted,
                uncheckedTrackColor = Panel2,
                uncheckedBorderColor = Line,
            ),
        )
    }
}

@Composable
private fun ConfirmDialog(text: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(Panel)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(text, color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Spacer(Modifier.weight(1f))
                PhoneButton("取消", onClick = onDismiss)
                PhoneButton("确认", primary = true, onClick = onConfirm)
            }
        }
    }
}
