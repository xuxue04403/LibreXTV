# 构建、打包与联调

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 20（实测 26） | 桌面端构建、单元测试 |
| npm | ≥ 10 | workspace 依赖管理 |
| JDK | 17–21（实测 21） | Android 构建 |
| Android SDK | platform 35 + build-tools 35 + platform-tools | 编译 APK |
| Gradle | 无需安装 | 仓库自带 wrapper（8.13）会自动下载；也可直接用 Android Studio |
| ffmpeg（可选） | 任意版本 | 生成联调用的 HLS 测试视频 |

## 桌面端

### 安装与开发

```bash
npm install
npm run dev:desktop        # electron-vite dev：主进程/渲染层热更新
```

首次跑 Electron 时 npm 可能因为 `allowScripts` 拦截安装脚本，需要执行一次：

```bash
npm install-scripts approve electron
npm install-scripts approve esbuild
# 若 electron 二进制仍未下载，手动解压缓存包：
node node_modules/electron/install.js
```

其实现代 Electron 的二进制缓存在 `%LOCALAPPDATA%\electron\Cache`，若 `install.js` 只解出部分文件（网络中断导致），可直接解压：

```powershell
Expand-Archive "$env:LOCALAPPDATA\electron\Cache\electron-v33.4.11-win32-x64.zip" -DestinationPath node_modules/electron/dist -Force
Set-Content node_modules/electron/path.txt 'electron.exe' -NoNewline
```

### 构建与打包

```bash
npm run build:desktop     # 产物：apps/desktop/out/{main,preload,renderer}
npm run dist:desktop      # electron-builder → apps/desktop/release
```

打包目标在 `apps/desktop/electron-builder.yml`：

- Windows：NSIS 安装包 + portable
- macOS：dmg + zip
- Linux：AppImage + deb

只验证构建、不下载打包器的做法：

```bash
cd apps/desktop && npx electron-builder --dir
```

### 冒烟与截图（无需人工点击）

主进程内置了冒烟开关，CI 或本地都可以用它验证「启动 → 渲染 → 抓图」：

```powershell
$env:LTV_SMOKE='D:\tmp\home.png'
$env:LTV_SMOKE_SEED='{"state":{...},"version":1}'   # 可选：预置 localStorage
$env:LTV_SMOKE_JS='document.querySelectorAll(".rail-btn")[3]?.click()'  # 可选：截图前执行
$env:LTV_ALLOW_PRIVATE_MEDIA='1'                    # 联调本机媒体源时需要
apps\desktop\node_modules\electron\dist\electron.exe apps\desktop --user-data-dir=D:\tmp\profile
```

