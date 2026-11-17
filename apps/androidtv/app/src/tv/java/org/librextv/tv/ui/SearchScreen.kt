package org.librextv.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import org.librextv.tv.AppViewModel
import org.librextv.tv.data.Pinyin
import org.librextv.tv.data.AppData
import org.librextv.tv.data.SearchGroup
import org.librextv.tv.data.SearchItem
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.OkGreen
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.WarnAmber

@Composable
fun SearchScreen(vm: AppViewModel, data: AppData) {
    val search = vm.search
    // 每次进搜索页都是「想搜新的」：输入框从空开始，不沿用上一次的关键词。
    // 用 TextFieldValue 而不是 String，是为了能显式指定光标位置 ——
    // 只给 String 时 Compose 会把光标停在 0（首字母之前），接着输入就往回插字。
    var input by remember { mutableStateOf(TextFieldValue("")) }
    val word = input.text.trim()
    // 空输入按搜索时给一句提示：startSearch 对空串是静默 return，否则用户不知道发生了什么。
    var emptyHint by remember { mutableStateOf(false) }
    val searchButtonFocus = remember { FocusRequester() }
    // 边输入边出片名候选：只查本地已见过的条目（零网络），遥控器敲一个字母就见效。
    // 与按搜索键之后跑的 pinyinSearch 分工不同——那个要去各源翻页补全，慢但要找全。
    // key 只用 `word`：本地索引随时可能被后台预热补充，但那段更新只在下次输入时体现即可，
    // 不必把 `data` 塞进 key（那会让每次搜索进度变化都重算一遍候选）。
    val liveSuggestions = remember(word) {
        if (word.isEmpty()) emptyList() else vm.suggestTitles(word)
    }
    // 出结果后候选要让位给结果，但**不能一隐藏就再也不回来**：原来判的是 `!search.searched`，
    // 而 `searched` 一次搜索之后就一直是 true，用户清空输入、改成另一个词再敲，
    // 候选行永远不出现，只能退出搜索页重进。改成「输入与上次真正搜的词不一致才显示」。
    val showSuggestions = word != search.keyword
    val suggestions = remember(data.history, search.keyword) {
        (search.keyword.takeIf { it.isNotBlank() }?.let { listOf(it) } ?: emptyList()) +
            data.history.map { it.title }.distinct().take(6)
    }

    // 焦点还在左侧导航里移动时不抢：否则焦点一进导航就被这里拽到搜索框，
    // 用户没法用 ↓ 从「搜索」走到「直播」。见 FocusPolicy 的说明。
    // 用页面自持的「已响应序号」，不能写成 `remember(tick) { tick }`（两边一起变、判定恒假）。
    val autoFocus = rememberAutoFocusState(vm.contentFocusTick)
    LaunchedEffect(vm.contentFocusTick) {
        if (!autoFocus.consume(vm.navFocusHold, vm.contentFocusTick)) {
            return@LaunchedEffect
        }
        repeat(4) { attempt ->
            if (attempt > 0) kotlinx.coroutines.delay(80L)
            if (runCatching { searchButtonFocus.requestFocus() }.isSuccess) {
                autoFocus.handledTick = vm.contentFocusTick
                return@LaunchedEffect
            }
        }
    }

    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it; emptyHint = false },
                modifier = Modifier.width(520.dp),
                singleLine = true,
                placeholder = { Text("输入片名、剧名、演员或拼音首字母", color = TextMuted) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { if (word.isEmpty()) emptyHint = true else vm.startSearch(word) }),
            )
            Spacer(Modifier.width(12.dp))
            // 空输入时 startSearch 会直接 return（连 loading 都不置），按下去毫无反馈，
            // 看着像遥控器没响应。这里给一句明确的提示。
            TvButton(
                "搜索",
                onClick = { if (word.isEmpty()) emptyHint = true else vm.startSearch(word) },
                primary = true,
                focusRequester = searchButtonFocus,
            )
            Spacer(Modifier.width(16.dp))
            Text(
                if (search.loading) "搜索中… ${search.outcomes.size}/${data.activeSources().size} 个源"
                else if (search.searched) "${search.groups.size} 部影片"
                else "已启用 ${data.activeSources().size} 个源",
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            )
        }

        if (emptyHint) {
            Spacer(Modifier.height(10.dp))
            Text("先输入片名、演员或拼音首字母，再按搜索", color = Accent, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }

        if (Pinyin.isQuery(word)) {
            Spacer(Modifier.height(10.dp))
            Text(
                "按拼音首字母检索：$word → 「奇妙萌可」这类片名（本地已见过的条目 + 各源最新列表 + 量子/暴风的服务端拼音检索）",
                color = Accent,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            )
        }

        // 实时片名候选：边输入边出，点一下就填词并搜。放在「最近搜索」之前——
        // 用户正在敲字时最需要的正是这个，历史记录是没敲字时的兜底。
        if (liveSuggestions.isNotEmpty() && showSuggestions) {
            Spacer(Modifier.height(14.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                item { Text("片名：", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize) }
                items(liveSuggestions) { item ->
                    Chip(item.name) {
                        input = TextFieldValue(item.name, TextRange(item.name.length))
                        vm.startSearch(item.name)
                    }
                }
            }
        }

        if (suggestions.isNotEmpty() && showSuggestions) {
            Spacer(Modifier.height(14.dp))
            // 用 LazyRow 而不是 Row：建议词一多，后面的胶囊被裁在屏幕外，
            // 但焦点仍能移过去（看不见焦点框），遥控器使用者会以为卡住了。
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                item { Text("试试：", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize) }
                items(suggestions.take(8)) { kw ->
                    Chip(kw) { input = TextFieldValue(kw, TextRange(kw.length)); vm.startSearch(kw) }
                }
            }
        }

        if (search.outcomes.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                items(search.outcomes, key = { it.sourceKey }) { outcome ->
                    val text = if (outcome.ok) "${outcome.sourceName} · ${outcome.items.size} 条 · ${outcome.ms}ms"
                    else "${outcome.sourceName} · ${if (outcome.timedOut) "超时" else outcome.error ?: "失败"}"
                    Chip(text, active = outcome.ok)
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        when {
            data.activeSources().isEmpty() -> EmptyState(
                "还没有点播源",
                "请到设置里添加采集站地址，或使用「恢复默认源」导入内置源。",
                Modifier.padding(top = 30.dp),
            ) {
                TvButton("去设置", onClick = { vm.go(org.librextv.tv.Screen.Settings) })
            }

            !search.searched -> EmptyState(
                "搜索影片",
                "搜索会并行查询所有已启用的点播源，结果按片名聚合，同一部片来自多个源时可在详情里换源。",
                Modifier.padding(top = 30.dp),
            )

            search.groups.isEmpty() -> EmptyState(
                if (search.loading) "正在搜索…" else "没有找到相关内容",
                if (search.loading) "各源返回速度不同，结果会陆续出现。" else "换个关键词，或在设置里检查源是否可用。",
                Modifier.padding(top = 30.dp),
            )

            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(132.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(search.groups, key = { it.key }) { group ->
                    ResultCard(group) { vm.openDetail(group, group.items.first()) }
                }
            }
        }
    }
}

@Composable
private fun ResultCard(group: SearchGroup, onClick: () -> Unit) {
    val first = group.items.first()
    TvCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column {
            Poster(first.pic, group.name, Modifier.fillMaxWidth().height(238.dp))
            Column(Modifier.padding(10.dp)) {
                EllipsizedText(group.name, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        listOfNotNull(first.typeName, first.year).joinToString(" · "),
                        color = TextMuted,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        maxLines = 1,
                    )
                    if (group.items.size > 1) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "${group.items.size} 源",
                            color = Accent,
                            fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        )
                    }
                }
            }
        }
    }
}
