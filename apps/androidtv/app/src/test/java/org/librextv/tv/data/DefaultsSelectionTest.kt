package org.librextv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 内置直播源的「默认是否启用」规则。
 *
 * 背景：iptv-org 全球榜有一万多个频道，实测绝大多数在境内连不上（中国大陆频道
 * 可播率只有 48%）。全开会让新用户随手点一个台就是死台，于是清单里给这类源写
 * `"selected": false`：源照样出现在设置里，只是默认不勾。
 */
class DefaultsSelectionTest {

    @Test
    fun `没写 selected 的源默认启用`() {
        val json = """
            {"liveSources":[{"name":"A","url":"http://a/x.m3u"},{"name":"B","url":"http://b/x.m3u"}]}
        """.trimIndent()
        assertEquals(setOf("builtin_live_0", "builtin_live_1"), Defaults.defaultLiveSelectedKeysFrom(json))
    }

    @Test
    fun `写了 selected false 的源默认不启用`() {
        val json = """
            {"liveSources":[
              {"name":"全球","url":"http://a/x.m3u","selected":false},
              {"name":"中国","url":"http://b/x.m3u"}
            ]}
        """.trimIndent()
        assertEquals(setOf("builtin_live_1"), Defaults.defaultLiveSelectedKeysFrom(json))
    }

    @Test
    fun `selected 写成字符串 false 也能识别`() {
        // 上游 json 里 `"selected": "false"` 这种写法真实出现过，别只认布尔
        val json = """
            {"liveSources":[{"name":"全球","url":"http://a/x.m3u","selected":"false"}]}
        """.trimIndent()
        assertTrue(Defaults.defaultLiveSelectedKeysFrom(json).isEmpty())
    }

    @Test
    fun `selected 为 true 时不误伤`() {
        val json = """
            {"liveSources":[{"name":"全球","url":"http://a/x.m3u","selected":true}]}
        """.trimIndent()
        assertEquals(setOf("builtin_live_0"), Defaults.defaultLiveSelectedKeysFrom(json))
    }

    @Test
    fun `清单损坏时退回空集而不是崩溃`() {
        assertEquals(emptySet<String>(), Defaults.defaultLiveSelectedKeysFrom("{ not json"))
        assertEquals(emptySet<String>(), Defaults.defaultLiveSelectedKeysFrom("{}"))
        assertEquals(emptySet<String>(), Defaults.defaultLiveSelectedKeysFrom("""{"liveSources":[]}"""))
    }

    @Test
    fun `清单里被关掉的源要能列出来，供升级时一次性取消勾选`() {
        val json = """
            {"liveSources":[
              {"name":"全球","url":"http://a/x.m3u","selected":false},
              {"name":"中国","url":"http://b/x.m3u","selected":"false"},
              {"name":"精选","url":"http://c/x.m3u"}
            ]}
        """.trimIndent()
        assertEquals(setOf("builtin_live_0", "builtin_live_1"), Defaults.defaultLiveDisabledKeysFrom(json))
        assertEquals(setOf("builtin_live_2"), Defaults.defaultLiveSelectedKeysFrom(json))
    }

    @Test
    fun `仓库里的真实清单默认只启用四个实测可播的源`() {
        // 与 defaults/sources.json 保持同步：0=iptv-org 全球频道、1=iptv-org 中国频道、
        // 6=Guovin 央视卫视、7=YueChan 港台新闻都标了 selected:false
        // （国内等距抽测 8% / 10% / 18% / 33% 可播），
        // 2=vbskycn 国内 IPv4、3=zhi35 央视卫视港澳台、4=best-fan 国内全量、
        // 5=Collect-IPTV 精选才是默认启用的四个（抽测 75% / 60% / 60% / 40% 可播）。
        //
        // 清单由 gradle 的 copyDefaultSources 拷进 assets（preBuild 依赖），所以这里
        // 在几种可能的工作目录下都找一遍；找不到时必须让用例失败，不能 return 装作通过
        // —— 那会让「默认源选择」这条最关键的产品行为长期零覆盖。
        val candidates = listOf(
            java.io.File("src/main/assets/default-sources.json"),
            java.io.File("app/src/main/assets/default-sources.json"),
            java.io.File("apps/androidtv/app/src/main/assets/default-sources.json"),
        )
        val file = candidates.firstOrNull { it.isFile }
            ?: org.junit.Assert.fail(
                "找不到 default-sources.json，已尝试：" + candidates.joinToString("、") { it.absolutePath }
            ) as java.io.File
        val text = file.readText()
        assertEquals(
            setOf("builtin_live_2", "builtin_live_3", "builtin_live_4", "builtin_live_5"),
            Defaults.defaultLiveSelectedKeysFrom(text),
        )
        assertEquals(
            setOf("builtin_live_0", "builtin_live_1", "builtin_live_6", "builtin_live_7"),
            Defaults.defaultLiveDisabledKeysFrom(text),
        )
    }
}
