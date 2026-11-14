# LibreXTV PC / Android TV / Android 手机 / 鸿蒙 客户端

基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的**桌面端（Windows / macOS / Linux）**、**Android TV**、**Android 手机**与**鸿蒙原生（HarmonyOS NEXT）**客户端。把上游 Next.js 服务端的采集聚合、解析与代理逻辑全部下放到客户端运行：**不需要部署服务器、不需要访问密码**，装好即用。

![桌面端首页](docs/images/desktop-home.png)

## 做了什么

上游 LibreTV 是一套「Next.js 服务端聚合 + 网页播放器」的影视聚合站：搜索、详情、代理、鉴权都在 `/api/*` 里，前端只是壳。本项目把这一层拆开重做：

| 上游服务端能力 | 本项目做法 |
| --- | --- |
| `/api/search` 多源并行聚合 | `packages/core` 纯函数，桌面端由主进程直连、TV 端由 OkHttp 直连 |
| `/api/detail` 详情 + 详情页兜底 | 同上，逻辑逐行移植并加了单测 |
| `/api/proxy`、`/api/live/stream` 反代 | 桌面端在主进程内起**仅监听 127.0.0.1 的媒体代理**（随机端口 + token）；TV 端 ExoPlayer 无 CORS，不需要 |
| `/api/auth` 密码 + 会话 | 删除：本地客户端没有服务端，也就没有鉴权面 |
| `/api/status`、`DEFAULT_*` 环境变量 | 改为应用内「设置 / 数据源订阅」 |
| IndexedDB 播放进度 | 桌面 localStorage（zustand）、TV DataStore |

桌面与 Android 共享同一套解析语义，但各有原生播放内核与交互：桌面用 Electron + hls.js / mpegts.js，Android 用 Kotlin + Media3 ExoPlayer + Compose，鸿蒙用 ArkTS + AVPlayer。

**四种形态**

| 形态 | 技术栈 | 包名 / 产物 | 适用设备 |
| --- | --- | --- | --- |
| 桌面端 | Electron + React + hls.js | `LibreXTV-Setup-*.exe` / dmg / AppImage | Windows / macOS / Linux |
| Android TV | Kotlin + Compose + Media3 | `org.librextv.tv`，`app-tv-release.apk` | 电视盒子、智能电视 |
| Android 手机 | 同电视版，独立 flavor 与竖屏 UI | `org.librextv.tv.phone`，`app-phone-release.apk` | Android 手机/平板；**HarmonyOS 4.x 及更早的华为手机也能直接装** |
| 鸿蒙原生 | ArkTS + ArkUI + AVPlayer | `org.librextv.harmony`，`entry-default-signed.hap` | **HarmonyOS 5 / NEXT**（纯血鸿蒙，不兼容 APK） |

Android 电视版与手机版共用同一份 `data/` 层、`AppViewModel`、投屏（DLNA）与主题，只有界面、入口 Activity 与 Manifest 按 product flavor 分开——所以两边的源管理、换源、续播、拼音检索行为完全一致。鸿蒙版是独立重写的原生工程，逻辑逐条移植但代码不复用。

## 功能

