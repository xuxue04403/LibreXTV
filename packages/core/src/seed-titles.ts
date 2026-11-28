/**
 * 内置的「拼音首字母 → 中文片名」种子表（桌面端）。
 *
 * ## 为什么需要它
 *
 * 采集站只支持 `LIKE '%中文%'`，拼音检索只能本地做。而本地索引只装得下用户扫过的
 * 那些页（`title-index.ts` 的注释里已经写明：`庆余年`、`三体`、`甄嬛传` 在 300 页 /
 * 6000 条里一次都没出现）。唯二支持「拼音当 wd」的源（量子 lziapi、暴风 bfzyapi）
 * 在大陆直连不通，指望不上。
 *
 * ## 做法
 *
 * `tools/gen-seed-index.mjs` 离线抓全量片名（`ac=list`，一页 5KB 而不是 175KB），
 * 打包进 `seed-titles.txt.gz`。启动后后台解压、算首字母、建倒排表。
 *
 * 关键洞察：**拼音索引不需要 vodId / sourceKey**，只要能给出真实中文片名。用户点一条
 * 建议，我们拿中文名去各源搜——中文 `wd` 是服务端 LIKE，覆盖全库、不受分页深度限制。
 *
 * 与 `suggestFromIndex` 的区别：那个查的是「带源的索引条目」，能直接进详情；
 * 这个只有片名，**点下去要发一次网络搜索**。所以两路要合并展示：有源的优先，
 * 种子表补全老片。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { pinyinInitials } from './pinyin.js';

/** 侧栏建议最多显示多少条 */
const MAX_HITS = 200;

/** 单条片名最多建多少个前缀键（30 字以上的片名只在头 12 个字母上建键） */
const MAX_KEY_LEN = 12;

let byInitials: Map<string, string[]> | null = null;
let all: string[] = [];
let nameSet: Set<string> = new Set();
let loading: Promise<void> | null = null;
let origin = '内置';

function assetPath(): string | null {
  // 三个入口都要能找到：
  // 1. 开发态（vite-node / vitest 直接跑 src）：与源码同目录
  // 2. 打包后（electron-vite 把 main 打成单文件）：构建脚本会把 .gz 拷到 out/main/
  // 3. 兜底：从 cwd 往上找仓库里的那份
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'seed-titles.txt.gz'),
    resolve(here, '../packages/core/src/seed-titles.txt.gz'),
    resolve(process.cwd(), 'packages/core/src/seed-titles.txt.gz'),
    resolve(process.cwd(), '../../packages/core/src/seed-titles.txt.gz'),
  ];
  for (const p of candidates) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // 下一个
    }
  }
  return null;
}

/**
 * 从一份纯文本片名表建倒排索引（覆盖式）。
 *
 * 抽出来是因为「APK/仓库内置的那份」和「OTA 下来的那份」格式完全一样，
 * 只是来源不同，没必要写两套。
 */
function buildIndex(raw: string): void {
  const map = new Map<string, string[]>();
  const plain: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    plain.push(name);
    const initials = pinyinInitials(name);
    if (initials.length < 2) continue;
    const limit = Math.min(initials.length, MAX_KEY_LEN);
    for (let i = 1; i <= limit; i += 1) {
      const key = initials.slice(0, i);
      const bucket = map.get(key);
      if (bucket) bucket.push(name);
      else map.set(key, [name]);
    }
  }
  byInitials = map;
  all = plain;
  nameSet = seen;
}

/**
 * 同步加载（数据是本地文件，主进程启动时读一次即可）。
 *
 * 文件缺失时保持「未就绪」，建议退化成只用 `title-index`——也就是老行为，不会崩。
 *
 * @param cachePath 可选：用户目录里的「在线更新版」明文表。存在就优先读它，
 *   这样下次冷启动不必重新下 1.9MB。
 */
