package org.librextv.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.librextv.tv.AppViewModel
import org.librextv.tv.Screen
import org.librextv.tv.data.AppData
import org.librextv.tv.data.Pinyin
import org.librextv.tv.data.SearchGroup
import org.librextv.tv.data.SearchItem
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.AccentSoft
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.Panel2
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary
import org.librextv.tv.ui.theme.WarnAmber

/**
 * 搜索页：左边拼音字母键盘，右边实时片名建议，下面结果网格。
 *
 * 这套布局直接照搬桌面端 `apps/desktop/src/renderer/src/pages/Search.tsx`：
 *
 * ```
 * ┌──────────────┬───────────────────────────────────────┐
 * │ 键盘展示条    │  建议 · QYN            N 部匹配        │
 * │ 退格 清除 搜索 │  QYN  庆余年       3 源 · 2019 · 国产剧 │
 * │ A B C D E F  │  ...                                  │
 * │ ...          │─────────────────────────────────────── │
 * │ 0-9          │  结果网格（点建议后才出现）             │
 * └──────────────┴───────────────────────────────────────┘
 * ```
 *
 * **为什么不用输入框 + 系统输入法**（这是改动前的老方案）：实测在电视模拟器上
 * 按 OK 聚焦输入框后 `mInputShown=false`，软键盘根本不弹；实体电视盒子更常见
 * 没有可用输入法。就算弹得出来，遥控器敲一个汉字要按十几次方向键。改成
 * 「首字母 + 建议列表」后，`qyn` 三次按键就能定位到「庆余年」。
 *
 * 关键取舍：
 * - **建议行点下去只回填首字母、不填中文名**。键盘是追加式的，填了中文再敲字母
 *   就成了「庆余年q」，永远匹配不上（桌面端 audit-2026-11 第 21 条踩过这个坑）。
 * - **点建议立即出结果**：索引里已有的条目先铺上去（真实可点、能直接进详情），
 *   采集站的网络结果随后合并进来，而不是让用户盯着转圈。
 * - **失败的源可以单独重试**：一个源超时不该让已经拿到的十几部片全部清空重来。
 */
