/**
 * 生成「拼音种子索引」：从国内可直连的采集站抓全量片名，打包进 APK。
 *
 * ## 为什么需要它
 *
 * 采集站的接口只支持 `LIKE '%中文%'`，拼音检索必须在本地做。TV 端的本地索引只能
 * 装下「用户扫过的那些页」，实测设备上只有 1209 条，而 17 个源合计约 150 万条 ——
 * 覆盖率 0.08%，用户敲 `qmmk` 得到 0 条。
 *
 * 唯二支持「拼音当 wd」的源（量子 lziapi、暴风 bfzyapi）在境外出口下才活，大陆直连
 * 不通，指望不上。
 *
 * ## 为什么只存片名就够
 *
 * 拼音索引不需要 vodId / sourceKey / 年份，只要能给出**真实的中文片名**：
 * 用户点一条建议，我们就拿这个中文名去各源搜。中文 `wd` 是服务端 LIKE，覆盖全库、
 * 不受分页深度限制 —— 实测《庆余年第一季》(id=4203) 要翻到第 3500 页之后才出现，
 * 但 `wd=庆余年` 一次就返回全部 8 条。
 *
 * ## 成本
 *
 * 用 `ac=list`（精简列表，一页 5KB）而不是 `ac=videolist`（175KB），差 32 倍。
 * 片名 9.9 万条 → 1.9 MB 纯文本 → gzip 后约 770 KB。
 *
 * 用法：node tools/gen-seed-index.mjs [--fresh]
 *   断点续跑：进度写在 .tmp-check/seed-progress.json，已完成的分页不会重爬。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TMP = resolve(ROOT, '.tmp-check');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/** 只爬大陆直连可用、且实测过能完整播放的源。顺序即优先级（重的排前面）。 */
const SOURCE_NAMES = [
  '非凡资源',
  '魔都资源',
  '360 资源',
  '红牛资源',
  '西瓜资源',
  '海海资源',
  '爱奇艺',
  '魔都动漫',
  '百度资源',
  '极速资源',
  '金鹰资源',
  '光速资源',
];

const CONCURRENCY = Number(process.env.SEED_CONC ?? 16);
const PAGE_TIMEOUT_MS = 20_000;
const PROGRESS_PATH = resolve(TMP, 'seed-progress.json');
const NAMES_PATH = resolve(TMP, 'seed-titles.txt');
const FRESH = process.argv.includes('--fresh');

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

async function getJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadSources() {
  const plan = JSON.parse(await readFile(resolve(ROOT, 'defaults/sources.json'), 'utf8'));
  const byName = new Map(plan.sources.map((s) => [s.name, s]));
  return SOURCE_NAMES.map((n) => byName.get(n)).filter(Boolean);
}

