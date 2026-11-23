# 鸿蒙（HarmonyOS NEXT）命令行构建脚本
#
# 用法：
#   pwsh -File tools/harmony/build.ps1                  # 构建 debug 签名 HAP
#   pwsh -File tools/harmony/build.ps1 -Mode release    # 构建 release
#   pwsh -File tools/harmony/build.ps1 -Task clean      # 清理
#
# 依赖（见 docs/build.md「鸿蒙端」）：
#   - .tools/harmony/sdk-7.0/             HarmonyOS SDK（DEVECO_SDK_HOME 指向这里）
#   - apps/harmonyos/node_modules/@ohos/  hvigor 与 hvigor-ohos-plugin（手工复制，npm 源无此包）
#   - apps/harmonyos/signing/             本地签名材料（gen-signing.ps1 生成）
#
# 产物：hvigor 原生输出在 entry/build/default/outputs/default/，构建成功后
# 会额外复制一份到 apps/harmonyos/release/（带版本号的发布名，便于分发）。
param(
    [ValidateSet('debug', 'release')]
    [string]$Mode = 'debug',
    [string]$Task = 'assembleHap',
    [switch]$NoDaemon
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Join-Path $repo 'apps\harmonyos'
$sdk = Join-Path $repo '.tools\harmony\sdk-7.0'

if (-not (Test-Path $sdk)) {
    throw "未找到 HarmonyOS SDK：$sdk（见 docs/build.md 的安装步骤）"
}
if (-not (Test-Path (Join-Path $project 'node_modules\@ohos\hvigor\bin\hvigor.js'))) {
    throw "未找到 hvigor：$project\node_modules\@ohos\hvigor（见 docs/build.md 的装配步骤）"
}

$env:DEVECO_SDK_HOME = $sdk
Push-Location $project
try {
    $args = @('node_modules\@ohos\hvigor\bin\hvigor.js', $Task, '-p', "buildMode=$Mode")
    # 默认就走 --no-daemon：CI 与本机一次性构建都用不上常驻守护进程，
    # 而守护进程会在改完签名材料后继续用旧缓存签出旧包，排查起来很费时。
    if ($NoDaemon -or $true) { $args += '--no-daemon' }
    & node @args
    if ($LASTEXITCODE -ne 0) { throw "hvigor 构建失败（exit $LASTEXITCODE）" }
}
finally {
    Pop-Location
}

$out = Join-Path $project 'entry\build\default\outputs\default'
$hap = Get-ChildItem $out -Filter '*-signed.hap' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($hap) {
    # 发布副本放到工程自己的 release/ 下，与 apps/desktop/release 的约定一致
    $release = Join-Path $project 'release'
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    $appJson = Get-Content (Join-Path $project 'AppScope\app.json5') -Raw
    $version = [regex]::Match($appJson, 'versionName"\s*:\s*"([^"]+)"').Groups[1].Value
    if (-not $version) { $version = 'dev' }
    $copy = Join-Path $release "LibreXTV-Harmony-$version.hap"
    Copy-Item $hap.FullName $copy -Force
    "{0}  {1:N0} 字节" -f $hap.Name, $hap.Length
    "已复制到 {0}  {1:N0} 字节" -f $copy, (Get-Item $copy).Length
}
else {
    Get-ChildItem $out -Filter '*.hap' -ErrorAction SilentlyContinue |
        ForEach-Object { "{0}  {1:N0} 字节" -f $_.Name, $_.Length }
}