@Composable
fun SearchScreen(vm: AppViewModel, data: AppData) {
    val search = vm.search
    // 录入的是首字母串，不是完整片名。每次进搜索页都从空开始：用户点「搜索」
    // 导航项的意思是「我想搜点别的」，沿用上次的串会让人以为键盘没响应。
    var draft by remember { mutableStateOf("") }
    var emptyHint by remember { mutableStateOf(false) }
    val firstKeyFocus = remember { FocusRequester() }
    val submitFocus = remember { FocusRequester() }

    // 边敲边出建议：只查本地已见过的条目（零网络）。key 只用 draft —— 本地索引会
    // 被后台预热持续补充，但那段更新下次敲键时体现即可，不必让每次进度变化都重算。
    val localSuggestions = remember(draft) {
        if (draft.isEmpty()) emptyList() else vm.suggestTitles(draft, limit = 40)
    }
    // 拼音串够长时再去问「服务端拼音检索」的那两个源，避免每个字母都打一次网络
    val suggestions = localSuggestions

    // 拼音原文说明：让用户知道这套输入法识别的是首字母，而不是以为要打汉字
    val pinyinHint = draft.length >= 2 && Pinyin.isQuery(draft)

    // 焦点还在左侧导航里移动时不抢：否则焦点一进导航就被拽回键盘，
    // 用户没法用 ↓ 从「搜索」走到「直播」。见 FocusPolicy 的说明。
    val autoFocus = rememberAutoFocusState(vm.contentFocusTick)
    LaunchedEffect(vm.contentFocusTick) {
        if (!autoFocus.consume(vm.navFocusHold, vm.contentFocusTick)) {
            return@LaunchedEffect
        }
        repeat(4) { attempt ->
            if (attempt > 0) kotlinx.coroutines.delay(80L)
            if (runCatching { firstKeyFocus.requestFocus() }.isSuccess) {
                autoFocus.handledTick = vm.contentFocusTick
                return@LaunchedEffect
            }
        }
    }

    Row(Modifier.fillMaxSize().padding(ScreenPadding)) {
        // —— 左栏：只有键盘 ——
        // 1080p 屏在稿纸上只有 540dp 高，键盘本身就吃掉 370dp，左栏再塞提示和
        // 最近搜索会被裁成一条缝（实测提示文字只剩 4px）。所以左栏只放键盘，
        // 其余内容一律走右栏。
        Column(Modifier.width(KeyboardWidth)) {
            LetterKeyboard(
                value = draft,
                onAppend = { ch ->
                    emptyHint = false
                    // 键盘是追加式的：只接受字母数字，长度给个上限免得一直敲下去
                    if (draft.length < MAX_DRAFT_LENGTH) draft += ch
                },
                onBackspace = {
                    emptyHint = false
                    draft = draft.dropLast(1)
                },
                onClear = {
                    emptyHint = false
                    draft = ""
                },
                onSubmit = {
                    val word = draft.trim()
                    if (word.isEmpty()) {
                        emptyHint = true
                    } else {
                        vm.startSearch(word)
                    }
                },
                firstKeyFocus = firstKeyFocus,
                submitFocus = submitFocus,
            )
        }

        Spacer(Modifier.width(22.dp))

        // —— 右栏：建议列表 + 结果 ——
        Column(Modifier.weight(1f).fillMaxHeight()) {
            if (data.activeSources().isEmpty()) {
                EmptyState(
                    "还没有点播源",
                    "请到设置里添加采集站地址，或使用「恢复默认源」导入内置源。",
                    Modifier.padding(top = 30.dp),
                ) {
                    TvButton("去设置", onClick = { vm.go(Screen.Settings) })
                }
                return@Column
            }

            SearchHeader(
                draft = draft,
                lastKeyword = search.keyword,
                loading = search.loading,
                searched = search.searched,
                outcomeCount = search.outcomes.size,
                sourceCount = data.activeSources().size,
                groupCount = search.groups.size,
            )

            when {
                emptyHint -> {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "先用字母键敲片名的拼音首字母，再按搜索",
                        color = Accent,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    )
                }

                pinyinHint -> {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "按首字母检索：${draft.uppercase()}（本地索引 + 各源最新列表）",
                        color = TextMuted,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    )
                }
            }

            // 敲字但还没搜：整块给建议列表。搜过之后建议让位给结果，但仍然保留在
            // 结果之上（用户想再点另一条建议时不用先清空）。
            val showSuggestions = draft.isNotEmpty() && draft != search.keyword
            val failedOutcomes = search.outcomes.filter { !it.ok }
            if (showSuggestions) {
                Spacer(Modifier.height(8.dp))
                SuggestionPane(
                    draft = draft,
                    suggestions = suggestions,
                    modifier = Modifier.weight(1f),
                    onPick = { item ->
                        // 回填首字母而不是中文名：桌面端同一条规则，见文件头注释
                        draft = Pinyin.initials(item.name).takeIf { it.isNotEmpty() } ?: draft
                        vm.startSearch(item.name)
                    },
                )
            } else {
                // 没在敲字时，最近搜索是遥控器上最省力的入口：横排一行，点一下即复搜
                if (draft.isEmpty() && data.recentSearches.isNotEmpty()) {
                    RecentSearches(
                        words = data.recentSearches,
                        onPick = { word ->
                            // 回填原则与「点建议」一致：输入框只放首字母。历史里可能
                            // 存着中文片名（比如只点过建议没再敲键就搜了），直接填进
                            // 去会让后续键入变成「中文+字母」，永远匹配不上任何片名。
                            val filled = Pinyin.initials(word)
                            draft = if (filled.isEmpty() || !Pinyin.isQuery(filled)) "" else filled
                            vm.startSearch(word)
                        },
                        onClear = { vm.clearRecentSearches() },
                    )
                }
                if (search.outcomes.isNotEmpty() || search.searched) {
                    SourceChips(
                        outcomes = search.outcomes,
                        onRetry = { vm.retrySource(it) },
                    )
                    Spacer(Modifier.height(10.dp))
                    when {
                        !search.searched -> EmptyState(
                            "搜索影片",
                            "用左侧字母键盘输入片名的拼音首字母，例如「庆余年」→ qyn、「斗罗大陆」→ dldl。右侧会实时列出匹配片名，点一条即可搜它。",
                            Modifier.padding(top = 20.dp),
                        )

                        search.groups.isEmpty() -> EmptyState(
                            if (search.loading) "正在搜索…" else "没有找到相关内容",
                            when {
                                search.loading -> "各源返回速度不同，结果会陆续出现。"
                                failedOutcomes.isNotEmpty() ->
                                    "有 ${failedOutcomes.size} 个源没返回结果（上方标了 ↻ 的），按 OK 可以只重试那一个源。"
                                else -> "换个首字母再试；如果换了也是空的，去设置里看看源是不是被停用了。"
                            },
                            Modifier.padding(top = 20.dp),
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
                } else {
                    EmptyState(
                        "搜索影片",
                        "用左侧字母键盘输入片名的拼音首字母，例如「庆余年」→ qyn、「斗罗大陆」→ dldl。右侧会实时列出匹配片名，点一条即可搜它。",
                        Modifier.padding(top = 30.dp),
                    )
                }
            }
        }
    }
}

/** 建议列表最多显示多少条：够滚两屏即可，再多遥控器翻页成本高于重新敲字母 */
private const val MAX_SUGGESTIONS = 60

/** 首字母串长度上限：超过这个长度已经不可能命中，继续敲只是浪费时间 */
private const val MAX_DRAFT_LENGTH = 16

