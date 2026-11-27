/**
 * 用「当前爬取进度」打包种子索引，不必等 `gen-seed-index.mjs` 全部跑完。
 *
 * `gen-seed-index.mjs` 只在所有源都抓完后才写出 assets —— 12 个源、5.8 万页，
 * 实测要跑两个多小时。开发期没必要等：进度本来就每 8 秒落盘一次，这里直接读
 * 那份 JSON 重新打包即可。爬完后再跑一次本脚本覆盖，结果与主脚本一致。
 *
 * ## 为什么写出的是 .txt.gz
 *
 * 源文件用 gzip 存，是为了进 git 时不把 3.8MB 明文塞进仓库历史。
 * **Android 侧读的是 `seed-titles.txt`**：aapt2 打包时会自动解压 `.gz` 并去掉
 * 该扩展名，APK 里拿到的是明文，由 zip 自身再压缩一次。所以 Kotlin 那边不能套
 * GZIPInputStream（套了会炸，而且异常会被吞掉，表现为「搜索永远 0 条」）。
 * **桌面端（`packages/core/src/seed-titles.ts`）读的是 `.gz`**，用 gunzipSync 解。
 *
 * 用法：node tools/pack-seed-index.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PROGRESS = resolve(ROOT, '.tmp-check/seed-progress.json');

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

async function main() {
  if (!existsSync(PROGRESS)) {
    log('✗ 没有 .tmp-check/seed-progress.json，先跑 tools/gen-seed-index.mjs');
    process.exitCode = 1;
    return;
  }
  const progress = JSON.parse(await readFile(PROGRESS, 'utf8'));
  const names = [...new Set(progress.names)].filter((n) => n && n.length <= 60);
  // 与主脚本同一套排序：让同一首字母下的片名顺序稳定，建议列表不会因重打包而跳动
  names.sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const raw = Buffer.from(names.join('\n'), 'utf8');
  const gz = gzipSync(raw, { level: 9 });

  const targets = [
    resolve(ROOT, 'apps/androidtv/app/src/main/assets/seed-titles.txt.gz'),
    resolve(ROOT, 'packages/core/src/seed-titles.txt.gz'),
  ];
  for (const target of targets) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, gz);
  }

  const done = Object.entries(progress.done ?? {})
    .map(([k, v]) => `${k}=${v}页`)
    .join('、');
  log(`已完成：${done || '（无）'}`);
  log(`唯一片名 ${names.length}`);
  log(`纯文本 ${(raw.length / 1048576).toFixed(2)} MB → gzip ${(gz.length / 1048576).toFixed(2)} MB`);
  for (const target of targets) log(`已写入 ${target.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
}

await main();
