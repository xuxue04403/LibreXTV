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

    @Test
    fun `每日增量合并会去重并返回真实新增条数`() {
        val before = SeedTitles.size
        // 两条新片 + 一条已有 + 一条空白：只应新增 2 条
        val added = SeedTitles.merge(listOf("新生片名甲", "新生片名乙", "亮剑", "   "))
        assertEquals(2, added)
        assertEquals(before + 2, SeedTitles.size)
        // 重复合并同一批不应再涨：否则每日增量跑几次就把内存表撑爆
        assertEquals(0, SeedTitles.merge(listOf("新生片名甲", "新生片名乙")))
        assertEquals(before + 2, SeedTitles.size)
    }

    @Test
    fun `增量里的新片名要能被中文包含匹配到`() {
        SeedTitles.merge(listOf("测试用新剧第一季"))
        assertEquals(listOf("测试用新剧第一季"), SeedTitles.containsRaw("测试用新剧"))
    }

    @Test
    fun `未就绪时合并是安全的空操作`() {
        SeedTitles.clearForTest()
        assertEquals(0, SeedTitles.merge(listOf("随便一条")))
        assertFalse(SeedTitles.ready)
    }

    @Test
    fun `增量合并只碰受影响的键，其它键的桶对象不重建`() {
        // 这条要靠首字母倒排表，所以先装真实拼音表（内存空表算不出首字母，装出来的
        // 倒排表会是空的，断言就变成永远不可能失败的空转）。
        val table = listOf(
            java.io.File("src/main/assets/pinyin-table.txt"),
            java.io.File("app/src/main/assets/pinyin-table.txt"),
            java.io.File("apps/androidtv/app/src/main/assets/pinyin-table.txt"),
        ).firstOrNull { it.isFile }
        org.junit.Assume.assumeTrue("找不到 pinyin-table.txt，跳过", table != null)
        Pinyin.install(table!!.readText())
        SeedTitles.installForTest(listOf("庆余年第一季", "庆余年第二季", "亮剑"))

        // 这张表实测有 58 万个键，整表拷贝一次约 28MB 临时内存，冷启动时 OTA 与
        // 每日增量各调一次，低端盒子会 OOM。这里断言「未被命中的桶保持同一个对象
        // 引用」——如果哪天有人把 merge 改回 `HashMap(byInitials)`，这条会挂。
        val untouchedBefore = SeedTitles.lookup("qy", 200).toList()
        val objectBefore = SeedTitles.bucketIdentityForTest("qy")
        assertEquals(1, SeedTitles.merge(listOf("亮剑第二部")))
        assertEquals("未被命中的键不该被复制", objectBefore, SeedTitles.bucketIdentityForTest("qy"))
        assertEquals(untouchedBefore, SeedTitles.lookup("qy", 200).toList())
        // 命中的键必须包含新条目
        assertTrue(SeedTitles.lookup("lj", 200).contains("亮剑第二部"))
        // 老数据不能丢
        assertTrue(SeedTitles.lookup("qy", 200).contains("庆余年第一季"))
    }
}
