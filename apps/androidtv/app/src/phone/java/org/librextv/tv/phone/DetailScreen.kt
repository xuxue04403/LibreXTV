package org.librextv.tv.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.librextv.tv.AppViewModel
import org.librextv.tv.Screen
import org.librextv.tv.data.AppData
import org.librextv.tv.data.HistoryDedupe
import org.librextv.tv.data.Parsers
import org.librextv.tv.data.VodDetail
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.Panel2
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 影片详情与选集。
 *
 * 与电视版的信息结构一致（海报 + 元信息 + 播放/收藏 + 同片换源 + 选集），
 * 但排成竖屏单列：海报缩到左侧 104dp，右侧放标题与元信息，下面是按钮与选集网格。
 */
@Composable
fun DetailScreen(vm: AppViewModel, target: Screen.Detail, data: AppData) {
    // vm.detail 是 DetailUi?：详情页没打开过时为 null，这里统一按「空态」处理
    val state = vm.detail
    val item = target.item
    val vod = state?.detail
    val favoriteId = "${item.sourceKey}:${item.vodId}"
    val favorite = data.favorites.any { it.id == favoriteId }

    // 续播定位：先按「源+ID」精确命中，再退回同名（换过源的片子 ID 会变）
    val history = data.history.firstOrNull { it.id == favoriteId }
        ?: data.history.firstOrNull {
            Parsers.normalizeTitle(it.title) == Parsers.normalizeTitle(item.name)
        }
    val resumeIndex = history?.let {
        if (vod == null || vod.episodes.isEmpty()) null
        else HistoryDedupe.clampEpisodeIndex(it.episodeIndex, vod.episodes.size)
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        PhoneTopBar(title = item.name, onBack = { vm.back() })

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                (state?.loading == true) && vod == null -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("正在获取播放地址…", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
                    }
                }

                vod == null -> {
                    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.TopCenter) {
                        PhoneEmpty(
                            title = "无法获取播放地址",
                            description = state?.error ?: "这个源没有返回分集信息，换一个源试试。",
                        ) {
                            PhoneButton("返回换源", onClick = { vm.back() }, primary = true)
                        }
                    }
                }

                else -> {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(4),
                        contentPadding = PaddingValues(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            DetailHead(vod, item.pic, item.sourceName, resumeIndex)
                        }

                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                            ) {
                                PhoneButton(
                                    text = if (resumeIndex != null) {
                                        "继续播放 · 第 ${resumeIndex + 1} 集"
                                    } else {
                                        "立即播放"
                                    },
                                    onClick = { vm.playFromDetail(resumeIndex ?: 0) },
                                    primary = true,
                                )
                                PhoneButton(
                                    text = if (favorite) "已收藏" else "收藏",
                                    onClick = { vm.toggleFavorite(item, vod.title, vod.cover) },
                                )
                                Box(Modifier.weight(1f))
                                Text(
                                    "共 ${vod.episodes.size} 集",
                                    color = TextMuted,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.align(Alignment.CenterVertically),
                                )
                            }
                        }

                        if (target.group.items.size > 1) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                Column(Modifier.padding(top = 10.dp)) {
                                    Text(
                                        "同名不同源（点一下换源）",
                                        color = TextMuted,
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                    LazyRow(
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                        contentPadding = PaddingValues(top = 6.dp),
                                    ) {
                                        items(target.group.items, key = { "${it.sourceKey}:${it.vodId}" }) { other ->
                                            val current = other.sourceKey == item.sourceKey && other.vodId == item.vodId
                                            PhoneChip(
                                                text = if (current) "${other.sourceName}（当前）" else other.sourceName,
                                                active = current,
                                                onClick = if (current) null else ({ vm.openDetail(target.group, other) }),
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        item(span = { GridItemSpan(maxLineSpan) }) {
                            PhoneSection("选集", "${vod.episodes.size} 集")
                        }

                        itemsIndexed(vod.episodes) { index, _ ->
                            val playing = history?.episodeIndex == index
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(42.dp)
                                    .clip(RoundedCornerShape(9.dp))
                                    .background(if (playing) Color(0xFF3A1D12) else Panel)
                                    .border(
                                        width = 1.dp,
                                        color = if (playing) Accent else Line,
                                        shape = RoundedCornerShape(9.dp),
                                    )
                                    .clickable { vm.playFromDetail(index) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    // 必须 +1：别处（电视版、鸿蒙版、播放页角标）都按「第 N 集」从 1 数，
                                    // 这里写成 0 起会让同一集出现 0 和 1 两种编号。
                                    "${index + 1}",
                                    color = if (playing) Color(0xFFFFC4B0) else TextPrimary,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 详情头：左海报 + 右元信息与简介。 */
@Composable
private fun DetailHead(
    vod: VodDetail,
    fallbackCover: String?,
    sourceName: String,
    resumeIndex: Int?,
) {
    Row(Modifier.fillMaxWidth()) {
        PhonePoster(
            url = vod.cover ?: fallbackCover,
            title = vod.title ?: "",
            modifier = Modifier.width(104.dp).aspectRatio(2f / 3f),
        )
        Column(
            modifier = Modifier.weight(1f).padding(start = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                vod.title ?: "未命名",
                color = TextPrimary,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val meta = listOfNotNull(vod.year, vod.area, vod.typeName, vod.remarks)
                .filter { it.isNotBlank() }
                .joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, color = TextMuted, style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PhoneChip(sourceName, active = true)
                if (resumeIndex != null) {
                    PhoneChip("看到第 ${resumeIndex + 1} 集")
                }
            }
            val desc = vod.desc
                ?.replace(Regex("<[^>]+>"), " ")
                ?.replace("&nbsp;", " ")
                ?.replace("&amp;", "&")
                ?.replace("&quot;", "\"")
                ?.replace("&#39;", "'")
                ?.replace("&lt;", "<")
                ?.replace("&gt;", ">")
                ?.replace(Regex("\\s+"), " ")
                ?.trim()
                ?.take(180)
            Text(
                if (desc.isNullOrBlank()) "暂无简介" else desc,
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
            if (!vod.actor.isNullOrBlank()) {
                Text(
                    "主演：${vod.actor}",
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** 供分类页复用的空态（保持两个页面的错误文案风格一致）。 */
@Composable
fun DetailEmptyHint(text: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Panel2)
            .padding(14.dp),
    ) {
        Text(text, color = TextMuted, style = MaterialTheme.typography.bodySmall)
    }
}
