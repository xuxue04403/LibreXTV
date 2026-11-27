/**
 * 把内置片库（`packages/core/src/seed-titles.txt.gz`）拷到 main 的产物目录。
 *
 * 为什么需要这一步：`packages/core` 是被 `electron-vite` 用别名打**进** main bundle 的，
 * 不是作为 node_modules 依赖被外部化，所以 `import.meta.url` 在运行期指向
 * `out/main/index.js`（打包后是 asar 里的同一位置），源码目录里的 `.gz` 根本不在那里。
 *
 * 少了这个文件不会崩——`loadSeedTitles()` 找不到就保持「未就绪」，搜索退化成只查本地
 * 索引（加片库之前的老行为）。但老片就搜不到了，所以构建时必须带上。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../packages/core/src/seed-titles.txt.gz');
const outDir = resolve(here, '../out/main');
const dest = resolve(outDir, 'seed-titles.txt.gz');

if (!existsSync(src)) {
  console.error(`[copy-seed] 缺少种子表：${src}`);
  console.error('[copy-seed] 先跑 `node tools/gen-seed-index.mjs`（或 tools/pack-seed-index.mjs）');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(src, dest);
const kb = Math.round(statSync(dest).size / 1024);
console.log(`[copy-seed] ${dest}（${kb} KB）`);
