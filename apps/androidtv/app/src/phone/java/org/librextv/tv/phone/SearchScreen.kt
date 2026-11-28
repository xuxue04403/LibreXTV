package org.librextv.tv.phone

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items as rowItems
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
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.librextv.tv.AppViewModel
import org.librextv.tv.data.SearchGroup
import org.librextv.tv.data.AppData
import org.librextv.tv.data.Pinyin
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 搜索页。
 *
 * 手机上的搜索框占满整行、软键盘回车即搜，结果两列海报网格。
 * 片源命中情况用一行可横滑的胶囊展示，方便判断「是不是某个源拖慢了整体」。
 */
@Composable
fun SearchScreen(vm: AppViewModel, data: AppData) {
    val search = vm.search
    val keyboard = LocalSoftwareKeyboardController.current
    // 用 TextFieldValue 才能控制光标：从历史/建议词点进来时把光标移到末尾，方便接着改写
    var input by remember { mutableStateOf(TextFieldValue(search.keyword)) }

    // 外部（历史记录、直播收藏等）带着关键词跳进来时同步输入框。
    //
    // 必须放在 LaunchedEffect 里，不能直接写在组合体里：组合体每次重绘都会执行，
    // 一旦判定 input.text != search.keyword 就把用户刚敲的字整段回滚 —— 表现是
    // 「往搜索框里打字，字刚出来就被吞掉」，只有和上次搜索词逐字相同时才留得住。
    // 用 search.keyword 当 key，只在「搜索词本身变了」时同步一次。
    LaunchedEffect(search.keyword) {
        if (search.keyword.isNotBlank() && input.text != search.keyword) {
            input = TextFieldValue(search.keyword, selection = TextRange(search.keyword.length))
        }
    }

    // 最后一处 distinct() 是必须的：这一行下面用片名本身当 LazyRow 的 key，
    // 而 search.keyword 会被拼在最前面、历史里也常常有同名片名（刚看完就回来重搜），
    // 一旦重复 Compose 直接抛 "Key \"...\" was already used." 崩掉进程。
    val suggestions = remember(search.keyword, data.history) {
        (
            (if (search.keyword.isNotBlank()) listOf(search.keyword) else emptyList()) +
                data.history.map { it.title }
            ).distinct().take(8)
    }

    fun submit(word: String) {
        val text = word.trim()
        if (text.isEmpty()) return
        input = TextFieldValue(text, selection = TextRange(text.length))
        vm.startSearch(text)
        // 搜完要立刻看结果，先把键盘收起来，避免挡掉半屏
        keyboard?.hide()
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge,
                placeholder = {
                    Text(
                        "片名、剧名、演员或拼音首字母",
                        color = TextMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                },
                shape = RoundedCornerShape(12.dp),
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
                keyboardActions = KeyboardActions(onSearch = { submit(input.text) }),
            )

            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    when {
                        search.loading -> "搜索中… ${search.outcomes.size}/${data.activeSources().size} 个源"
                        search.searched -> "${search.groups.size} 部影片"
                        else -> "已启用 ${data.activeSources().size} 个源"
                    },
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                if (Pinyin.isQuery(input.text)) {
                    PhoneChip("拼音检索", active = true)
                }
            }
        }

        if (suggestions.isNotEmpty() && search.groups.isEmpty()) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                rowItems(suggestions, key = { "sug:$it" }) { word ->
                    PhoneChip(word, onClick = { submit(word) })
                }
            }
        }

        if (search.outcomes.isNotEmpty()) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                rowItems(search.outcomes, key = { it.sourceKey }) { outcome ->
                    val label = if (outcome.ok) {
                        "${outcome.sourceName} · ${outcome.items.size} 条 · ${outcome.ms}ms"
                    } else {
                        "${outcome.sourceName} · ${if (outcome.timedOut) "超时" else "错误"}"
                    }
                    PhoneChip(label, active = outcome.ok && outcome.items.isNotEmpty())
                }
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                search.loading && search.groups.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            "正在向各源发起检索…",
                            color = TextMuted,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }

                search.searched && search.groups.isEmpty() -> {
                    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.TopCenter) {
                        PhoneEmpty(
                            title = "没有找到「${search.keyword}」",
                            description = "换一个片名、去掉季数或年份再试，或者到设置里多开几个源。",
                        )
                    }
                }

                else -> {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(search.groups, key = { it.key }) { group ->
                            GridCell(group) { vm.openDetail(group, group.items.first()) }
                        }
                    }
                }
            }
        }
    }
}

/** 结果网格里的一格：海报 + 片名 + 年份/备注 + 命中源数。 */
@Composable
private fun GridCell(group: SearchGroup, onClick: () -> Unit) {
    val item = group.items.firstOrNull() ?: return
    Column(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        PhonePoster(item.pic, item.name, Modifier.fillMaxWidth().aspectRatio(2f / 3f))
        Text(
            item.name,
            color = TextPrimary,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val meta = listOfNotNull(item.year, item.remarks).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(
                    meta,
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
            if (group.items.size > 1) {
                Text("${group.items.size} 源", color = Accent, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** 分类页复用同一套卡片（对外暴露，避免两个页面各写一份）。 */
@Composable
fun CategoryGridCell(group: SearchGroup, onClick: () -> Unit) {
    GridCell(group, onClick)
}