> 如果当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`（某些 Electron 宿主环境会设置），必须先清掉，否则 `electron.exe` 会以 Node 模式运行并报 `ipcMain undefined`。打包后的 `LibreXTV.exe` 同样会继承这个变量，症状是 `bad option: --user-data-dir=...` 并直接退出（exit code 9）。

## Android 电视版与手机版

两个形态共用同一套代码（`src/main` 里的 `data/`、`AppViewModel`、`cast/`、`ui/theme/`），只有界面、清单与入口 Activity 按 product flavor 分家：

| flavor | 源码目录 | 包名 | 形态 |
| --- | --- | --- | --- |
| `tv` | `app/src/tv/` | `org.librextv.tv` | 横屏、遥控器焦点导航、Leanback 启动器；可覆盖升级旧版电视端 |
| `phone` | `app/src/phone/` | `org.librextv.tv.phone` | 竖屏（清单锁 `portrait`，播放页动态切横屏）、触摸、底部导航；与电视版同机共存，互不覆盖 |

### 编译

```bash
cd apps/androidtv
export ANDROID_HOME=/path/to/android-sdk     # Windows: $env:ANDROID_HOME='D:\...'
./gradlew assembleTvDebug                          # 电视版；Windows 用 gradlew.bat
./gradlew assemblePhoneDebug                       # 手机版
./gradlew assemblePhoneRelease                     # 手机版 release（需 keystore.properties）
```

产物：

- 电视版 `app/build/outputs/apk/tv/debug/app-tv-debug.apk`（包名带 `.debug` 后缀）、release `apk/tv/release/app-tv-release.apk`；
- 手机版 `app/build/outputs/apk/phone/debug/app-phone-debug.apk`、release `apk/phone/release/app-phone-release.apk`（约 2.8 MB）。

分发用的改名副本放在 `apps/androidtv/release/`（如 `LibreXTV-TV-1.3.9.apk`、`LibreXTV-Phone-1.3.9.apk`），与桌面端 `apps/desktop/release/`、鸿蒙 `apps/harmonyos/release/` 的约定一致。

用 Android Studio 打开 `apps/androidtv` 也可直接运行，在 Build Variants 里选 `tvDebug` 或 `phoneDebug`。

### 安装

```bash
adb connect 192.168.1.20:5555      # 电视需开启「开发者选项 → 网络调试」
adb install -r app/build/outputs/apk/tv/debug/app-tv-debug.apk
adb shell am start -n org.librextv.tv.debug/org.librextv.tv.MainActivity
```

手机版直接装 `app-phone-release.apk` 即可（`adb install -r` 或传到手机点击安装）。也可以把 APK 拷到 U 盘，用电视上的文件管理器安装（需允许「未知来源」）。

**HarmonyOS 4.2 及更早的华为/荣耀手机**基于 AOSP，可直接安装手机版 APK；**HarmonyOS 5/NEXT 及之后的纯血鸿蒙不再兼容 APK**，请用下面的鸿蒙原生版。

### 单元测试

```bash
cd apps/androidtv
./gradlew testTvDebugUnitTest        # 电视版（含 Compose 首焦点/遥控器按键测试）
./gradlew testPhoneDebugUnitTest     # 手机版
```

电视版覆盖 168 项、手机版 156 项（手机版不含仅电视适用的焦点与遥控器测试）：搜索列表解析、分集提取、详情兜底、M3U 属性与分组、相关性/成人过滤、同名聚合、订阅宽容解析、DLNA 请求解析（按字节读 + 上限）、拼音（含多音字备选与相关度）、观看记录去重、分片缓存、默认源选择，以及用 Robolectric 在 JVM 上跑真实 Compose 组合的首焦点/遥控器按键（`tv/java/org/librextv/tv/ui/AutoFocusUiTest.kt`）。

### 常见问题

**Gradle 报 TLS 握手失败**（`Remote host terminated the handshake`）：

- 本仓库已在 `settings.gradle.kts` 里优先使用阿里云镜像、并在 `gradle.properties` 固定 `https.protocols=TLSv1.2`；
- 若仍失败，可设置代理：`systemProp.https.proxyHost` / `systemProp.https.proxyPort`。

**组播权限**：DLNA 依赖 `CHANGE_WIFI_MULTICAST_STATE` 并在运行时持有 `MulticastLock`；部分电视系统（如部分国产 ROM）会限制组播，表现为手机搜不到「LibreXTV 电视」。

**模拟器与真机的差异**：模拟器默认 NAT 网络下 SSDP 组播常不可用，投屏请在真机验证。

**手机版和电视版能同时装吗**：能。两者包名不同（`org.librextv.tv` / `org.librextv.tv.phone`），数据各自独立存储。

## 鸿蒙原生版（HarmonyOS NEXT）

`apps/harmonyos` 是 ArkTS/ArkUI 原生工程，不复用 Kotlin 代码，但移植了同样的采集、解析、相关性过滤、内置源合并与播放逻辑（`entry/src/main/ets/data/`），播放器用 `AVPlayer` + `XComponent` 输出到 Surface。

### 工具链

需要三样东西，都在 `.tools/harmony/` 下（已被 `.gitignore` 忽略，需自行装一次）：

1. **HarmonyOS SDK**（API 26 / 7.0 Beta）：解压 `ohos-sdk-windows_linux-public.tar.gz` 后，把 `ets`、`js`、`native`、`previewer`、`toolchains` 五个组件拍平到
   `.tools/harmony/sdk-7.0/HarmonyOS-NEXT2/openharmony/<组件>/`，且每个组件目录里要有 `oh-uni-package.json`。
   再把 `openharmony` 里的 `ets`/`native`/`previewer` 以目录联接（junction）方式映射到同级 `hms/<组件>`，`hms/toolchains` 复制一份并**删掉其中的 `id_defined.json`**（否则 restool 报 `11211012` 资源重复）。
2. **hvigor 与 hvigor-ohos-plugin**（6.26.2）：npm 源上没有这两个包，需从 command-line-tools 里手工复制到
   `apps/harmonyos/node_modules/@ohos/{hvigor,hvigor-ohos-plugin}`。
3. **SDK 补丁三处**（缺一不可，均在 `sdk-7.0/HarmonyOS-NEXT2/openharmony/` 下）：
   - `ets/build-tools/ets-loader/lib/process_visual.js`：读 `externalconfig.json` 前先判空，否则 `Cannot read properties of undefined (reading 'ets')`；
   - `ets/build-tools/ets-loader/lib/external_component_map.js`：`concatenateEtsOptions` 开头加空值守卫；
   - `toolchains/lib` 里 `hap-sign-tool` 使用的 `libimage_transcoder_shared.dll` 在本 SDK 包中不存在，需把
     `node_modules/@ohos/hvigor-ohos-plugin/src/sdk/info/hos-sdk-info.js` 的 `getLibimageTranscoderShared()` 改为返回空串。

### 签名

真机安装必须签名。仓库里不放私钥，首次构建前跑一次：

```bash
pwsh -File tools/harmony/gen-signing.ps1
```

脚本会做三件事：用 SDK 自带的 `hap-sign-tool.jar` 生成应用密钥对与证书链、签发 profile、按 hvigor 的格式生成密码密文与 `signing/material/` 目录，并写好 `build-profile.json5` 的 `signingConfigs`。产物落在 `apps/harmonyos/signing/`（已 gitignore）。

> 注意：profile 里的 `distribution-certificate` 必须写成 **URL-safe base64**（`+`→`-`、`/`→`_`），否则 `sign-app` 报 `Illegal base64 character 2f`；密码必须 ≥32 字符，否则 hvigor 报 `00303116`。

#### 装到真机：必须换成华为 AGC 签发的材料

`gen-signing.ps1` 生成的是 **OpenHarmony 测试根证书**链（`CN=OpenHarmony Application CA`），只能装在模拟器上。真机（HarmonyOS 5 / NEXT）只信任华为签发的证书，用它签出来的 HAP 装上会报：

```
error: failed to install bundle. code:9568257 error: fail to verify pkcs7 file
```

这条报错不会告诉你是证书的问题，下面这些坑都是实际踩出来的：

1. **包名不能用保留字**。`org.librextv.harmony` 在 AGC 建 APP ID 时会被拒（`harmony` / `ohos` / `oh` / `system` 等不能作为独立段）。当前用的是 `org.librextv.app`。
2. **Profile 类型要选「调试」**。「指定设备发布」仍是发布证书体系，`hdc install` 一样验证失败。
3. **「申请权限」不要勾**。那栏是给受限 ACL 权限（读写通讯录、后台定位等）用的。本项目只用 `ohos.permission.INTERNET` 与 `ohos.permission.GET_NETWORK_INFO`，都是 normal 级，装机自动授予。
4. **`.cer` 必须是证书链**，不能是单张证书。AGC 下载的 `.cer` 里是「根 CA G2 → Developer Relations CA G2 → 你的开发证书」三张；`hap-sign-tool` 缺中间那张就报 `11013004 Profile cert must a cert chain`，我试过「开发证书 + 根 CA」手工拼链，会报 `11013002 verify certificate chain failed! Signature does not match`。
5. **证书必须由本机 `.p12` 的 CSR 申请得到**，否则签名能跑完、装机同样报 `9568257`。签之前用 `compare-pubkey.cjs` 比一下公钥能省掉这轮排查。
6. **Profile 的 `device-ids` 里要有这台设备**，否则装机报签名或 profile 校验失败。

材料齐了之后：

```bash
pwsh -File tools/harmony/use-huawei-signing.ps1 `
  -CertFile    apps/harmonyos/signing/huawei/librextv-app.cer `
  -ProfileFile apps/harmonyos/signing/huawei/librextv-debug.p7b `
  -KeystoreFile apps/harmonyos/signing/huawei/librextv-huawei.p12 `
  -KeyAlias librextv -Password '<密钥库密码>'
