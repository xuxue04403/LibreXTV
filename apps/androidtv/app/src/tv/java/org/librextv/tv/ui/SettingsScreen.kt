package org.librextv.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import org.librextv.tv.AppViewModel
import org.librextv.tv.data.AppData
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

@Composable
fun SettingsScreen(vm: AppViewModel, data: AppData) {
    var vodName by remember { mutableStateOf("") }
    var vodUrl by remember { mutableStateOf("") }
    var vodDetail by remember { mutableStateOf("") }
    var liveName by remember { mutableStateOf("") }
    var liveUrl by remember { mutableStateOf("") }
    var liveEpg by remember { mutableStateOf("") }
    var subUrl by remember { mutableStateOf("") }
    // 破坏性操作一律先问一句。电视遥控器上「删除」和「启用」只隔 10dp，
    // 误触一下就不可恢复（还要连带清掉该源的观看历史与收藏）。
    var confirmText by remember { mutableStateOf<String?>(null) }
    var confirmAction by remember { mutableStateOf<(() -> Unit)?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .padding(ScreenPadding)
            .verticalScroll(rememberScrollState()),
    ) {
        Text("设置", color = TextPrimary, fontSize = MaterialTheme.typography.headlineLarge.fontSize, fontWeight = FontWeight.Bold)
        Text(
            "数据源、播放偏好与本地数据都在这里管理",
            color = TextMuted,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
        )

        SectionHeader("添加点播源", "Apple CMS 采集接口")
        PanelBox {
            // 分两行排：内容区只有 764dp 宽（960 设计宽 - 104 导航 - 92 内边距），
            // 三个固定宽输入框挤在一行会把最后一个压成竖排单字
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = vodName,
                        onValueChange = { vodName = it },
                        label = { Text("名称（可选）") },
                        singleLine = true,
                        modifier = Modifier.width(220.dp),
                    )
                    OutlinedTextField(
                        value = vodUrl,
                        onValueChange = { vodUrl = it },
                        label = { Text("接口地址") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = vodDetail,
                        onValueChange = { vodDetail = it },
                        label = { Text("详情页根地址（可选）") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TvButton("添加", onClick = {
                        // 校验没过就别清空输入框：输错一个字符名称/地址/详情全丢，只能重打
                        if (vm.addSource(vodName, vodUrl, vodDetail.ifBlank { null })) {
                            vodName = ""
                            vodUrl = ""
                            vodDetail = ""
                        }
                    }, primary = true)
                }
            }
        }

        SectionHeader("点播源", "${data.activeSources().size}/${data.sources.size} 已启用")
        data.sources.forEach { source ->
            SourceRow(
                name = source.name,
                subtitle = buildString {
                    append(source.url)
                    if (source.builtin) append("  ·  内置")
                    // 默认关掉的内置源要说明原因，否则用户以为它坏了。
                    // 这是 v10 清单里写死的 note（大陆不通 / 搜索被 Cloudflare 挡）。
                    val note = source.note
                    if (!source.key.let { it in data.selected } && !note.isNullOrEmpty()) {
                        append("  ·  ")
                        append(note)
                    }
                },
                enabled = source.key in data.selected,
                onToggle = { vm.toggleSource(source.key) },
                onDelete = {
                    confirmText = "删除点播源「${source.name}」？\n该源的观看历史与收藏也会一并清除。"
                    confirmAction = { vm.removeSource(source.key) }
                },
            )
        }
        if (data.sources.isEmpty()) {
            Text("还没有点播源，可在下方「订阅导入」里恢复默认源。", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }

        SectionHeader("添加直播源", "M3U / M3U8 播放列表")
        PanelBox {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = liveName,
                        onValueChange = { liveName = it },
                        label = { Text("名称（可选）") },
                        singleLine = true,
                        modifier = Modifier.width(220.dp),
                    )
                    OutlinedTextField(
                        value = liveUrl,
                        onValueChange = { liveUrl = it },
                        label = { Text("M3U 地址") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = liveEpg,
                        onValueChange = { liveEpg = it },
                        label = { Text("EPG 地址（可选）") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TvButton("添加", onClick = {
                        if (vm.addLiveSource(liveName, liveUrl, liveEpg.ifBlank { null })) {
                            liveName = ""
                            liveUrl = ""
                            liveEpg = ""
                        }
                    }, primary = true)
                }
            }
        }

        SectionHeader("直播源", "${data.activeLiveSources().size}/${data.liveSources.size} 已启用")
        data.liveSources.forEach { source ->
            SourceRow(
                name = source.name,
                // 默认关闭的内置源要把原因写出来，否则用户以为它坏了
                subtitle = source.url + (if (source.builtin) "  ·  内置" else "") +
                    (source.note?.let { "\n$it" } ?: ""),
                enabled = source.key in data.liveSelected,
                onToggle = { vm.toggleLiveSource(source.key) },
                onDelete = {
                    confirmText = "删除直播源「${source.name}」？"
                    confirmAction = { vm.removeLiveSource(source.key) }
                },
            )
        }

        SectionHeader("订阅导入", "LibreTV-SourceList 或 TVBOX 配置")
        PanelBox {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = subUrl,
                    onValueChange = { subUrl = it },
                    label = { Text("订阅地址") },
                    singleLine = true,
                    modifier = Modifier.width(620.dp),
                )
                TvButton(
                    if (vm.importing) "导入中…" else "导入",
                    onClick = { vm.importSubscription(subUrl) },
                    primary = true,
                    // 置灰而不只是改文案：原来连按 OK 会并发跑两次导入，
                    // store 的 read-modify-write 会把同一批源重复追加
                    enabled = !vm.importing,
                )
                TvButton("恢复默认源", onClick = { vm.restoreBuiltinSources() })
            }
        }

        SectionHeader("拼音检索库", "按首字母找片的本地片名库")
        PanelBox {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    if (vm.seedSize > 0) {
                        "${vm.seedOrigin} · ${vm.seedSize} 个片名"
                    } else {
                        "尚未就绪（敲首字母时只会用本地扫过的片名）"
                    },
                    color = if (vm.seedSize > 0) TextPrimary else TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Text(
                    "启动后在 Wi-Fi 下静默拉一次当天新片；想立刻补上最新片名，可以点下面的重建。",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    TvButton("重建检索库", onClick = { vm.rebuildSeedLibrary() })
                }
            }
        }

        SectionHeader("播放设置")
        PanelBox {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SettingToggle(
                    "成人内容过滤",
                    "过滤含敏感分类关键词的搜索结果",
                    data.settings.adultFilter,
                ) { vm.updateSettings { s -> s.copy(adultFilter = !s.adultFilter) } }
                SettingToggle(
                    "自动连播下一集",
                    "当前集播放结束后自动播放下一集",
                    data.settings.autoplayNext,
                ) { vm.updateSettings { s -> s.copy(autoplayNext = !s.autoplayNext) } }
                SettingToggle(
                    "记住播放进度",
                    "下次打开同一影片时从上次位置继续播放",
                    data.settings.resumePlayback,
                ) { vm.updateSettings { s -> s.copy(resumePlayback = !s.resumePlayback) } }
                SettingToggle(
                    "移除播放列表广告",
                    "跳过采集站插在播放列表里的中插广告段；片源自带的贴片无法去掉",
                    data.settings.adFilter,
                ) { vm.updateSettings { s -> s.copy(adFilter = !s.adFilter) } }
                SettingToggle(
                    "移动网络下更新检索库",
                    "默认只在 Wi-Fi 下更新（整表约 1.9MB、每天增量几十 KB）；" +
                        "用 4G 电视盒子的话打开这个开关",
                    data.settings.seedOnCellular,
                ) { vm.updateSettings { s -> s.copy(seedOnCellular = !s.seedOnCellular) } }
            }
        }

        SectionHeader("本地数据")
        PanelBox {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                TvButton(
                "清空观看历史（${data.history.size} 条）",
                onClick = {
                    confirmText = "清空全部观看历史？\n共 ${data.history.size} 条，清空后无法恢复。"
                    confirmAction = { vm.clearHistory() }
                },
            )
                Text(
                    "收藏 ${data.favorites.size} 部 · 直播收藏 ${data.liveFavorites.size} 个",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
            }
        }

        SectionHeader("关于")
        PanelBox {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // 版本号从安装包读，不写死：写死过一次（v0.1.0 一直没跟着改）
                val context = LocalContext.current
                val versionName = remember(context) {
                    runCatching {
                        context.packageManager.getPackageInfo(context.packageName, 0).versionName
                    }.getOrNull().orEmpty().ifEmpty { "—" }
                }
                Text("LibreXTV TV 版 v$versionName", color = TextPrimary, fontWeight = FontWeight.SemiBold)
                Text(
                    "基于 LibreXTV（AGPL-3.0-or-later）的衍生客户端：采集聚合、解析与播放全部在电视本地完成，不需要部署服务器。",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Text(
                    "内置源均为第三方公开接口，与本项目无隶属关系，内容合法性由对应数据源负责；可在上方随时停用或删除。",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Text(
                    "投屏：本机作为 DLNA 接收端（DMR），手机视频 App 的「投屏」可直接选到「LibreXTV 电视」。",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
            }
        }

        Spacer(Modifier.height(40.dp))
    }

    val text = confirmText
    val action = confirmAction
    if (text != null && action != null) {
        ConfirmDialog(
            text = text,
            onConfirm = {
                confirmText = null
                confirmAction = null
                action()
            },
            onDismiss = {
                confirmText = null
                confirmAction = null
            },
        )
    }
}

