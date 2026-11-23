# 把已签好的 HAP 装进真机并拉起
#
# 为什么单独一个脚本：hdc 有两份（hms / openharmony），
# 用错那份会把真机显示成 Unauthorized 或直接列不出来，排查时很容易误判成「手机没连上」。
# 这里固定用 hms 那份，并在装不上时把设备的签名校验状态一并打出来。
#
# 用法：
#   pwsh -File tools/harmony/install-hap.ps1                    # 装 apps/harmonyos/release 下最新 HAP
#   pwsh -File tools/harmony/install-hap.ps1 -Hap D:\x.hap      # 装指定文件
#   pwsh -File tools/harmony/install-hap.ps1 -NoLaunch          # 只装不启动
param(
    [string]$Hap,
    [string]$Target,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$hdc = Join-Path $repo '.tools\harmony\sdk-7.0\HarmonyOS-NEXT2\hms\toolchains\hdc.exe'
if (-not (Test-Path $hdc)) { throw "未找到 hdc：$hdc" }

if (-not $Hap) {
    $release = Join-Path $repo 'apps\harmonyos\release'
    $latest = Get-ChildItem $release -Filter '*.hap' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw "apps/harmonyos/release 下没有 HAP，先跑 tools/harmony/build.ps1 -Mode release" }
    $Hap = $latest.FullName
}
if (-not (Test-Path $Hap)) { throw "找不到 HAP：$Hap" }

Write-Host "[1/3] 找设备…"
& $hdc kill 2>&1 | Out-Null
Start-Sleep -Milliseconds 500
& $hdc start 2>&1 | Out-Null
Start-Sleep -Seconds 2

$targets = (& $hdc list targets 2>&1) |
    Where-Object { $_ -and $_ -notmatch '\[Empty\]' } |
    ForEach-Object { $_.ToString().Trim() } |
    Where-Object { $_ }
# `list targets` 在只有蓝牙串口时也可能列出 COMx（UART），装不进手机，剔掉
$targets = $targets | Where-Object { $_ -notmatch '^COM\d+$' }
if (-not $targets) {
    & $hdc list targets -v 2>&1 | ForEach-Object { "      $_" }
    throw @'
没有检测到设备。逐项确认：
  1. 手机上「设置 → 系统 → 开发者选项 → USB 调试」已打开
  2. 插线后手机上弹出的「允许调试」点了允许（没弹就重新插一次）
  3. 换一根支持数据传输的线（只能充电的线不通）
  4. 跑 .tools/harmony/sdk-7.0/HarmonyOS-NEXT2/hms/toolchains/hdc.exe list targets -v 看状态
'@
}
if (-not $Target) { $Target = ($targets | Select-Object -First 1).ToString().Trim() }
if ($targets -notcontains $Target) { $Target = ($targets | Select-Object -First 1).ToString().Trim() }
Write-Host "      $Target"

Write-Host "[2/3] 安装 $(Split-Path $Hap -Leaf)（$('{0:N0}' -f (Get-Item $Hap).Length) 字节）…"
$install = & $hdc -t $Target install -r $Hap 2>&1
$install | ForEach-Object { "      $_" }
if ($LASTEXITCODE -ne 0 -or ($install -join "`n") -match '\[Fail\]') {
    Write-Host ''
    Write-Host "装机失败。常见原因对照：" -ForegroundColor Yellow
    Write-Host '  9568257 fail to verify pkcs7 file  → 证书链不是华为签发，或证书不是由本机 .p12 的 CSR 申请来的'
    Write-Host '  9568289 signature verify failed    → HAP 用的 Profile 与设备不匹配（Profile 里没登记这台设备）'
    Write-Host '  9568332 install parse profile fail → Profile 里的 bundle-name 与 HAP 的 bundleName 不一致'
    throw "安装失败（exit $LASTEXITCODE）"
}

if ($NoLaunch) { Write-Host '[3/3] 跳过启动'; exit 0 }

Write-Host '[3/3] 启动…'
$moduleJson = Join-Path $repo 'apps\harmonyos\entry\src\main\module.json5'
$ability = 'EntryAbility'
if (Test-Path $moduleJson) {
    $m = [regex]::Match((Get-Content $moduleJson -Raw), 'mainElement"\s*:\s*"([^"]+)"')
    if ($m.Success) { $ability = $m.Groups[1].Value }
}
$appJson = Join-Path $repo 'apps\harmonyos\AppScope\app.json5'
$bundle = [regex]::Match((Get-Content $appJson -Raw), 'bundleName"\s*:\s*"([^"]+)"').Groups[1].Value
& $hdc -t $Target shell "aa start -a $ability -b $bundle" 2>&1 | ForEach-Object { "      $_" }
Write-Host "      已请求启动 $bundle / $ability"
