# 1.3.13 发布说明

本版只做一件事：**修掉电视版「看完直播退出后，焦点跳到首页」**。

## 现象

电视版在直播播放页按「返回」退出，画面回到直播频道列表，但遥控器的焦点不在列表里——它落到了顶栏的「首页」上，而且往往会连带把页面**直接切到首页**，用户得重新进一次直播。

## 根因

返回目标本身没错。`app/src/main/java/org/librextv/tv/NavBack.kt` 里 `Screen.LivePlayer` 的返回目标就是 `Screen.Live`。问题出在回到列表页之后**没人接住焦点**，四步：

1. 直播播放页是整屏界面，顶掉了「顶栏 + 内容区」。它的根 `Box` 是当时的焦点持有者（`LiveScreen.kt` 里 `LaunchedEffect(Unit) { focusRequester.requestFocus() }`）。
2. 退出时这个根 `Box` 被移出组合，Compose 随即清空焦点，画面回到直播列表。
3. 直播列表页里**一个 `FocusRequester` 都没有**。对着全仓 `requestFocus` 逐个点名可以确认：首页、搜索、分类、详情、聚合播放、设置页都有自己的首焦点逻辑（`rememberAutoFocusState` + 重试 `requestFocus`），只有 `LiveScreen` 没有——它是唯一不认领焦点的主页级页面。
4. 于是第一次按方向键时，焦点落到整棵树里第一个可聚焦节点：顶栏的「首页」卡片。而顶栏的设计是「**焦点移上去就切页**」（`CastScreen.kt` 中 `onFocusChange` 里 `if (focused) { onFocusEnter(); if (!active) onSelect(item.screen) }`）。当前页是直播、首页不是 active，于是 `vm.go(Screen.Home)`，页面被直接切走。

一句话：不是导航错了，是**焦点无人认领**，被顶栏抢走，而顶栏「焦点即切页」把「焦点被抢」放大成了「页面被切」。

## 修法

三处改动，都在 Android 端：

- `apps/androidtv/app/src/tv/java/org/librextv/tv/ui/LiveScreen.kt`：给列表页补首焦点，写法与首页一致（`rememberAutoFocusState(vm.contentFocusTick)` 决定这次要不要抢，`FocusPolicy` 保证焦点在导航栏里时不抢，否则 ↓ 走不到导航第二项）。给 `LazyVerticalGrid` 挂 `state`，先 `scrollToItem` 再 `requestFocus`，最多重试 4 次、每次间隔 80 ms——第一次组合时目标节点可能还没放置，`requestFocus` 会抛，不重试就等于没认领。另外用 `focusClaimed` 标记，保证**只在进入本页这一次**认领：之后切分组、列表从空变满都不再抢，否则用户刚把焦点移走就会被拽回来。
- `apps/androidtv/app/src/main/java/org/librextv/tv/data/LiveSwitch.kt`：新增纯函数 `liveFocusIndex(list, lastUrl)`——「刚看的那台」在当前可见列表里就返回它的下标，不在（换了分组、被关键词过滤掉）就退回第一台，空列表返回 -1。
- `apps/androidtv/app/src/main/java/org/librextv/tv/AppViewModel.kt`：新增 `liveFocusUrl`（`private set`）与 `rememberLiveChannel(url)`，由播放页在 `LaunchedEffect(current.url)` 里写一次。这样退出后焦点回到**刚看的那台**，而不是列表第一台——换台之后尤其明显。

顺带说明：没有去动顶栏「焦点移上去就切页」这条交互。它在首页/搜索/设置下都是好用的（焦点一移上去就预览该页），这次能出问题是因为列表页没认领焦点；补上认领，它就不会被误触发。

## 验证

- `.\gradlew.bat :app:compileTvDebugKotlin` BUILD SUCCESSFUL。
- `.\gradlew.bat testTvDebugUnitTest testPhoneDebugUnitTest` BUILD SUCCESSFUL：**TV 23 套 / 172 例**、手机 **19 套 / 159 例**，0 失败 0 跳过（1.3.12 为 22 套 / 168 例、19 套 / 156 例）。
- 新增 4 条回归：
  - `LiveSwitchTest` 3 条：焦点回到刚看的那台（下标 2）、那台不在列表时退回第一台（含 `null`）、空列表 -1。
  - `LiveReturnFocusUiTest` 1 条：用**真实的 `NavRail`** 复现「播放页被移除、整屏换回列表」，断言焦点从播放页移到频道卡、且导航栏没有被触发切页（`selected` 仍为 null）。
- 这条 UI 用例特意反证过它不是「永远通过」：把认领焦点的三行临时改成 `return@LaunchedEffect`，用例在 `assertIsFocused` 处失败；恢复后通过。

## 四端版本

| 端 | 版本 | 产物 |
| --- | --- | --- |
| 桌面端（Electron） | 1.3.12 → **1.3.13** | `apps/desktop/release/LibreXTV-Setup-1.3.13-x64.exe`（另有 Portable 版） |
| Android 电视版 | versionCode 21 → **22** | `apps/androidtv/release/LibreXTV-TV-1.3.13.apk` |
| Android 手机版 | versionCode 21 → **22** | `apps/androidtv/release/LibreXTV-Phone-1.3.13.apk` |
| 鸿蒙手机版 | versionCode 6 → **7** | `apps/harmonyos/release/LibreXTV-Harmony-1.3.13.hap` |

桌面端、手机版、鸿蒙版本版没有功能改动，只是跟随版本号重建，保证四端产物一致。

产物实测包信息（读包，不是抄配置）：

- TV：`org.librextv.tv` / `versionCode 22` / `versionName 1.3.13`，应用名「LibreXTV」，2,834,422 字节。
- 手机：`org.librextv.tv.phone` / `versionCode 22` / `versionName 1.3.13`，应用名「LibreXTV 手机版」，2,834,197 字节。
- 鸿蒙：`org.librextv.harmony` / `versionCode 7` / `versionName 1.3.13`，810,522 字节。
- 桌面：`LibreXTV.exe` 的 FileVersion 1.3.13；安装版 80,726,619 字节、便携版 80,495,579 字节。

## 已知限制

- 「退出后焦点停在刚看的那台」的手感只能真机确认：模拟器/单元测试能证明焦点落点与「不触发导航切页」，但遥控器连按、盒子输入延迟导致的实际观感需要你在设备上试。
- 直播列表页的首焦点是**一次性**的：进入页面时认领，之后不再抢。如果你在列表里把焦点移到导航栏、再按返回键回到列表，焦点会留在导航栏（这是 `FocusPolicy` 的既有行为，与首页、搜索一致）。
- 其余限制延续 1.3.12（鸿蒙 HAP 用 OpenHarmony 测试根证书自签，真机需用华为 AGC 证书重签；分类浏览 15 秒是总预算；直播源可播率受网络与源站影响）。
