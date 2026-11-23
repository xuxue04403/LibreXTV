# 换成华为（AppGallery Connect）签发的签名材料
#
# 背景：tools/harmony/gen-signing.ps1 生成的是 **OpenHarmony 测试根证书**链路，只能装
# 在 OpenHarmony 设备 / DevEco 模拟器上。真机 HarmonyOS 5 / NEXT 只信任华为签发的
# 证书链，所以要让 HAP 装进真实华为手机，必须用你在 AGC 上申请到的三样材料。
#
# 用法：
#   pwsh -File tools/harmony/use-huawei-signing.ps1 `
#       -CertFile   D:\keys\librextv.cer `
#       -ProfileFile D:\keys\librextv.p7b `
#       -KeystoreFile D:\keys\librextv.p12 `
#       -KeyAlias   librextv `
#       -Password   '你给 p12 设置的至少32位密码'
#
# AGC 上需要先做的事（一次性，都在 AppGallery Connect 网页完成）：
#   1. 「用户与访问 → 证书管理」新建调试证书，下载 .cer（**必须是含中间 CA 的证书链**）
#   2. 「设备管理」把你手机加入调试设备列表（需要手机 UDID）
#   3. 「HarmonyOS 应用 → 你的应用 → 描述文件」新建调试 Profile，下载 .p7b
#   4. 用 DevEco 或 keytool 生成本地密钥库 .p12（generate-keypair 也可以）
#
# 三样材料齐了再跑本脚本，它会：把材料放进 apps/harmonyos/signing/、生成 hvigor 需要的
# 密码密文 material/、改写 build-profile.json5，之后 tools/harmony/build.ps1 就能签出
# 可安装的 HAP。
param(
    [Parameter(Mandatory = $true)][string]$CertFile,
    [Parameter(Mandatory = $true)][string]$ProfileFile,
    [Parameter(Mandatory = $true)][string]$KeystoreFile,
    [Parameter(Mandatory = $true)][string]$KeyAlias,
    [Parameter(Mandatory = $true)][string]$Password
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Join-Path $repo 'apps\harmonyos'
$signing = Join-Path $project 'signing'

foreach ($p in @($CertFile, $ProfileFile, $KeystoreFile)) {
    if (-not (Test-Path $p)) { throw "找不到文件：$p" }
}

# 证书必须是证书链：单张证书 hap-sign-tool 会报 11013004 Profile cert must a cert chain
$pem = [IO.File]::ReadAllText($CertFile)
$count = ([regex]::Matches($pem, '-----BEGIN CERTIFICATE-----')).Count
if ($count -lt 2) {
    throw "证书文件只含 $count 张证书，AGC 导出的 .cer 需要含中间 CA（应为 2~3 张）。请在 AGC 下载完整证书链。"
}

if (-not (Test-Path $signing)) { New-Item -ItemType Directory -Path $signing | Out-Null }

Copy-Item $CertFile (Join-Path $signing 'librextv-app.cer') -Force
Copy-Item $ProfileFile (Join-Path $signing 'profile.p7b') -Force
Copy-Item $KeystoreFile (Join-Path $signing 'librextv.p12') -Force

Write-Host '[1/4] 校验密钥库与别名…'
$aliases = & keytool -list -keystore (Join-Path $signing 'librextv.p12') -storepass $Password -storetype PKCS12 2>&1
if ($LASTEXITCODE -ne 0) { throw "打开密钥库失败（密码是否正确？）`n$($aliases | Out-String)" }
if (($aliases | Out-String) -notmatch [regex]::Escape($KeyAlias)) {
    throw "密钥库里没有别名 $KeyAlias，实际包含：`n$($aliases | Out-String)"
}
Write-Host "      别名 $KeyAlias 存在"

Write-Host '[2/4] 校验描述文件…'
$toolchains = Join-Path $repo '.tools\harmony\sdk-7.0\HarmonyOS-NEXT2\openharmony\toolchains\lib'
$signTool = Join-Path $toolchains 'hap-sign-tool.jar'
$verifyOut = & java -jar $signTool verify-profile -inFile (Join-Path $signing 'profile.p7b') -outFile (Join-Path $signing '_verify-profile.json') 2>&1
if ($LASTEXITCODE -ne 0) { throw "描述文件校验失败：`n$($verifyOut | Out-String)" }
$info = Get-Content (Join-Path $signing '_verify-profile.json') -Raw | ConvertFrom-Json
$bundle = $info.content.'bundle-info'.'bundle-name'
$type = $info.content.type
Write-Host "      bundle-name = $bundle，type = $type"
$appJson = Get-Content (Join-Path $project 'AppScope\app.json5') -Raw
$localBundle = [regex]::Match($appJson, 'bundleName"\s*:\s*"([^"]+)"').Groups[1].Value
if ($bundle -ne $localBundle) {
    throw "描述文件的 bundle-name（$bundle）与 AppScope/app.json5 的 bundleName（$localBundle）不一致，装机时会报包名不匹配。"
}
Remove-Item (Join-Path $signing '_verify-profile.json') -Force

Write-Host '[3/4] 校验证书与密钥库是否同一把…'
# 证书里的公钥必须与密钥库私钥配对，否则签名能跑完、装机只报一句
# 「fail to verify pkcs7 file」，极难定位。这里用 X509Certificate 比 SPKI 指纹。
# 注意：AGC 导出的 .cer 是「根 CA → 中间 CA → 开发证书」的链，叶子证书在最后一张，
# compare-pubkey.cjs 会逐张比对，任意一张配对即通过。
$tmpCer = Join-Path ([IO.Path]::GetTempPath()) "librextv-sign-check-$([guid]::NewGuid().ToString('N').Substring(0,8)).pem"
& keytool -exportcert -rfc -alias $KeyAlias -keystore (Join-Path $signing 'librextv.p12') `
    -storepass $Password -storetype PKCS12 -file $tmpCer 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmpCer)) { throw "从密钥库导出证书失败（别名 $KeyAlias）" }
$compare = & node (Join-Path $PSScriptRoot 'compare-pubkey.cjs') (Join-Path $signing 'librextv-app.cer') $tmpCer 2>&1
$compare | ForEach-Object { Write-Host "      $_" }
$cmpExit = $LASTEXITCODE
Remove-Item $tmpCer -Force -ErrorAction SilentlyContinue
if ($cmpExit -eq 1) {
    throw "证书公钥与密钥库里的私钥不是同一把。AGC 上的证书必须由本密钥库的 CSR 申请得到，否则装机报 fail to verify pkcs7 file。"
}
if ($cmpExit -ne 0) { throw "证书比对失败：`n$($compare | Out-String)" }

Write-Host '[4/4] 生成 hvigor 密码密文材料…'
& node (Join-Path $PSScriptRoot 'gen-sign-material.cjs') $project $Password $KeyAlias
if ($LASTEXITCODE -ne 0) { throw "gen-sign-material.cjs 失败（exit $LASTEXITCODE）" }

Write-Host ''
Write-Host '华为签名材料已就位。下一步：'
Write-Host '  pwsh -File tools/harmony/build.ps1 -Mode release'
Write-Host '  .tools/harmony/sdk-7.0/HarmonyOS-NEXT2/openharmony/toolchains/hdc.exe install apps/harmonyos/release/LibreXTV-Harmony-<版本>.hap'
