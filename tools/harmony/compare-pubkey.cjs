// 比较两张证书（PEM）的公钥是否同一把。
// 用途：AGC 上申请调试证书时，如果上传的 CSR 与本地密钥库 .p12 不是同一对，
// 签名能成功、装机却只报一句「fail to verify pkcs7 file」，极难查。这里提前拦下来。
//
// 注意：AGC 导出的 .cer 是**证书链**，顺序为「根 CA → 中间 CA → 你的开发证书」。
// 所以不能只取第一张，必须逐张比对，只要文件里任意一张的公钥与密钥库配对就算通过。
//
// 用法：node compare-pubkey.cjs <a.pem|.cer> <b.pem|.cer>
// 退出码：0 找到配对公钥；1 全部不匹配；2 读不了文件
const fs = require('fs');
const crypto = require('crypto');

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error('用法：node compare-pubkey.cjs <a.pem|.cer> <b.pem|.cer>');
  process.exit(2);
}

function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`读取失败：${file}：${err.message}`);
    process.exit(2);
  }
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) {
    console.error(`不是 PEM 证书：${file}`);
    process.exit(2);
  }
  const certs = [];
  for (const pem of blocks) {
    try {
      certs.push(new crypto.X509Certificate(pem));
    } catch (err) {
      console.error(`证书解析失败：${file}：${err.message}`);
      process.exit(2);
    }
  }
  return certs;
}

const spki = (cert) => cert.publicKey.export({ type: 'spki', format: 'der' });
const fp = (cert) => crypto.createHash('sha256').update(spki(cert)).digest('hex').slice(0, 32);
const name = (cert) => cert.subject.replace(/\n/g, ', ');

const a = load(fileA);
const b = load(fileB);

// 链文件里只有一张 ca=false 的叶子证书，那就是真正签名的证书
const leafOf = (certs) => certs.find((c) => !c.ca) ?? certs[certs.length - 1];

console.log(`A：${fileA}`);
a.forEach((c, i) => console.log(`  [${i}] ca=${c.ca} ${name(c)}  公钥 ${fp(c)}`));
console.log(`B：${fileB}`);
const bPrints = b.map((c, i) => {
  const print = fp(c);
  console.log(`  [${i}] ca=${c.ca} ${name(c)}  公钥 ${print}`);
  return print;
});

const leafA = leafOf(a);
const anyMatch = a.some((ca) => b.some((cb) => spki(ca).equals(spki(cb))));

if (anyMatch) {
  const hit = b.find((cb) => spki(leafA).equals(spki(cb)));
  console.log(hit ? `\n==> 配对成功：B 中的「${name(hit)}」与 A 的叶子证书公钥一致` : '\n==> 配对成功：两张文件里有相同公钥的证书');
  process.exit(0);
}
console.log(`\n==> 不匹配：A 的叶子证书公钥（${fp(leafA)}）没有出现在 B 中`);
process.exit(1);