/**
 * 遥控器上的二次确认。默认焦点放在「取消」——误触的代价比多点一下大得多。
 */
@Composable
private fun ConfirmDialog(text: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val cancelFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .width(560.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Panel)
                .border(1.dp, Line, RoundedCornerShape(16.dp))
                .padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(text, color = TextPrimary, fontSize = MaterialTheme.typography.titleMedium.fontSize)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvButton("取消", onClick = onDismiss, focusRequester = cancelFocus)
                TvButton("确认", onClick = onConfirm, primary = true)
            }
            LaunchedEffect(Unit) { runCatching { cancelFocus.requestFocus() } }
        }
    }
}

@Composable
private fun PanelBox(content: @Composable () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Panel)
            .padding(18.dp)
    ) {
        content()
    }
}

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
            .padding(bottom = 10.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color0F)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, color = TextPrimary, fontSize = MaterialTheme.typography.bodyMedium.fontSize, fontWeight = FontWeight.Medium)
            Text(
                subtitle,
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
                maxLines = 1,
            )
        }
        TvButton(if (enabled) "已启用" else "已停用", onClick = onToggle)
        Spacer(Modifier.width(10.dp))
        TvButton("删除", onClick = onDelete)
    }
}

@Composable
private fun SettingToggle(title: String, desc: String, checked: Boolean, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = TextPrimary, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
            Text(desc, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }
        TvButton(if (checked) "已开启" else "已关闭", onClick = onToggle)
    }
}

private val Color0F = androidx.compose.ui.graphics.Color(0xFF10141B)