| 能力 | 桌面端 | Android TV |
| --- | --- | --- |
| **首页分类入口**（电影 / 电视剧 / 少儿 / 综艺 / 动漫 / 纪录片 / 短剧 / 体育） | ✅ 自动隐藏无内容的分类 | ✅ 同左，且焦点移上去即切换并加载（不用按 OK） |
| **分类结果缓存**（切回上一个分类立刻出内容） | ✅ 内存 5 分钟 + 落盘 6 小时 | ✅ 同左 |
| **分类边收边渲染**（首个源回来就出画面，不等全部源） | ✅ 实测约 0.8 秒 | ✅ 同左 |
| **启动预热与每小时刷新**（后台把各分类第一页抓进缓存） | ✅ | ✅ |
| **检索结果缓存**（同片名再搜先出缓存） | ✅ 落盘 30 分钟 | ✅ 同左 |
| **拼音首字母搜索**（qmmk → 奇妙萌可） | — | ✅ 本地索引 + 各源最新列表 |
| **播放列表广告过滤**（摘掉中插广告段） | ✅ | ✅ |
| **左侧导航焦点即切页**（遥控器划过去就换页） | — | ✅ |
| **首页横幅** | 已移除（保留完整信息流） | 152dp 两栏 |
| 聚合搜索（多源并行、结果流式出现） | ✅ | ✅ |
| 同名影片跨源聚合 + 详情内换源 | ✅ | ✅ |
| **播放失败自动换源**（本集重试 2 次 → 切候选源 → 按片名补源） | ✅ 也可按 `S` 手动换 | ✅ 遥控器 `Menu` 键 |
| **播放性能调优**（代理分片流式直通、hls.js/ExoPlayer 缓冲参数、卡顿看门狗） | ✅ | ✅ |
| **点播即预取**（点击播放就把开头 8 个分片抓进内存，起播少一跳 RTT） | ✅ | ✅ |
| HLS / MP4 播放、倍速、快捷键 | ✅ | ✅ 遥控器方向键 |
| **分片完整性**（上游 gzip 时不再截断分片，消除偶发花屏/噪点） | ✅ | ✅ 不经过代理，无此问题 |
| 广告分片过滤（m3u8 `adjump` / 超短片头段） | ✅ | ✅ `AdFilteringPlaylistParserFactory` |
| 直播 / IPTV（M3U、分组、收藏） | ✅ | ✅ |
| **直播列表渐进加载**（缓存优先 + 边下边解析边显示，万级频道首屏 < 1.5 秒） | ✅ | ✅ |
| **直播起播优化**（落后 1 个切片起播、上游无响应 12 秒死线、直播不走分片缓存） | ✅ | ✅ |
| **直播换台** | ✅ `↑ / ↓` 换台、`M` 静音、`Esc` 退出 | ✅ 遥控器 `↑ / ↓ / ← / →`、`CH+ / CH-` |
| 观看进度续播 / 历史 / 收藏 | ✅ 同一片子跨源只留一条记录（同名不同年份不合并）| ✅ 同左 |
| 数据源管理、订阅导入（LibreTV-SourceList / TVBOX）、导入导出 | ✅ | ✅ |
| **投屏** | ✅ DLNA **发送端**（把影片推到电视/盒子） | ✅ DLNA **接收端**（手机投到电视） |
| 内置默认源（点播 13 个 + 直播 7 个） | ✅ 首次启动导入，可删除/恢复 | ✅ 同左（同一份 `defaults/sources.json`） |
| **直播默认启用 4 个国内实测可播的源**（vbskycn 73%~78% / zhi35 55%~60% / best-fan 57%~60% / Collect-IPTV 40%~43%；iptv-org 两条与 Guovin 默认不勾） | ✅ 设置里一键打开 | ✅ 同左 |
| **内置源清单可升级**（`version` 递增时自动补齐缺的源，删过的不复活） | ✅ | ✅ |

### 桌面端

首页顶部就是分类入口（电影 / 电视剧 / 少儿 / 综艺 / 动漫 / 纪录片 / 短剧 / 体育），点进去直接按源站分类浏览，无需先想片名：

![分类浏览](docs/images/desktop-category.png)

搜索 → 详情 → 播放全程键盘可操作（`Ctrl+F` 搜索、空格暂停、`←→` 快退快进、`F` 全屏、`M` 静音、`N` 下一集、`Esc` 返回）：

| 搜索 | 详情 |
| --- | --- |
| ![搜索](docs/images/desktop-search.png) | ![详情](docs/images/desktop-detail.png) |

| 播放 | 直播 |
| --- | --- |
| ![播放](docs/images/desktop-player.png) | ![直播](docs/images/desktop-live.png) |

投屏面板会自动 SSDP 搜索局域网内的 DLNA 渲染设备：

![投屏](docs/images/desktop-cast.png)

### Android TV