pwsh -File tools/harmony/build.ps1 -Mode release
```

`use-huawei-signing.ps1` 四步都会校验：别名存在 → profile 可验签且 bundle-name 与 `AppScope/app.json5` 一致 → **证书公钥与密钥库配对**（这一步是最容易漏的，不配对时装机只给一句 `fail to verify pkcs7 file`）→ 生成 hvigor 的密码密文与 `signing/material/`。

### 编译

```bash
pwsh -File tools/harmony/build.ps1                  # debug HAP
pwsh -File tools/harmony/build.ps1 -Mode release    # release HAP
```

等价的手工命令：

```bash
cd apps/harmonyos
export DEVECO_SDK_HOME=/path/to/.tools/harmony/sdk-7.0    # Windows: $env:DEVECO_SDK_HOME='D:\...'
node node_modules/@ohos/hvigor/bin/hvigor.js assembleHap --no-daemon
```

产物：

- hvigor 原生输出 `apps/harmonyos/entry/build/default/outputs/default/entry-default-signed.hap`（约 340 KB）
- 构建脚本会额外按版本号复制一份到 `apps/harmonyos/release/LibreXTV-Harmony-<版本>.hap`，与桌面端的 `apps/desktop/release/`、Android 的 `apps/androidtv/release/` 对齐，分发时用这份。

### 安装到真机

```bash
pwsh -File tools/harmony/install-hap.ps1                     # 装 release/ 下最新 HAP 并拉起
pwsh -File tools/harmony/install-hap.ps1 -Hap D:\x.hap      # 装指定文件
pwsh -File tools/harmony/install-hap.ps1 -NoLaunch           # 只装不启动
```

等价的手工命令（**必须用 `hms` 目录下那份 hdc**，`openharmony` 目录下的那份会把真机显示成 Unauthorized 或干脆列不出来、只剩两个蓝牙串口）：

```bash
.tools/harmony/sdk-7.0/HarmonyOS-NEXT2/hms/toolchains/hdc.exe list targets
.tools/harmony/sdk-7.0/HarmonyOS-NEXT2/hms/toolchains/hdc.exe -t <设备序列号> install -r apps/harmonyos/release/LibreXTV-Harmony-<版本>.hap
.tools/harmony/sdk-7.0/HarmonyOS-NEXT2/hms/toolchains/hdc.exe -t <设备序列号> shell "aa start -a EntryAbility -b org.librextv.app"
```

手机需在「设置 → 关于手机」连点版本号开启开发者模式，再打开「USB 调试」，插线后手机上会弹「允许调试」，必须点允许。用 AGC 调试证书 + 调试 Profile 签的包只能装在 **Profile 里已登记 UDID** 的设备上（调试证书有效期：实名开发者 1 年，未实名 14 天）；要分发给他人设备，需在 AGC 换成发布证书 + 发布 Profile 并上架应用市场。

### 常见问题

- `fail to verify pkcs7 file`（`9568257`）：证书链不是华为签发的，或证书与本地 `.p12` 不是同一对，或 Profile 没登记这台设备。见上文「装到真机：必须换成华为 AGC 签发的材料」。
- `SDK component missing`：SDK 目录层级不对，必须严格是 `<SDK_HOME>/<平台>/<openharmony|hms>/<组件>`。
- `00303024 / INCONSISTENT_MODEL_VERSION`：`oh-package.json5` 的 `modelVersion` 必须与 `hvigor/hvigor-config.json5` 一致（当前都是 `26.0.0`）；`build-profile.json5` 里**不能**写 `modelVersion`。
- `00303195 Unable to obtain the module information`：`module.json5` 必须是 `{ "module": { ... } }` 包裹结构。
- 改了 `defaults/sources.json` 后记得同步 `apps/harmonyos/entry/src/main/resources/rawfile/default-sources.json`（没有 Gradle 那样的自动复制任务）。

## 端到端联调

仓库自带两个 mock 服务，用于在没有真实片源/电视的情况下验证全链路。

### 1. 假采集站 + 真实 HLS 视频

```bash
# 生成 12 秒测试视频（需要 ffmpeg）
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=440 \
  -t 12 -c:v libx264 -preset veryfast -c:a aac -f hls -hls_time 4 \
  -hls_playlist_type vod -hls_segment_filename .artifacts/hls/seg%03d.ts \
  .artifacts/hls/index.m3u8

