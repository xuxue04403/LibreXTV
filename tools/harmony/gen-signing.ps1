# 生成鸿蒙本地调试/发布签名材料（应用密钥对 → 证书链 → 描述文件 → hvigor 密码密文）
#
# 用法：
#   pwsh -File tools/harmony/gen-signing.ps1
#   pwsh -File tools/harmony/gen-signing.ps1 -BundleName org.librextv.app -Force
#
# 产物（全部在 apps/harmonyos/signing/，该目录已 gitignore，绝不入库）：
#   librextv.p12        应用密钥库
#   librextv-app.cer    应用证书链（3 层）
#   profile.p7b         已签名的 HarmonyAppProvision 描述文件
#   material/           hvigor 要求的密码密文材料
#
# 说明：
#   - 描述文件里的 bundle-name 必须与 AppScope/app.json5 的 bundleName 一致，改了包名必须重跑本脚本。
#   - distribution-certificate 必须是 URL-safe base64（+/ 换成 -_），否则 hap-sign-tool 报
#     「Illegal base64 character 2f」。
#   - 密码必须 >= 32 字符，否则 hvigor 报 00303116。
param(
    [string]$BundleName = 'org.librextv.app',
    [string]$Password = 'LibreXTV_HarmonyOS_2026_SignKey01',
    [string]$KeyAlias = 'librextv-key',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Join-Path $repo 'apps\harmonyos'
$signing = Join-Path $project 'signing'
$toolchains = Join-Path $repo '.tools\harmony\sdk-7.0\HarmonyOS-NEXT2\openharmony\toolchains\lib'
$signTool = Join-Path $toolchains 'hap-sign-tool.jar'
$ohKeystore = Join-Path $toolchains 'OpenHarmony.p12'
$profileCert = Join-Path $toolchains 'OpenHarmonyProfileRelease.pem'

foreach ($p in @($signTool, $ohKeystore, $profileCert)) {
    if (-not (Test-Path $p)) { throw "缺少签名工具或 SDK 素材：$p" }
}
if ($Password.Length -lt 32) { throw "密码必须至少 32 字符（hvigor 限制），当前 $($Password.Length) 字符" }

if (-not (Test-Path $signing)) { New-Item -ItemType Directory -Path $signing | Out-Null }

$p12 = Join-Path $signing 'librextv.p12'
$appCer = Join-Path $signing 'librextv-app.cer'
$profileP7b = Join-Path $signing 'profile.p7b'
$rootCa = Join-Path $signing '_rootca.cer'
$subCa = Join-Path $signing '_subca.cer'
$plainProfile = Join-Path $signing '_profile.json'

if ((Test-Path $p12) -and -not $Force) {
    throw "签名材料已存在：$p12（换包名或要重签请加 -Force）"
}
if ($Force) {
    # 密钥库不清掉会报「KeyAlias {librextv-key} is exist … could not overwrite」
    Remove-Item $p12, $appCer, $profileP7b -Force -ErrorAction SilentlyContinue
}

function Invoke-SignTool([string[]]$Arguments) {
    $out = & java -jar $signTool @Arguments 2>&1
    $text = ($out | Out-String)
    if ($LASTEXITCODE -ne 0 -or $text -match 'ERROR') {
        throw "hap-sign-tool 失败：$($Arguments[0])`n$text"
    }
    return $text
}

Write-Host '[1/5] 生成应用密钥对…'
Invoke-SignTool @(
    'generate-keypair', '-keyAlias', $KeyAlias, '-keyPwd', $Password,
    '-keyAlg', 'ECC', '-keySize', 'NIST-P-256',
    '-keystoreFile', $p12, '-keystorePwd', $Password
) | Out-Null

Write-Host '[2/5] 导出 CA 证书并签发应用证书链…'
# generate-app-cert 要求提供根 CA 与二级 CA 的证书文件，从 OpenHarmony.p12 里导出
& keytool -exportcert -rfc -alias 'openharmony application root ca' -keystore $ohKeystore -storepass 123456 -storetype PKCS12 -file $rootCa 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "导出根 CA 证书失败" }
& keytool -exportcert -rfc -alias 'openharmony application ca' -keystore $ohKeystore -storepass 123456 -storetype PKCS12 -file $subCa 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "导出二级 CA 证书失败" }
Invoke-SignTool @(
    'generate-app-cert', '-keyAlias', $KeyAlias, '-keyPwd', $Password,
    '-issuer', 'C=CN,O=OpenHarmony,OU=OpenHarmony Team,CN=OpenHarmony Application CA',
    '-issuerKeyAlias', 'openharmony application ca', '-issuerKeyPwd', '123456',
    '-issuerKeystoreFile', $ohKeystore, '-issuerKeystorePwd', '123456',
    '-subject', 'C=CN,O=LibreXTV,OU=LibreXTV,CN=LibreXTV Harmony',
    '-validity', '3650', '-signAlg', 'SHA256withECDSA',
    '-rootCaCertFile', $rootCa, '-subCaCertFile', $subCa,
    '-keystoreFile', $p12, '-keystorePwd', $Password,
    '-outForm', 'certChain', '-outFile', $appCer
) | Out-Null

Write-Host '[3/5] 生成描述文件 profile.json…'
$pem = [IO.File]::ReadAllText($appCer)
$certs = [regex]::Matches($pem, '-----BEGIN CERTIFICATE-----(?<b>[\s\S]*?)-----END CERTIFICATE-----')
if ($certs.Count -eq 0) { throw "证书链解析失败：$appCer" }
# 叶子证书（第一张）的 base64 去掉换行后转 URL-safe
$leaf = ($certs[0].Groups['b'].Value -replace '\s', '') -replace '\+', '-' -replace '/', '_'
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
# 用模板而不是 ConvertTo-Json：后者会把空数组压成 {}，而 acls/permissions 必须是 []
$json = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '_profile-template.json'))
$json = $json.Replace('__UUID__', [guid]::NewGuid().ToString()).
    Replace('__NOT_BEFORE__', [string]($now - 86400)).
    Replace('__NOT_AFTER__', [string]($now + 31536000)).
    Replace('__CERT__', $leaf).
    Replace('__BUNDLE__', $BundleName)
[IO.File]::WriteAllText($plainProfile, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host '[4/5] 签名描述文件…'
Invoke-SignTool @(
    'sign-profile', '-mode', 'localSign',
    '-keyAlias', 'openharmony application profile release', '-keyPwd', '123456',
    '-profileCertFile', $profileCert,
    '-inFile', $plainProfile, '-signAlg', 'SHA256withECDSA',
    '-keystoreFile', $ohKeystore, '-keystorePwd', '123456',
    '-outFile', $profileP7b
) | Out-Null

Write-Host '[5/5] 生成 hvigor 密码密文材料…'
& node (Join-Path $PSScriptRoot 'gen-sign-material.cjs') $project $Password
if ($LASTEXITCODE -ne 0) { throw "gen-sign-material.cjs 失败（exit $LASTEXITCODE）" }

Remove-Item $rootCa, $subCa, $plainProfile -ErrorAction SilentlyContinue

Get-ChildItem $signing | ForEach-Object { "{0}  {1:N0} 字节" -f $_.Name, $_.Length }
Write-Host "签名材料已就绪：bundle-name = $BundleName"
