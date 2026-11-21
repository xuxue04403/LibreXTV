package org.librextv.tv.data

/**
 * 换台下标计算，与桌面端 `packages/core/src/live-switch.ts` 语义一致。
 *
 * 抽出来单独放是为了能纯函数测试：换台逻辑出错（比如首个频道按上键不回到末位）
 * 在电视上很难复现，但一个断言就能锁住。
 */

/** 循环步进：末尾按下回到 0，首位按上跳到末位 */
fun stepChannelIndex(length: Int, current: Int, direction: Int): Int {
    if (length <= 0) return -1
    if (current < 0) return if (direction < 0) length - 1 else 0
    val dir = if (direction < 0) -1 else 1
    return ((current % length) + dir + length) % length
}

/** 按 url 找频道下标，找不到返回 -1（换台时用它定位当前台在列表里的位置） */
fun indexOfChannel(list: List<LiveChannel>, url: String?): Int {
    if (url.isNullOrEmpty()) return -1
    return list.indexOfFirst { it.url == url }
}

/** 取下标对应的频道，越界返回 null */
fun channelAt(list: List<LiveChannel>, index: Int): LiveChannel? =
    if (index < 0 || index >= list.size) null else list[index]

/**
 * 退出直播播放页后，首焦点该落在第几台。
 *
 * 优先「刚看的那台」：退出多半是为了换台或挑别的，焦点回到原处才顺手。
 * 那台不在当前可见列表里（换了分组、关键词过滤掉了、列表还没到）时退回第一台。
 * 返回 -1 表示没有可聚焦的频道（空列表）。
 */
fun liveFocusIndex(list: List<LiveChannel>, lastUrl: String?): Int {
    if (list.isEmpty()) return -1
    val at = indexOfChannel(list, lastUrl)
    return if (at >= 0) at else 0
}
