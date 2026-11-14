import { describe, expect, it } from 'vitest';
import { browseCategory, clearCategoryCache } from './categories';
import { CATALOG_LIMITER_CONCURRENCY, createLimiter } from './limiter';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './http';
import type { SourceConfig } from './types';

/** 全局分类闸门的并发上限：断言跟着常量走，改配置不用回来改测试 */
const CATALOG_CONCURRENCY = CATALOG_LIMITER_CONCURRENCY;

function response(text: string, ok = true, status = 200): HttpResponse {
  return {
    ok,
    status,
    url: '',
    headers: {},
    bytes: new TextEncoder().encode(text),
    text,
  };
}

/** 分类表：只有一个名为「电影片」的叶子分类，id=1 */
const CATEGORY_BODY = JSON.stringify({
  class: [{ type_id: 1, type_pid: 0, type_name: '电影片' }],
});

function listBody(count: number): string {
  return JSON.stringify({
    pagecount: 1,
    list: Array.from({ length: count }, (_, i) => ({
      vod_id: i + 1,
      vod_name: `影片${i + 1}`,
      type_name: '动作片',
    })),
  });
}

/**
 * 记录并发峰值的 http 模拟器。
 *
 * 每个请求都真的排进要测的闸门里——不然「并发上限」根本不可能被验证到。
 */
function meteredHttp(opts: { latencyMs?: number } = {}): {
  http: HttpClient;
  stats: { total: number; peak: number; live: number };
} {
  const stats = { total: 0, peak: 0, live: 0 };
  const latency = opts.latencyMs ?? 5;
  const http: HttpClient = {
    async request(url: string, _options?: HttpRequestOptions): Promise<HttpResponse> {
      stats.total++;
      stats.live++;
      stats.peak = Math.max(stats.peak, stats.live);
      try {
        await new Promise((resolve) => setTimeout(resolve, latency));
        return url.includes('ac=list') ? response(CATEGORY_BODY) : response(listBody(3));
      } finally {
        stats.live--;
      }
    },
  };
  return { http, stats };
}

function source(key: string, url = `https://${key}.example.com/api.php/provide/vod`): SourceConfig {
  return { key, name: key, url };
}

describe('createLimiter', () => {
  it('并发不超过上限', async () => {
    const limiter = createLimiter(2);
    let live = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live--;
    };
    await Promise.all(Array.from({ length: 10 }, () => limiter(task)));
    expect(peak).toBe(2);
  });

  it('任务抛错不会卡住后续任务', async () => {
    const limiter = createLimiter(1);
    await expect(
      limiter(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(limiter(async () => 42)).resolves.toBe(42);
  });

  it('size 反映排队与执行中的总数', async () => {
    const limiter = createLimiter(1);
    const slow = limiter(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    const queued = limiter(async () => undefined);
    expect(limiter.size).toBe(2);
    await Promise.all([slow, queued]);
    expect(limiter.size).toBe(0);
  });

  it('上限为 0 或负数时至少放行 1 个，不会死锁', async () => {
    const limiter = createLimiter(0);
    await expect(limiter(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('browseCategory 的并发闸门', () => {
  it('源数多时并发被压在上限内', async () => {
    clearCategoryCache();
    const { http, stats } = meteredHttp();
    const sources = ['a', 'b', 'c', 'd'].map((key) => source(key));
    const result = await browseCategory({ sources, key: 'movie', http, filterAdult: false, timeoutMs: 5_000 });
    expect(result.items.length).toBeGreaterThan(0);
    // 4 个源 × （1 次分类表 + 1 个子分类）= 8 个请求，但任一时刻不超过闸门上限
    expect(stats.total).toBeGreaterThanOrEqual(8);
    expect(stats.peak).toBeLessThanOrEqual(CATALOG_CONCURRENCY);
  });

  it('同一地址被配了多条时只打一次上游', async () => {
    clearCategoryCache();
    const { http, stats } = meteredHttp();
    const dup = source('dup');
    const result = await browseCategory({
      sources: [dup, { ...dup, key: 'dup-2', name: '副本' }],
      key: 'movie',
      http,
      filterAdult: false,
      timeoutMs: 5_000,
    });
    // 只应发出「1 次分类表 + 1 次子分类」两个请求
    expect(stats.total).toBe(2);
    const skipped = result.outcomes.find((o) => o.sourceKey === 'dup-2');
    expect(skipped?.error).toMatch(/重复/);
    // 内容仍然归到第一个条目名下，不会因为跳过而丢片
    expect(result.items.length).toBe(3);
  });

  it('源站整体 503 时给出可读的失败原因', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(): Promise<HttpResponse> {
        return response('busy', false, 503);
      },
    };
    const result = await browseCategory({
      sources: [source('x')],
      key: 'movie',
      http,
      filterAdult: false,
      timeoutMs: 5_000,
    });
    expect(result.items).toHaveLength(0);
    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].error).toContain('503');
  });
});
