/**
 * 种子表（拼音首字母 → 中文片名）的在线更新与每日增量。
 *
 * ## 为什么需要
 *
 * 打进安装包的种子表是**发版快照**：v1.3.15 里那 22 万条片名是离线从 12 个采集站
 * 翻完全部分页抓来的，抓完就固定了。之后上新的片（短剧、综艺一周几十部）要等下个
 * 版本才进表——用户敲新剧首字母，建议列表是空的。
 *
 * ## 两条路（方案 C）
 *
 * 1. **整表 OTA**：仓库里的 `seed-titles.txt.gz` 由 jsDelivr 免费 CDN 对外提供
 *    （实测 10.7MB/s），启动后先取几百字节的 `seed-version.txt` 比对，有新版本才下
 *    那 1.9MB 整表，缓存到 `userData`，下次冷启动直接读。
 * 2. **每日增量**：每个已启用源的第 1 页就是「当天新片」（采集站按 `vod_time` 倒序），
 *    拉一页只要几秒、几十 KB，并进内存表即可。
 *
 * 两条都不依赖自建服务器。失败全部静默可恢复——种子表只是「搜索建议」的来源之一，
 * 更新不上就退回旧表，绝不能影响启动。
 */
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { mergeSeed, seedNames } from '@librextv/core/seed-titles';
import type { SourceConfig } from '@librextv/core';

/** 版本号文件（几百字节），第一行是 `yyyyMMdd` 形式的整数 */
const VERSION_URL =
  'https://fastly.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-version.txt';

/** 整表（gzip，约 1.9MB）。三个镜像任一可用即可。 */
const TABLE_URLS = [
  'https://fastly.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-titles.txt.gz',
  'https://testingcf.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-titles.txt.gz',
  'https://cdn.jsdelivr.net/gh/xuxue04403/LibreXTV@master/apps/androidtv/app/src/main/assets/seed-titles.txt.gz',
];

const VERSION_TIMEOUT_MS = 8_000;
const TABLE_TIMEOUT_MS = 60_000;
const DELTA_TIMEOUT_MS = 10_000;
/** 每日增量最多合并多少条；正常一天几十条，留余量但不让异常数据灌爆 */
const DELTA_MAX_NAMES = 2_000;
/** 明显不完整的下载不覆盖本地 */
const MIN_TABLE_NAMES = 10_000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function cacheDir(): string {
  return app.getPath('userData');
}

/** 在线更新版整表（明文，供下次冷启动直接读） */
export function seedCachePath(): string {
  return join(cacheDir(), 'seed-titles.txt');
}

function versionFile(): string {
  return join(cacheDir(), 'seed-version.txt');
}

/**
 * 远端整表的 ETag（jsDelivr 按文件内容算，内容一变它就变）。
 *
 * 为什么还需要它：版本号文件是后加的，旧版本客户端、以及「版本号还没提交上去」
 * 的那段时间，只能靠 ETag 判断。两条路任意一条说「有新版」就下——
 * 版本号是快路径，ETag 是兜底。
 */
function etagFile(): string {
  return join(cacheDir(), 'seed-etag.txt');
}

