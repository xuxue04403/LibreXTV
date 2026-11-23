// 在 PEM 证书包（多个 -----BEGIN CERTIFICATE-----）里按签发者/主体关键字查找证书。
// 用途：macOS/本地 SDK 有时自带华为 CBG 中间 CA，能补齐 hap-sign-tool 要求的证书链。
//
// 用法：node scan-cert-bundle.cjs <bundle.pem> [关键字...]
const fs = require('fs');
const crypto = require('crypto');

const [, , file, ...needles] = process.argv;
if (!file) {
  console.error('用法：node scan-cert-bundle.cjs <bundle.pem> [关键字...]');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
const wanted = needles.length > 0 ? needles : ['Huawei'];

console.log(`共 ${blocks.length} 张证书，关键字：${wanted.join(' / ')}`);
blocks.forEach((pem, i) => {
  let cert;
  try {
    cert = new crypto.X509Certificate(pem);
  } catch {
    return;
  }
  const subject = cert.subject.replace(/\n/g, ', ');
  const issuer = cert.issuer.replace(/\n/g, ', ');
  if (wanted.some((n) => subject.includes(n) || issuer.includes(n))) {
    console.log(`--- [${i}] subject: ${subject}`);
    console.log(`        issuer : ${issuer}`);
    console.log(`        ca     : ${cert.ca}  valid: ${cert.validFrom} ~ ${cert.validTo}`);
  }
});
