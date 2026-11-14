/**
 * 桌面端分类浏览耗时拆解：看清「慢」到底慢在哪一步。
 *
 * 分三段打点：
 *   1. 每个源的分类表 `?ac=list` 单次耗时（冷）
 *   2. 8 个首页分类并发探测的总耗时（这就是首页启动时打出去的请求量）
 *   3. 单个分类（电影）的首次浏览耗时
 *
 * 用法：npx vite-node tools/audit/category-timing.ts
 */
import { createFetchHttp } from '@librextv/core';
import { browseCategory, probeCategories, fetchSourceCategories, HOME_CATEGORIES } from '@librextv/core';
import { readFileSync } from 'node:fs';

interface RawDefaults {
  sources: Array<{ name: string; url: string; detail?: string; isAdult?: boolean }>;
}

const raw = JSON.parse(readFileSync('defaults/sources.json', 'utf8')) as RawDefaults;
const sources = raw.sources.map((s, i) => ({
  key: `builtin_${i}`,
  name: s.name,
  url: s.url,
  detail: s.detail,
  isAdult: Boolean(s.isAdult),
}));

const http = createFetchHttp();

function ms(started: number): number {
  return Math.round(Number(process.hrtime.bigint() - BigInt(started)) / 1e6);
}

function now(): bigint {
  return process.hrtime.bigint();
}

function bh(): bigint {
  return process.hrtime.bigint();
}

async function main(): Promise<void> {
  console.log(`源数量：${sources.length}\n`);

  console.log('=== 1. 分类表单次耗时（并发） ===');
  const t0 = bh();
  const tableResults = await Promise.all(
    sources.map(async (source) => {
      const started = bh();
      try {
        const cats = await fetchSourceCategories(source, http, { timeoutMs: 10_000 });
        return { name: source.name, ok: true, count: cats.length, ms: ms(Number(started)) };
      } catch (err) {
        return {
          name: source.name,
          ok: false,
          count: 0,
          ms: ms(Number(started)),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
  console.log(`总耗时 ${ms(Number(t0))}ms`);
  for (const r of tableResults) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(10)} ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.count} 分类` : r.error}`);
  }

  console.log('\n=== 2. 8 个分类探测总耗时（首页启动打出去的请求） ===');
  const t1 = bh();
  const probes = await probeCategories({ sources, http, filterAdult: true, timeoutMs: 10_000 });
  console.log(`总耗时 ${ms(Number(t1))}ms`);
  for (const p of probes) {
    console.log(`  ${p.available ? '✓' : '✗'} ${p.key.padEnd(8)} 命中源 ${p.hits}/${p.sources}`);
  }

  console.log('\n=== 3. 单个分类（电影）首次浏览 ===');
  const t2 = bh();
  const result = await browseCategory({ sources, key: 'movie', http, filterAdult: true, timeoutMs: 12_000 });
  console.log(`总耗时 ${ms(Number(t2))}ms  条目 ${result.items.length}`);
  for (const o of result.outcomes) {
    console.log(
      `  ${o.ok ? (o.supported ? '✓' : '-') : '✗'} ${o.sourceName.padEnd(10)} ${String(o.ms).padStart(6)}ms  ${o.count} 条${o.error ? `  ${o.error}` : ''}`
    );
  }

  console.log(`\n首页分类键：${HOME_CATEGORIES.map((c) => c.key).join(',')}`);
}

await main();
