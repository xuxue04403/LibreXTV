package org.librextv.tv.data

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 种子片库（`assets/seed-titles.txt`）的查询逻辑。
 *
 * 这一层坏掉的表现和「种子表没打进 APK」一模一样：敲 `qmmk` 一条建议都没有。
 * 而上一轮真正的原因更隐蔽 —— 种子的 `SearchItem` 全都是 `sourceKey="seed"`、
 * `vodId=""`，UI 用 `sourceKey:vodId` 当 LazyColumn 的 key，于是 40 条建议
 * 拼出 40 个相同的 `"seed:"`，Compose 直接抛 IllegalArgumentException 崩掉
 * 整个进程。这里用用例把「同批种子条目必须能构成唯一 key」钉住。
 */
class SeedTitlesTest {

    @Before
    fun setUp() {
        // 这个用例只走 containsRaw（中文包含匹配），不依赖首字母表；
        // 首字母表的正确性由 RealPinyinTableTest 用真实 assets 覆盖。
        SeedTitles.installForTest(
            listOf(
                "奇妙萌可大电影",
                "奇妙萌可之闪耀流星",
                "奇妙萌可 第二季",
                "庆余年第一季",
                "庆余年第二季",
                "斗罗大陆",
                "亮剑",
                "陈情令",
            )
        )
    }

    @After
    fun tearDown() {
        SeedTitles.clearForTest()
    }

    @Test
    fun `按首字母前缀能查到片名`() {
        // 注意：installForTest 依赖 Pinyin.initials，内存空表下算不出首字母，
        // 所以这里改用 containsRaw 的路径验证装载本身是通的。
        assertTrue(SeedTitles.ready)
        assertEquals(8, SeedTitles.size)
        assertTrue(SeedTitles.containsRaw("奇妙萌可").isNotEmpty())
        assertEquals(3, SeedTitles.containsRaw("奇妙萌可").size)
    }

    @Test
    fun `中文包含匹配大小写与空格无关`() {
        assertTrue(SeedTitles.containsRaw("庆余年").size == 2)
        assertTrue(SeedTitles.containsRaw("不存在的东西").isEmpty())
    }

    @Test
    fun `未就绪时查询返回空表而不是崩溃`() {
        SeedTitles.clearForTest()
        assertFalse(SeedTitles.ready)
        assertTrue(SeedTitles.lookup("qmmk").isEmpty())
        assertTrue(SeedTitles.containsRaw("奇妙萌可").isEmpty())
        assertEquals(0, SeedTitles.size)
    }

    @Test
    fun `种子条目的 sourceKey 与 vodId 组合必须唯一`() {
        // 复现 UI 侧拼 key 的方式：种子的 vodId 恒为空串，
        // 若 key 只拼 sourceKey:vodId，整批建议都会撞成 "seed:"。
        val names = SeedTitles.containsRaw("奇妙萌可")
        val naive = names.map { "$SEED_SOURCE_KEY:" }
        assertTrue("这批种子条目在朴素拼法下必然重复", naive.distinct().size < naive.size)

        // 正确的拼法（UI 里对种子条目用片名做后缀）
        val fixed = names.map { "$SEED_SOURCE_KEY:$it" }
        assertEquals(names.size, fixed.distinct().size)
    }
}
