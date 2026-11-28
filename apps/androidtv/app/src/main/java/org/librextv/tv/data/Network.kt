package org.librextv.tv.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * 判断当前网络是否适合做「非必要的大流量后台任务」。
 *
 * 目前只有种子表的在线更新用它：整表 1.9MB，用移动网络替用户花流量不合适。
 * 电视盒子绝大多数常连 Wi-Fi，这条限制几乎不影响覆盖率；用手机版时不至于
 * 一开 App 就吃掉几十兆。
 */
object Network {

    /**
     * 是否是「不计流量」的网络（Wi-Fi / 以太网）。
     *
     * 拿不到网络信息时**返回 true**：宁可让更新跑一次，也不要因为某个系统版本
     * 上 `NetworkCapabilities` 为空就永久不更新——更新失败本身是静默可恢复的。
     */
    fun isUnmetered(context: Context): Boolean = runCatching {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return true
        val network = cm.activeNetwork ?: return true
        val caps = cm.getNetworkCapabilities(network) ?: return true
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return true
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return true
        // 明确是移动网络才拦；VPN 等其它传输方式放行
        !caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
    }.getOrDefault(true)
}