- 十尺屏排版（正文 15–16sp、卡片聚焦放大 + 橙色描边），遥控器 D-pad 全程可达
- **按分辨率自适应缩放**：以 960×540dp 为设计基准，按实际逻辑宽高取 `min(w/960, h/540)` 缩放整套 dp/sp。廉价 4K 盒子把 `densityDpi` 误报成 160（逻辑宽度 3840dp）时，界面会等比放大 4 倍，而不是缩在左上角
- 首页横幅左右两栏（152dp 高），首屏即可同时看到横幅与分类入口，不用先滚一屏
- 首页分类入口只显示**真正有内容**的分类（探测结果落 DataStore，冷启动不闪烁）
- 播放页把操作映射到遥控器：`OK` 播放/暂停、`←→` 快退/快进 10s、`↑` 选集、`返回` 退出
- 直播播放中 `↑ / ↓`（含 `← / →`、`CH+ / CH-`）直接换台，在当前分组/搜索结果内循环
- 作为 **DLNA 接收端（DMR）** 常驻：手机视频 App 的投屏列表里出现「LibreXTV 电视」，选中即在电视播放
- 开机横幅、Leanback 启动器、`android.software.leanback` 声明齐全

### Android 手机版

和电视版同一套代码、独立 flavor（包名 `org.librextv.tv.phone`，可与电视版同机共存），界面为竖屏触摸重做：

- 底部四栏导航（首页 / 搜索 / 直播 / 设置），返回键走与电视版相同的 `NavStack` 语义
- 竖屏固定：清单锁 `portrait`，进播放页（点播/直播/投屏）自动切横屏全屏，退出即复位竖屏
- 首页：继续观看（进度条 + 集数）、分类入口、各分类横向片单、我的收藏、直播收藏、本机数据概览
- 搜索：软键盘回车即搜，结果双列网格，各源结算情况用 Chip 横滑展示
- 详情：海报 + 简介 + 同片其它源切换 + 四列选集网格，续播按钮显示「继续播放 · 第 N 集」
- 播放器：点击唤出/隐藏控件、进度条拖动（拖到片尾前 1 秒自动夹住，避免误触自动连播）、倍速、选集浮层；播放失败或卡顿 15 秒自动换源
- 直播：分组与台名筛选、双列频道网格、收藏；播放页整屏复用同一个 `ExoPlayer` 切台（避免耗尽 MediaCodec 池）
- 设置：源管理、订阅导入、四个播放开关、清空历史、投屏接收状态

### 鸿蒙原生版

`apps/harmonyos` 是独立的 ArkTS/ArkUI 工程（**HarmonyOS 5/NEXT 不再兼容 APK，必须有这一版**），逻辑从 `packages/core` 与 Kotlin 层逐条移植：

- `ets/data/`：HTTP（`@ohos.net.http`）、Apple CMS 搜索/详情解析、相关性与同名聚合、成人过滤、M3U 解析、内置源合并与本地存储（`preferences`）
- `ets/pages/`：首页 / 搜索 / 详情 / 直播 / 设置 / 播放 / 直播播放七个页面，配色与桌面、电视端保持一致
- 播放器用 `AVPlayer` + `XComponent`（Surface 输出），同样有 15~20 秒卡顿看门狗与自动换源
- 全应用靠 `AppStorage` 的 `vmVersion` 版本号驱动重绘，单例 `appModel` 持有全部状态

## 仓库结构

```
defaults/sources.json        内置默认源（四个端共用同一份）
packages/core/               共享 TS 核心：解析 / 聚合 / 订阅 / 存储模型 / 增量解析 / 分类与检索缓存（290 项单测）
apps/desktop/                Electron 桌面端（main / preload / renderer）
apps/androidtv/              Android 电视版（flavor tv）+ 手机版（flavor phone），Kotlin + Compose + Media3 + 自研 DLNA DMR
apps/harmonyos/              鸿蒙原生版（ArkTS + ArkUI + AVPlayer）
tools/mock-cms/              本地假采集站（端到端联调 + 截图）
tools/mock-dlna/             假 DLNA 渲染器（投屏链路测试）
tools/harmony/               鸿蒙签名材料生成与构建脚本
reference/LibreTV/           上游源码只读快照（2.19.7），见 reference/UPSTREAM.md
docs/                        分析与架构文档
```

