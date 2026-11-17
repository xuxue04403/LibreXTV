# 1.3.12 发布说明

本版解决一个很影响观感的问题：**连续快进时会被误判成「源卡死」，明明还能播却被自动换源**。根因不在网络，而在卡死判据本身——原来「12 秒没有播放进展」就直接换源，而快进时 hls 会丢弃在途分片重新请求，播放位置一直在跳、缓冲一直没涨，正好落进这条判据。

修完看门狗之后对全仓库做了第二轮复核审计（core 6 条、桌面端 7 条、Android 12 条、鸿蒙 8 条），一并修掉后重建四端产物。桌面端、电视版、手机版、鸿蒙版都升到 1.3.12。

## 快进不再误换源

判据从「一段时间没进展」改成**「确认真的加载不出来」**，四层保护：

| 层 | 位置 | 行为 |
| --- | --- | --- |
| 提示 | `packages/core/src/stall-watchdog.ts` | 12 秒无进展只显示「网络较慢，仍在缓冲…」，**不换源** |
| 换源 | 同上 | 45 秒仍然零进展才换源（原来是 12 秒） |
| 排除 | 同上 | 暂停中、跳转中一律不计时；播放位置或缓冲末尾有增长就重新计时 |
| 兜底 | 桌面端 `Watch.tsx` | 跳转后 60 秒一直没有数据才换（`SEEK_FATAL_MS`），与「普通卡死」分开计时 |

判定逻辑抽成了纯函数 `nextStallState(state, sample, options)`（`StallVerdict = 'reset' | 'wait' | 'hint' | 'fatal'`），配 9 条单测，其中一条是「连续快进 12 次、每次跳 30 秒，中间零缓冲增长，永远不 fatal」。

配套三处：

- **hls 错误不再一律当源失效**：`INTERNAL_ABORTED`（跳转时丢弃在途分片）直接忽略；网络错误先在原地 `startLoad()` 续传，每集给 2 次配额，**跳转期间不消耗配额**——否则连续快进几次就把配额用光，真的网络抖动时反而直接换源。
- **拖动进度条不再逐帧 seek**：原来每个 `mousemove` 都写一次 `video.currentTime`，一次拖拽发起几十次 seek、每次都丢弃在途请求，松手后要等一串刚中止的请求，这才是「拖完像卡死」的直接来源。改成拖动中只更新界面上的草稿位置，松手 seek 一次。
- **换源后保留播放位置**：Android 换源原来从 0:00 重播，还会把 0 附近的位置写进历史、覆盖正确续播点。现在记住「集号 + 毫秒」，同集续用。

### Android 电视版 / 手机版

媒体3 的 `ExoPlayer` 没有公开 `isSeeking`，改用位置跳变判定：一秒最多 2 倍速，位置跳变超过 2500 ms 就认为用户在拖拽。判据变成「缓冲中 + 未在播 + 位置没跳变 + 缓冲没增长」持续 **30 秒**（原来 15 秒且只看 `isBuffering`），另外补了 `playWhenReady`，用户暂停或切后台不再累加。

顺带修掉两个换源相关的老问题：卡死计数不随换源/换集重置（新源 prepare 后 1~2 秒又凑满阈值，把好源也换掉）、错误面板「下一集」不清空已试列表（新一集第一次出错就报「已试完所有片源」）。

### 鸿蒙版

鸿蒙端原来根本没监听 `bufferingUpdate`，`buffering` 起播后永远是 false，卡死计数从不累加。现在由 `BUFFERING_START` / `BUFFERING_END` 驱动，补了代际守卫（连点选集时旧播放器的事件不会写到新实例）、每个换源候选 8 秒死线、进度落盘改成 5 秒墙钟节流。

## 第二轮审计修复

完整清单（含行号与判据）在 `docs/audit-2026-11.md`「第二轮」一节，共 26 条。这里只挑最要紧的：