export function loadSeedTitles(cachePath?: string | null): void {
  if (byInitials) return;
  if (cachePath) {
    try {
      if (statSync(cachePath).isFile()) {
        buildIndex(readFileSync(cachePath).toString('utf8'));
        origin = '在线更新';
        return;
      }
    } catch {
      // 坏文件就忽略，回落到仓库/APK 内置那份
    }
  }
  const path = assetPath();
  if (!path) return;
  let raw: string;
  try {
    raw = gunzipSync(readFileSync(path)).toString('utf8');
  } catch {
    return;
  }
  buildIndex(raw);
  origin = '内置';
}

/** 后台加载一遍（幂等），供主进程启动时预热 */
export function primeSeedTitles(cachePath?: string | null): Promise<void> {
  if (byInitials) return Promise.resolve();
  if (!loading) loading = Promise.resolve().then(() => loadSeedTitles(cachePath));
  return loading;
}

/**
 * 把一批片名并进当前表（去重）。
 *
 * @returns 真正新增的条数
 */
export function mergeSeed(names: readonly string[]): number {
  if (!byInitials) return 0;
  const added: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    // 注意：这里必须显式 has/add 两步，不能写成 `!nameSet.add(name)`。
    // JS 的 `Set.add()` 返回 Set 本身（永远真值），写成取反永远不成立，
    // 去重会静默失效——表现是每日增量每跑一次，同一个片名就多一份。
    if (nameSet.has(name)) continue;
    nameSet.add(name);
    added.push(name);
  }
  if (added.length === 0) return 0;
  const map = byInitials;
  for (const name of added) {
    const initials = pinyinInitials(name);
    if (initials.length < 2) continue;
    const limit = Math.min(initials.length, MAX_KEY_LEN);
    for (let i = 1; i <= limit; i += 1) {
      const key = initials.slice(0, i);
      const bucket = map.get(key);
      if (bucket) bucket.push(name);
      else map.set(key, [name]);
    }
  }
  all = all.concat(added);
  return added.length;
}

/** 全部片名的快照（OTA/增量落盘时写文件用） */
export function seedNames(): readonly string[] {
  return all;
}

/** 这批片名的来源：`内置` 或 `在线更新` */
export function seedOrigin(): string {
  return origin;
}

export function seedReady(): boolean {
  return byInitials !== null;
}

export function seedSize(): number {
  return all.length;
}

/** 按首字母前缀取候选片名 */
export function lookupSeed(needle: string, limit = MAX_HITS): string[] {
  if (!byInitials) return [];
  const key = needle.trim().toLowerCase();
  if (!key) return [];
  const hits = byInitials.get(key);
  if (!hits) return [];
  return hits.length <= limit ? hits.slice() : hits.slice(0, limit);
}

/** 拼音首字母命中，但也要能按中文原文包含匹配（用户直接打中文时） */
export function containsSeed(word: string, limit = MAX_HITS): string[] {
  if (!all.length) return [];
  const needle = word.trim().toLowerCase();
  if (!needle) return [];
  const out: string[] = [];
  for (const name of all) {
    if (name.toLowerCase().includes(needle)) {
      out.push(name);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 仅供测试：直接注入片名集合 */
export function installSeedForTest(names: readonly string[]): void {
  const map = new Map<string, string[]>();
  for (const name of names) {
    const initials = pinyinInitials(name);
    if (initials.length < 2) continue;
    const limit = Math.min(initials.length, MAX_KEY_LEN);
    for (let i = 1; i <= limit; i += 1) {
      const key = initials.slice(0, i);
      const bucket = map.get(key);
      if (bucket) bucket.push(name);
      else map.set(key, [name]);
    }
  }
  byInitials = map;
  all = [...names];
  nameSet = new Set(names);
  origin = '内置';
}

export function clearSeedForTest(): void {
  byInitials = null;
  all = [];
  nameSet = new Set();
  loading = null;
  origin = '内置';
}