async function main() {
  await mkdir(TMP, { recursive: true });

  let progress = { done: {}, names: [] };
  if (!FRESH && existsSync(PROGRESS_PATH)) {
    progress = JSON.parse(await readFile(PROGRESS_PATH, 'utf8'));
    log(`续跑：已完成 ${Object.keys(progress.done).length} 个源，已有片名 ${progress.names.length}`);
  }
  const names = new Set(progress.names);

  /** 分页抓取的落盘节流：每 8 秒写一次，「跑两天全丢」不值得 */
  let lastSave = 0;
  async function saveProgress() {
    const now = Date.now();
    if (now - lastSave < 8_000) return;
    lastSave = now;
    const payload = { done: progress.done, names: [...names] };
    await writeFile(PROGRESS_PATH, JSON.stringify(payload), 'utf8');
  }

  const sources = await loadSources();
  log(`准备抓 ${sources.length} 个源：${sources.map((s) => s.name).join('、')}`);

  /** 进度里既可能是老格式（数字＝已抓页数），也可能是新格式 `{ pages, total }` */
  function donePages(entry) {
    if (entry == null) return 0;
    if (typeof entry === 'number') return entry;
    return Number(entry.pages) || 0;
  }

  for (const source of sources) {
    const prev = progress.done[source.name];
    const prevPages = donePages(prev);
    // 只有「抓满了 total 页」才算完成。原来只要有一条数字就跳过，导致
    // 魔都动漫（230/4625）、百度（54/2493）这类提前触到 emptyStreak 的源
    // 永远补不回来 —— 而这些正好是库里老片最集中的几个。
    const prevTotal = prev && typeof prev === 'object' ? Number(prev.total) || 0 : 0;
    if (prevPages > 0 && prevPages >= prevTotal) {
      log(`跳过 ${source.name}（已完成 ${prevPages}/${prevTotal} 页）`);
      continue;
    }
    if (prevPages > 0) {
      log(`续抓 ${source.name}（上次 ${prevPages}/${prevTotal} 页，未抓满）`);
    }
    const base = source.url.trimEnd('/');

    // 首页顺便拿 total / pagecount
    const first = await getJson(`${base}?ac=list&pg=1`);
    if (!first || !Array.isArray(first.list) || first.list.length === 0) {
      log(`✗ ${source.name} 首页拿不到，跳过`);
      continue;
    }
    const totalPages = Math.min(Number(first.pagecount) || 0, 8_000);
    const started = Date.now();
    let pages = 0;
    let cursor = 0;
    let emptyStreak = 0;

    async function worker() {
      while (emptyStreak < 40) {
        const pg = ++cursor;
        if (pg > totalPages) return;
        // 第一页已经拿过了
        const json = pg === 1 ? first : await getJson(`${base}?ac=list&pg=${pg}`);
        if (!json || !Array.isArray(json.list) || json.list.length === 0) {
          emptyStreak += 1;
          continue;
        }
        emptyStreak = 0;
        pages += 1;
        for (const it of json.list) {
          const n = String(it.vod_name ?? '').trim();
          // 超长的一般是「合集/解说」类拼接标题，留着只会污染建议列表
          if (!n || n.length > 60) continue;
          names.add(n);
        }
        await saveProgress();
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const el = ((Date.now() - started) / 1000).toFixed(0);
    progress.done[source.name] = { pages, total: totalPages };
    lastSave = 0;
    await saveProgress();
    const mark = pages >= totalPages ? '✓' : '△';
    log(`${mark} ${source.name} 页 ${pages}/${totalPages} 累计片名 ${names.size} 用时 ${el}s`);
  }

  // 没抓满的源再来一轮。源站会在连续请求后短暂拒绝（返回空 list），
  // 一轮就放弃等于永久丢掉那部分片名（魔都动漫第一轮只拿到 230/4625）。
  const retry = sources.filter((s) => {
    const p = progress.done[s.name];
    return p && typeof p === 'object' && Number(p.pages) < Number(p.total);
  });
  if (retry.length > 0) {
    log(`--- 第二轮补齐 ${retry.length} 个源：${retry.map((s) => s.name).join('、')}`);
    for (const source of retry) {
      const base = source.url.trimEnd('/');
      const totalPages = Number(progress.done[source.name].total) || 0;
      const started = Date.now();
      let pages = 0;
      let cursor = 0;
      let emptyStreak = 0;
      const first = await getJson(`${base}?ac=list&pg=1`);
      if (!first) {
        log(`✗ ${source.name} 第二轮首页仍拿不到`);
        continue;
      }
      async function worker2() {
        while (emptyStreak < 40) {
          const pg = ++cursor;
          if (pg > totalPages) return;
          const json = pg === 1 ? first : await getJson(`${base}?ac=list&pg=${pg}`);
          if (!json || !Array.isArray(json.list) || json.list.length === 0) {
            emptyStreak += 1;
            continue;
          }
          emptyStreak = 0;
          pages += 1;
          for (const it of json.list) {
            const n = String(it.vod_name ?? '').trim();
            if (!n || n.length > 60) continue;
            names.add(n);
          }
          await saveProgress();
        }
      }
      await Promise.all(Array.from({ length: Math.max(4, CONCURRENCY >> 1) }, worker2));
      progress.done[source.name] = { pages, total: totalPages };
      lastSave = 0;
      await saveProgress();
      log(`△ ${source.name} 第二轮 ${pages}/${totalPages} 累计片名 ${names.size} 用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }

  const list = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  await writeFile(NAMES_PATH, list.join('\n'), 'utf8');

  // 打包成 gzip：APK 里不压缩也没关系，但载入时 gzip 能快一半以上
  const raw = Buffer.from(list.join('\n'), 'utf8');
  const gz = await new Promise((res, rej) => {
    const chunks = [];
    const gzip = createGzip({ level: 9 });
    Readable.from([raw])
      .pipe(gzip)
      .on('data', (c) => chunks.push(c))
      .on('end', () => res(Buffer.concat(chunks)))
      .on('error', rej);
  });

  const assetDir = resolve(ROOT, 'apps/androidtv/app/src/main/assets');
  await mkdir(assetDir, { recursive: true });
  await writeFile(resolve(assetDir, 'seed-titles.txt.gz'), gz);

  // 桌面端走同一份数据，放在 core 的静态资源里
  const coreDir = resolve(ROOT, 'packages/core/src');
  await writeFile(resolve(coreDir, 'seed-titles.txt.gz'), gz);

  // OTA 版本号：客户端启动后先取这个几百字节的小文件比对，有新版才下 1.9MB 整表。
  // 用「打包日期」而不是自增计数——爬取是按天做的，日期天然单调，也不用额外状态。
  // 注意：这个值和 seed-titles.txt.gz 必须同批提交，否则客户端会拉到版本号已更新、
  // 内容还是旧的（jsDelivr 按 commit 缓存，同一条 commit 里两个文件一起换，不会错配）。
  const version = todayStamp();
  await writeFile(resolve(assetDir, 'seed-version.txt'), `${version}\n`, 'utf8');
  await writeFile(resolve(coreDir, 'seed-version.txt'), `${version}\n`, 'utf8');

  log('---');
  log(`唯一片名 ${list.length}`);
  log(`纯文本 ${(raw.length / 1048576).toFixed(2)} MB → gzip ${(gz.length / 1048576).toFixed(2)} MB`);
  log(`OTA 版本号 ${version}`);
  log(`已写入 apps/androidtv/app/src/main/assets/seed-titles.txt.gz`);
  log(`已写入 packages/core/src/seed-titles.txt.gz`);
}

/** `yyyyMMdd` 形式的版本号（本地时区） */
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return Number(`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`);
}

await main();