# 启动假采集站（含搜索/详情/直播 M3U/EPG，全部指向本地 HLS）
MEDIA_DIR=.artifacts/hls node tools/mock-cms/server.mjs 8099
```

然后在应用里添加点播源 `http://127.0.0.1:8099/api.php/provide/vod`，搜索「流浪地球」即可走通搜索 → 详情 → 播放。

> 桌面端媒体代理默认拒绝内网地址，联调时设置 `LTV_ALLOW_PRIVATE_MEDIA=1`。

### 2. 假 DLNA 渲染器

```bash
node tools/mock-dlna/server.mjs        # 打印 description URL
node tools/mock-dlna/test.mjs          # 自动跑 SSDP → 描述 → SOAP 全链路断言
```

`npm run test:dlna` 即执行后者。

### 3. 手动验证投屏

1. 启动 `tools/mock-dlna/server.mjs`；
2. 桌面端播放页点击右上角「投屏」；
3. 设备列表应出现「Mock TV 客厅」，点击后假渲染器的 `/requests` 会记录 `SetAVTransportURI` 与 `Play`。

## 目录约定

| 路径 | 说明 |
| --- | --- |
| `defaults/sources.json` | 内置默认源，两端共用；改这里即可同时影响 PC/TV |
| `packages/core/src/**` | 共享逻辑与单测（`vitest`） |
| `apps/desktop/src/main` | 主进程：窗口、IPC、回环代理、DLNA 发送端 |
| `apps/desktop/src/preload` | contextBridge 白名单 |
| `apps/desktop/src/renderer` | React 界面、播放器、页面 |
| `apps/androidtv/app/src/main/java/org/librextv/tv` | TV 应用（data / ui / cast） |
| `tools/mock-cms`、`tools/mock-dlna` | 联调用假服务 |
| `reference/LibreTV` | 上游只读快照 |