## 快速开始

### 桌面端

```bash
npm install
npm run dev:desktop      # 开发模式（Electron + Vite HMR）
npm run build:desktop    # 产物构建到 apps/desktop/out
npm run dist:desktop     # 打包安装包（NSIS / portable / dmg / AppImage）
```

> Linux/macOS 上打包目标会自动切换；Windows 上默认产出 `release/LibreXTV-*.exe`。
> 首次启动会自动导入 `defaults/sources.json` 里的默认源，可在「设置 → 点播源 / 直播源」里停用或删除，也可随时「恢复默认源」。
> 内置源清单带版本号：升级到带新内置源的版本时，会自动补齐**你本地没有的**那些源；你删掉过的内置源不会被偷偷加回来。

### Android 电视版 / 手机版

```bash
cd apps/androidtv
# 需 JDK 17–21、Android SDK 35；Gradle 版本由仓库自带的 wrapper 决定（8.13），不必本机安装
./gradlew assembleTvDebug       # 电视版；Windows：gradlew.bat assembleTvDebug
./gradlew assemblePhoneRelease  # 手机版（需 keystore.properties 里的签名配置）
adb connect <电视IP>:5555       # 电视开启「网络调试」
adb install -r app/build/outputs/apk/tv/debug/app-tv-debug.apk
```

产物：电视版 `apps/androidtv/app/build/outputs/apk/tv/*/app-tv-*.apk`（debug 包名带 `.debug` 后缀），手机版 `apps/androidtv/app/build/outputs/apk/phone/release/app-phone-release.apk`（约 2.8 MB，包名 `org.librextv.tv.phone`，可与电视版同机共存）。分发用的改名副本放在 `apps/androidtv/release/`。

### 鸿蒙原生版

```bash
pwsh -File tools/harmony/gen-signing.ps1                                  # 首次：生成本地签名材料（换包名要重跑）
pwsh -File tools/harmony/build.ps1                                        # 构建 HAP
```