/** 右上角那行状态：让用户随时知道「在搜 / 搜了没有 / 几个源在跑」 */
@Composable
private fun SearchHeader(
    draft: String,
    lastKeyword: String,
    loading: Boolean,
    searched: Boolean,
    outcomeCount: Int,
    sourceCount: Int,
    groupCount: Int,
) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        // 已经在看结果时，标题要说明「这是哪个词的结果」：进页面时 draft 是空的，
        // 只写「建议 · 输入拼音首字母」会让用户以为上一次的结果凭空冒出来。
        val title = when {
            draft.isNotEmpty() -> "建议 · ${draft.uppercase()}"
            lastKeyword.isNotEmpty() -> "「$lastKeyword」的结果"
            else -> "建议 · 输入拼音首字母"
        }
        Text(
            title,
            color = TextPrimary,
            fontSize = MaterialTheme.typography.titleMedium.fontSize,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(14.dp))
        Text(
            when {
                loading -> "搜索中… $outcomeCount/$sourceCount 个源"
                searched -> "$groupCount 部影片"
                else -> "已启用 $sourceCount 个源"
            },
            color = TextMuted,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
            maxLines = 1,
        )
    }
}

/** 实时建议：每行「首字母 · 片名 · N 源 · 年份 · 类型」 */
@Composable
private fun SuggestionPane(
    draft: String,
    suggestions: List<SearchItem>,
    modifier: Modifier = Modifier,
    onPick: (SearchItem) -> Unit,
) {
    if (suggestions.isEmpty()) {
        Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopStart) {
            Text(
                if (draft.length < 2) "再敲一个字母就会出现候选片名"
                else "本地索引里没有以「${draft.uppercase()}」开头的片名，按左栏的搜索键去各源找一遍",
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
                modifier = Modifier.padding(top = 10.dp),
            )
        }
        return
    }
    LazyColumn(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items(suggestions.take(MAX_SUGGESTIONS), key = { "${it.sourceKey}:${it.vodId}" }) { item ->
            SuggestionRow(item = item, draft = draft, onClick = { onPick(item) })
        }
    }
}

@Composable
private fun SuggestionRow(item: SearchItem, draft: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val meta = listOfNotNull(item.year?.takeIf { it.isNotBlank() }, item.typeName?.takeIf { it.isNotBlank() })
        .joinToString(" · ")

    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (focused) Panel else Color.Transparent)
            .border(2.dp.takeIf { focused } ?: 0.dp, if (focused) Accent else Color.Transparent, shape)
            .selectable(
                selected = false,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            Pinyin.initials(item.name).uppercase().ifEmpty { draft.uppercase() },
            color = if (focused) Accent else TextMuted,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.width(56.dp),
        )
        Text(
            item.name,
            color = if (focused) Accent else TextPrimary,
            fontSize = MaterialTheme.typography.titleMedium.fontSize,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (meta.isNotEmpty()) {
            Spacer(Modifier.width(10.dp))
            Text(meta, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize, maxLines = 1)
        }
    }
}

/** 源状态：成功显示条数，失败的**可以按 OK 单独重试** */
@Composable
private fun SourceChips(
    outcomes: List<org.librextv.tv.data.SourceOutcome>,
    onRetry: (String) -> Unit,
) {
    if (outcomes.isEmpty()) return
    // 失败的排前面：17 个源挤在一条 LazyRow 里，后面的横向滚出屏幕就看不见了，
    // 而「哪些源没返回、要不要单独重试」恰恰是用户唯一需要动手的事；成功的源
    // 只是信息，排后面看不见也不影响操作。
    val ordered = outcomes.sortedBy { if (it.ok) 1 else 0 }
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        items(ordered, key = { it.sourceKey }) { outcome ->
            if (outcome.ok) {
                Chip("${outcome.sourceName} · ${outcome.items.size} 条", active = true)
            } else {
                // 失败 chip 必须可点：电视端一个源超时就把整轮结果清空重来，
                // 在盒子上又要等十几秒。点一下只补这一个源。
                Chip(
                    "${outcome.sourceName} · ${if (outcome.timedOut) "超时" else outcome.error ?: "失败"} ↻",
                    active = false,
                    onClick = { onRetry(outcome.sourceKey) },
                )
            }
        }
    }
}

/** 最近搜索：遥控器上这是最省力的入口，横排一行胶囊，点一下即复搜 */
@Composable
private fun RecentSearches(words: List<String>, onPick: (String) -> Unit, onClear: () -> Unit) {
    if (words.isEmpty()) return
    Spacer(Modifier.height(12.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("最近搜索", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        Spacer(Modifier.width(8.dp))
        // 用 LazyRow：条目一多（8 个词）横排会溢出，届时后面的胶囊被裁在屏幕外，
        // 但焦点仍能移过去（看不见焦点框），遥控器使用者会以为卡住了。
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            items(words.take(8)) { word ->
                Chip(word, active = false, onClick = { onPick(word) })
            }
            item {
                // 清除入口放在列表末尾而不是标题旁：翻到最右才能按，误触代价小，
                // 而清空历史是个不可撤销的操作。
                Chip("清除", active = false, onClick = onClear)
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
