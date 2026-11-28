package org.librextv.tv.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.librextv.tv.AppViewModel
import org.librextv.tv.Screen
import org.librextv.tv.data.AppData
import org.librextv.tv.data.LiveChannel
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 直播页：顶部关键词 + 可横滑的分组胶囊 + 两列频道网格。
 *
 * 电视版是「左侧 226dp 分组栏 + 右侧自适应网格」，竖屏放不下左栏，
 * 改成顶部分组胶囊。频道数多（400+ 台）时必须用 LazyVerticalGrid 才不卡。
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun LiveScreen(vm: AppViewModel, data: AppData) {
    val live = vm.live
    LaunchedEffect(Unit) {
        if (!live.loading && live.channels.isEmpty()) vm.loadLive()
    }

    var keyword by remember { mutableStateOf("") }

    // 分组 + 关键词双重过滤；分组名缺省归到「未分组」
    val channels = remember(live.channels, live.selectedGroup, keyword) {
        val kw = keyword.trim()
        live.channels.filter { ch ->
            val groupOk = live.selectedGroup == "全部" || (ch.group ?: "未分组") == live.selectedGroup
            val keywordOk = kw.isEmpty() || ch.name.contains(kw, ignoreCase = true)
            groupOk && keywordOk
        }
    }
    val counts = remember(live.channels) {
        val map = HashMap<String, Int>()
        live.channels.forEach { ch ->
            val group = ch.group ?: "未分组"
            map[group] = (map[group] ?: 0) + 1
        }
        map
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "直播频道",
                    color = TextPrimary,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                )
                Text(
                    when {
                        live.loading && live.channels.isEmpty() &&
                            vm.liveBytes > 0 -> "正在读取直播源 ${vm.liveBytes / 1024} KB…"
                        live.loading && live.channels.isEmpty() -> "连接直播源…"
                        live.loading -> "已加载 ${live.channels.size} 个频道，仍在读取…"
                        live.fromCache -> "${channels.size} / ${live.channels.size} 个频道（缓存）"
                        else -> "${channels.size} / ${live.channels.size} 个频道"
                    },
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            PhoneButton(
                text = if (live.loading) "读取中…" else "刷新",
                onClick = { vm.loadLive(force = true) },
                enabled = !live.loading,
            )
        }

        OutlinedTextField(
            value = keyword,
            onValueChange = { keyword = it },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            singleLine = true,
            placeholder = {
                Text("筛选台名，如 CCTV、湖南", color = TextMuted, style = MaterialTheme.typography.bodySmall)
            },
            textStyle = MaterialTheme.typography.bodyMedium,
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Accent,
                unfocusedBorderColor = Line,
                focusedContainerColor = Panel,
                unfocusedContainerColor = Panel,
                cursorColor = Accent,
                focusedTextColor = TextPrimary,
                unfocusedTextColor = TextPrimary,
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { }),
        )

        LazyRow(
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item("all") {
                PhoneChip(
                    text = "全部 ${live.channels.size}",
                    active = live.selectedGroup == "全部",
                    onClick = { vm.setLiveGroup("全部") },
                )
            }
            // key 不能直接用分组名：某个频道的 group-title 字面就是「全部」时，
            // `listOf("全部") + Parsers.groups(...)` 里会出现两个「全部」，
            // LazyRow 直接抛 Key "全部" was already used 崩掉进程（电视版没传 key 才没暴露）。
            items(live.groups, key = { "group:$it" }) { group ->
                PhoneChip(
                    text = "$group ${counts[group] ?: 0}",
                    active = live.selectedGroup == group,
                    onClick = { vm.setLiveGroup(group) },
                )
            }
        }

        if (live.statuses.isNotEmpty()) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // key 带上下标：源名允许重复（设置页可以加两个同名不同址的源），
                // 拿源名当 key 会在同名的瞬间崩掉。
                itemsIndexed(live.statuses, key = { i, s -> "status:$i:${s.first}" }) { _, pair ->
                    val (name, status) = pair
                    // 判「成功」用后缀而非前缀：状态串是「<源名> · N 频道」或「加载失败」，
                    // 从来没有以 ✓ 开头的形态（电视版用的就是 endsWith("频道")）。
                    PhoneChip("$name · $status", active = status.endsWith("频道"))
                }
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth().padding(top = 6.dp)) {
            when {
                live.channels.isEmpty() && !live.loading -> {
                    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.TopCenter) {
                        PhoneEmpty(
                            title = "没有读到任何频道",
                            description = "已启用的直播源都没返回内容。到设置里确认直播源是否开启，或点右上角刷新。",
                        )
                    }
                }

                channels.isEmpty() -> {
                    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.TopCenter) {
                        PhoneEmpty(
                            title = "这个筛选下没有频道",
                            description = "换一个分组或清空关键词。",
                        )
                    }
                }

                else -> {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(channels, key = { "${it.sourceKey}:${it.url}" }) { channel ->
                            ChannelCell(
                                channel = channel,
                                favorite = data.liveFavorites.any { it.url == channel.url },
                                onPlay = { vm.go(Screen.LivePlayer(channel, channels)) },
                                onToggleFavorite = { vm.toggleLiveFavorite(channel) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 频道格：台标 + 台名 + 分组 + 收藏星。手机上每格 66dp 高，两列。 */
@Composable
private fun ChannelCell(
    channel: LiveChannel,
    favorite: Boolean,
    onPlay: () -> Unit,
    onToggleFavorite: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Panel)
            .clickable(onClick = onPlay)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(7.dp))
                .background(androidx.compose.ui.graphics.Color(0xFF0E1218)),
            contentAlignment = Alignment.Center,
        ) {
            if (channel.logo.isNullOrBlank()) {
                Text(
                    channel.name.take(2),
                    color = androidx.compose.ui.graphics.Color(0xFF455063),
                    style = MaterialTheme.typography.bodySmall,
                )
            } else {
                PhonePoster(
                    url = channel.logo,
                    title = channel.name,
                    modifier = Modifier.fillMaxSize(),
                    showLabel = false,
                )
            }
        }
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            Text(
                channel.name,
                color = TextPrimary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                channel.group ?: channel.sourceName,
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box(
            Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(999.dp))
                .clickable(onClick = onToggleFavorite),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (favorite) "★" else "☆",
                color = if (favorite) androidx.compose.ui.graphics.Color(0xFFF0B429) else TextMuted,
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}