- **core**：换源时把「庆余年第二季」当成「庆余年」（新增 `isSameShow`：季数必须一致、紧邻数字视为续集、先剥掉括号注释与年份）；两份裸数组订阅的源 key 都是 `sub_0`；采集地址自带 `?key=` 时索引请求 URL 拼坏；`onChunk` 抛错不取消底层流；分类表在途请求绑定了首个调用者的 signal（先到者被取消后，后来者拿到正在取消的 promise 且失败被缓存 10 分钟）；主动取消被记成「请求超时 408」。
- **桌面端**：并发直播流共用同一个 streamId（启用多个直播源时，除第一个源外频道列表全是第一个源的内容）；播放错误面板的两个按钮 `pointer-events` 用不了（点不动）；搜索结果页「重试失败源」用错关键词；双击进度条会切窗口全屏；索引写盘失败仍标「已写」，导致每次启动重新预热；同一 `AbortController` 反复使用时 abort 监听线性累积。
- **Android**：目录落盘 500 ms 合并窗口丢最后一次变更（改用显式标志位 + 循环取最新快照）。
- **鸿蒙**：搜索无请求序号（先发的后返回会覆盖新词结果）；进度写进旧源/旧集；切台后收藏的是上一个频道；`SEARCH_TIMEOUT_MS` 声明了但没用。

## 验证

- `npm test`：**23 文件 / 441 用例**全过（1.3.11 为 21 文件 / 364 用例）。新增覆盖：卡死判定 9 条、`isSameShow` 5 条、订阅 key 2 条、HTTP 取消/取消流 3 条、分类表不绑 signal 1 条、索引 URL 拼参 1 条等。
- `npm run typecheck`、`npm run lint` 无告警。
- 桌面端 `npm run build:desktop` / `npm run dist:desktop` 通过（渲染层 `index-D745F5Of.js` 2,276.47 kB、`index-cELoDAUO.css` 26.67 kB）。
- Android：`assembleTvRelease` / `assemblePhoneRelease` 通过；`testTvDebugUnitTest` 22 套 / 168 例、`testPhoneDebugUnitTest` 19 套 / 156 例全过。
- 鸿蒙：`pwsh -File tools/harmony/build.ps1` → BUILD SUCCESSFUL（仅 ArkTS 告警：`getContext` deprecated、`media` 系统能力提示）。

## 四端版本

| 端 | 版本 | 产物 |
| --- | --- | --- |
| 桌面端（Electron） | 1.3.11 → **1.3.12** | `apps/desktop/release/LibreXTV-Setup-1.3.12-x64.exe`（另有 Portable 版） |
| Android 电视版 | versionCode 20 → **21** | `apps/androidtv/release/LibreXTV-TV-1.3.12.apk` |
| Android 手机版 | versionCode 20 → **21** | `apps/androidtv/release/LibreXTV-Phone-1.3.12.apk` |
| 鸿蒙手机版 | versionCode 5 → **6** | `apps/harmonyos/release/LibreXTV-Harmony-1.3.12.hap` |

产物实测包信息（不是抄配置，是读包）：

- TV：`org.librextv.tv` / `versionCode 21` / `versionName 1.3.12`，应用名「LibreXTV」，2,834,417 字节。
- 手机：`org.librextv.tv.phone` / `versionCode 21` / `versionName 1.3.12`，应用名「LibreXTV 手机版」，2,834,202 字节。
- 鸿蒙：`org.librextv.harmony` / `versionCode 6` / `versionName 1.3.12`，810,523 字节。

## 已知限制

- **换源比以前慢**：45 秒零进展才换源是刻意的取舍——慢速网络下会多等一会儿，先出现「网络较慢，仍在缓冲…」提示。真要立刻换源，播放页的「换一个片源」按钮随时可用。
- 卡死判定依赖播放器上报的位置与缓冲：某些 CDN 会在缓冲末尾「虚报」一大段（返回的时长比实际可播的多），此时「缓冲有增长」会让计时重置，退化成等 hls 自己报错，而不是靠看门狗兜底。
- 鸿蒙 HAP 仍用 OpenHarmony 测试根证书自签，HarmonyOS 5/NEXT 真机不认这个链，`hdc install` 会报 `not trusted app source`。要用华为 AGC 签发的调试证书重签：备好 `.cer` / `.p7b` / `.p12` + 别名与密码后跑 `pwsh -File tools/harmony/use-huawei-signing.ps1`。
- 分类浏览的 15 秒是**总预算**不是每源预算，慢源会被跳过，结果数比不限时少；页面会显示「已跳过」的原因。
- 直播源可播率受网络与源站影响，客户端 15 秒无画面会提示并可换台。
