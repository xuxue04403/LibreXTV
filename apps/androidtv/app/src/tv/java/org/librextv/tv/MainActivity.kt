package org.librextv.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import org.librextv.tv.cast.CastRuntime
import org.librextv.tv.data.Pinyin
import org.librextv.tv.data.SeedTitles
import org.librextv.tv.cast.DlnaServer
import org.librextv.tv.ui.LibreXtvApp
import org.librextv.tv.ui.theme.LibreXtvTheme
import org.librextv.tv.ui.theme.TvScaleSurface

class MainActivity : ComponentActivity() {
    private var dlna: DlnaServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installPinyinTable()
        installSeedTitles()
        startCastReceiver()


        setContent {
            LibreXtvTheme {
                // 不同电视上报的 densityDpi 差异很大（720p 盒子常报 160/213），
                // 不归一化就会「不随分辨率缩放」，这里统一拉回 960×540dp 设计基准
                TvScaleSurface {
                    val vm: AppViewModel = viewModel()
                    LibreXtvApp(vm)
                }
            }
        }
    }

    /**
     * 载入拼音首字母表（21KB 文本）与多音字备选表（约 2KB）。
     *
     * 遥控器输中文很痛苦，有了它用户敲 `qmmk` 就能搜「奇妙萌可」。
     * 备选表让「重庆」也能被 `cq` 命中（主表只有 z）。
     * 读失败只影响拼音检索，普通搜索照常可用，所以整段吞掉异常。
     */
    private fun installPinyinTable() {
        runCatching {
            assets.open("pinyin-table.txt").bufferedReader().use { Pinyin.install(it.readText()) }
        }
        runCatching {
            assets.open("pinyin-alts.txt").bufferedReader().use { Pinyin.installAlts(it.readText()) }
        }
    }

    /**
     * 载入内置的「拼音首字母 → 中文片名」种子表。
     *
     * 采集站只支持 `LIKE '%中文%'`，拼音检索只能本地做，而本地索引只装得下用户
     * 扫过的那些页（实测 1209 条 / 全站 150 万条 = 0.08%）。种子表把约 10 万个
     * 真实片名打进 APK，敲 `qmmk` 才能真的找到「奇妙萌可」。
     *
     * 后台线程加载，不阻塞首屏；文件缺失时保持未就绪，搜索退化成只用本地索引。
     */
    private fun installSeedTitles() {
        SeedTitles.install(applicationContext)
    }

    /** 启动 DLNA 接收端：让手机投屏列表里出现本机 */
    private fun startCastReceiver() {
        runCatching {
            dlna = DlnaServer.start(applicationContext) { url, title ->
                CastRuntime.onIncoming(url, title)
            }.also { server ->
                CastRuntime.running = server.running
                CastRuntime.address = server.address
                CastRuntime.error = null
            }
        }.onFailure {
            CastRuntime.running = false
            CastRuntime.error = it.message ?: "DLNA 启动失败"
        }
    }

    override fun onDestroy() {
        dlna?.stop()
        dlna = null
        CastRuntime.running = false
        super.onDestroy()
    }
}