export function localSeedEtag(): string {
  try {
    return readFileSync(etagFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

function saveEtag(etag: string): void {
  try {
    writeFileSync(etagFile(), etag, 'utf8');
  } catch {
    // 记不住 ETag 只影响下次重复下载，不影响正确性
  }
}

/** 只读响应头里的 ETag，不下载正文 */
async function fetchEtag(url: string, timeoutMs: number): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return '';
    return res.headers.get('etag') ?? '';
  } catch {
    return '';
  }
}

/**
 * 本地版本号。
 *
 * 用户目录里没有时，退到安装包同级的那份 `seed-version.txt`——它在构建时就写好了
 * （见 `tools/pack-seed-index.mjs` 与 `scripts/copy-seed.mjs`），代表「安装包里这份
 * 种子表是哪天抓的」。没有这个基线，全新安装的第一次启动必然判成「远端更新」白下 1.9MB。
 */
export function localSeedVersion(): number {
  const fromFile = (() => {
    try {
      const v = Number.parseInt(readFileSync(versionFile(), 'utf8').trim(), 10);
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  })();
  if (fromFile !== null) return fromFile;

  // 安装包里的基线：与 seed-titles.txt.gz 同目录（构建脚本会把它一起拷到 out/main）
  const bundled = join(__dirname, 'seed-version.txt');
  try {
    const v = Number.parseInt(readFileSync(bundled, 'utf8').trim(), 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 把整份片名表写进用户目录，供下次启动读取。
 *
 * 先写临时文件再改名：中途断电不会留下半截文件把建议列表废掉。
 */
function persist(names: readonly string[]): void {
  const target = seedCachePath();
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(tmp, names.join('\n'), 'utf8');
    renameSync(tmp, target);
  } catch {
    // 写不进去不影响本次运行（内存表已经更新了），下次冷启动读旧文件即可
  }
}

/**
 * 检查并应用整表更新。
 *
 * 判定顺序：先取版本号（最快最省），拿不到再退到 ETag 比对（只读响应头，
 * 不下载正文）。两条都失效就跳过，等下次启动。
 *
 * @returns 是否真的更新了
 */
export async function updateSeedTableIfNeeded(): Promise<boolean> {
  // 先取版本号（最快最省），拿不到就是 null，退到 ETag 兜底
  const remote = await (async (): Promise<number | null> => {
    try {
      const text = await fetchText(VERSION_URL, VERSION_TIMEOUT_MS);
      const first = text.trim().split('\n')[0];
      const parsed = Number.parseInt(first ?? '', 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      // 取不到版本号是常态（CDN 抖动、被墙、仓库还没发新版本），不报错
      return null;
    }
  })();

  // ETag 顺手取一次：既用于版本号缺失时的兜底判定，也用于更新成功后记账
  const remoteEtag = await fetchEtag(TABLE_URLS[0], VERSION_TIMEOUT_MS);

  if (remote !== null) {
    if (remote <= localSeedVersion()) return false;
  } else if (!remoteEtag || remoteEtag === localSeedEtag()) {
    return false;
  }

  let names: string[] | null = null;
  for (const url of TABLE_URLS) {
    try {
      const bytes = await fetchBytes(url, TABLE_TIMEOUT_MS);
      const text = gunzipSync(bytes).toString('utf8');
      names = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      break;
    } catch {
      // 换下一个镜像
    }
  }
  if (!names || names.length < MIN_TABLE_NAMES) return false;

  mergeSeed(names);
  persist(seedNames());
  try {
    if (remote !== null) writeFileSync(versionFile(), `${remote}`, 'utf8');
    if (remoteEtag) saveEtag(remoteEtag);
  } catch {
    // 版本号写不进去只影响下次重复下载，不影响正确性
  }
  return true;
}

/**
 * 每日增量：各启用源的第 1 页就是当天新片，拉一遍并进内存表。
 *
 * @returns 新增条数
 */
export async function pullDailySeedDelta(sources: readonly SourceConfig[]): Promise<number> {
  if (sources.length === 0) return 0;
  const collected: string[] = [];
  await Promise.all(
    sources.map(async (source) => {
      try {
        const base = source.url.replace(/\/+$/, '');
        const text = await fetchText(`${base}?ac=list&pg=1`, DELTA_TIMEOUT_MS);
        const json = JSON.parse(text) as { list?: { vod_name?: string }[] };
        for (const item of json.list ?? []) {
          const name = (item.vod_name ?? '').trim();
          // 超长标题是合集/解说拼接，会污染建议列表（与种子表抓取同一套过滤）
          if (name && name.length <= 60) collected.push(name);
        }
      } catch {
        // 单个源失败不影响其它源
      }
    })
  );
  if (collected.length === 0) return 0;
  const names = [...new Set(collected)].slice(0, DELTA_MAX_NAMES);
  const added = mergeSeed(names);
  if (added > 0) persist(seedNames());
  return added;
}

/** 清掉在线更新版，回落到安装包内置那份 */
export function resetSeedToBuiltin(): void {
  try {
    if (existsSync(seedCachePath())) writeFileSync(seedCachePath(), '', 'utf8');
    writeFileSync(versionFile(), '0', 'utf8');
  } catch {
    // 忽略
  }
}

/** 在线更新版是否存在且非空 */
export function hasSeedCache(): boolean {
  try {
    return existsSync(seedCachePath()) && readFileSync(seedCachePath(), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}