产物：`apps/harmonyos/entry/build/default/outputs/default/entry-default-signed.hap`（约 340 KB），构建脚本会同时按版本号复制一份到 `apps/harmonyos/release/LibreXTV-Harmony-<版本>.hap` 用于分发。工具链装配（SDK 拍平、hvigor 手工安装、三处 SDK 补丁）与真机安装步骤见 [docs/build.md](docs/build.md#鸿蒙原生版harmonyos-next)。

### 测试

```bash
npm test                     # 核心解析/聚合/换源/增量解析 + 桌面代理 364 项单测
npm run test:dlna            # DLNA 发送端链路（SSDP → 设备描述 → SOAP）
cd apps/androidtv && ./gradlew testTvDebugUnitTest testPhoneDebugUnitTest
# 电视版 168 项（含首焦点与遥控器） + 手机版 156 项（不含仅电视适用的焦点测试）
```

电视端的焦点与遥控器行为用 Robolectric 在 JVM 上跑真实 Compose 组合（`app/src/testTv/.../ui/AutoFocusUiTest.kt`），不需要真机或模拟器。CI 配置在 `.github/workflows/ci.yml`，同时跑桌面端与两个 Android flavor 三套测试。

端到端联调（本地假采集站 + 真实 HLS 视频）：见 [docs/build.md](docs/build.md#端到端联调)。

TV 端没有真机也能验：普通 `system-images;android-35;default;x86_64` 镜像 + `-d tv_1080p` 建出来的 AVD 能正常拉起 leanback Activity、D-pad 可用（`android-tv` 镜像下载失败时的替代方案，细节见 [docs/architecture.md](docs/architecture.md#本机验证-tv-端的方法)）。

真机验证脚本都在 `tools/e2e/`（CDP 驱动，桌面端需以 `--remote-debugging-port=9333` 启动）：

- `failover.mjs`：搜索 → 起播 → 按 `S` 手动换源 → 屏蔽当前 CDN 域名，确认播放器自动切到别的源并继续播放。
- `live.mjs`：记录直播列表从首次上屏到加载完成的频道数时间线 → 挑一个能播的频道起播 → 按 `↓` / `↑` 换台并确认台名变化。
- `resize.mjs`：用 CDP 覆盖视口宽度，量 `.field` 是否被压到横向滚动、`.hero` 高度、页面是否横向溢出（PC 最小窗口 1024×640 的布局回归）。
- `watch-categories.mjs`：冷启动后每 25ms 采样分类栏，只打印变化，用来抓「先显示 8 个、几秒后收敛」过程中的错误中间态。

## 关于内置源与内容

- 内置的点播源是**第三方公开 Apple CMS 接口**（非凡 / 量子 / 魔都 / 360 / 电影天堂 / 极速 / 红牛 / 如意 / 暴风 / 百度 / 金鹰 / 新浪 / 光速），直播源包括 [iptv-org](https://github.com/iptv-org/iptv)、[vbskycn/iptv](https://github.com/vbskycn/iptv)、[zhi35/iptv](https://github.com/zhi35/iptv)、[best-fan/iptv-sources](https://github.com/best-fan/iptv-sources)、[Collect-IPTV](https://github.com/zilong7728/Collect-IPTV) 与 [Guovin/iptv-api](https://github.com/Guovin/iptv-api) 的公开 M3U 列表；它们与本项目**无隶属关系**，仅作为开箱即用的示例。
- 上述清单是 2026-11 在中国移动宽带（未挂代理）下逐条实测挑出来的：13 个点播源里 12 个能完整走完「分类 → 搜索 → 详情 → m3u8 → 分片」全链路，直播源按等距抽 40 个频道的可播率排序。直播死链仍然常见（返回 HTML 错误页、被地区限制），播放页 15 秒内没有画面就明确提示「可能已下线或被地区限制」，直接 `↑`/`↓` 换台即可，不会一直卡在「正在连接…」。
- **默认启用 4 个直播源**（vbskycn 国内 IPv4 / zhi35 央视卫视港澳台 / best-fan 国内全量 / Collect-IPTV 精选，多轮抽测可播率 73%~78% / 55%~60% / 57%~60% / 40%~43%）。iptv-org 全球频道（8%~30%）、iptv-org 中国频道（10%~15%）与 Guovin 央视卫视（18%~23%）仍在列表里、但默认不勾选，设置里点一下就能打开。
- 清单里的 GitHub 托管源一律走 `fastly.jsdelivr.net` / `testingcf.jsdelivr.net` 镜像：国内直连 `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 会被重置，源整份都下不下来。
- 本项目**不存储、不制作、不分发**任何视频内容，只提供第三方公开接口的解析与播放能力；内容的合法性由对应数据源负责。
- 所有源都可以在设置里停用/删除，也可以完全手动添加自己的源或订阅。

## 文档

- [上游分析与「服务端 → 客户端」改造决策](docs/analysis.md)
- [架构设计（进程模型 / 播放链路 / 投屏链路 / 四端分层）](docs/architecture.md)
- [内置播放源体检与换血（2026-11，清单 version 7）](docs/source-audit-2026-11.md)
- [1.3.11 发布说明（首页单行横滚 + 分类加载提速）](docs/release-1.3.11.md)
- [1.3.10 发布说明（手机版竖屏修复）](docs/release-1.3.10.md)
- [1.3.9 发布说明（项目更名为 LibreXTV）](docs/release-1.3.9.md)
- [1.3.8 发布说明（Android 手机版 + 鸿蒙原生版）](docs/release-1.3.8.md)
- [1.3.7 发布说明](docs/release-1.3.7.md)
- [构建、打包与联调指南](docs/build.md)

## 许可证

AGPL-3.0-or-later。上游 LibreTV 同许可，本仓库作为衍生作品同样以 AGPL 发布，详见 [LICENSE](LICENSE)。

应用图标沿用上游 LibreTV 的 artwork（`public/icons/icon-512.png`，AGPL-3.0-or-later）：桌面端侧栏品牌位、窗口/任务栏图标与安装包图标，Android TV 的启动图标与 Leanback 横幅均由这套 artwork 生成。
