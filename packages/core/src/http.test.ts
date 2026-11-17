import { describe, expect, it } from 'vitest';
import { createFetchHttp, HttpError } from './http';

/** 造一个把 chunks 逐块吐出来的假响应 */
function streamingResponse(chunks: Uint8Array[], init?: { status?: number }): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: init?.status ?? 200 });
}

describe('http.stream', () => {
  it('按块回调并把结果拼成完整文本', async () => {
    const http = createFetchHttp(
      (async () => streamingResponse([new TextEncoder().encode('#EXTM3U\n'), new TextEncoder().encode('CCTV-1\n')])) as typeof fetch
    );
    const seen: string[] = [];
    const res = await http.stream!('http://example.com/a.m3u', {
      onChunk: (c) => seen.push(new TextDecoder().decode(c)),
    });
    expect(seen).toEqual(['#EXTM3U\n', 'CCTV-1\n']);
    expect(res.text).toBe('#EXTM3U\nCCTV-1\n');
    expect(res.ok).toBe(true);
  });

  it('超过 maxBytes 时断流并抛错，而不是把整条流收完', async () => {
    // 每个 chunk 1KB，一共 64 块 = 64KB；上限设成 4KB
    const chunk = new Uint8Array(1024).fill(65);
    const chunks = Array.from({ length: 64 }, () => chunk);
    let delivered = 0;
    const http = createFetchHttp(
      (async () =>
        streamingResponse(
          chunks.map((c) => {
            delivered += 1;
            return c;
          })
        )) as typeof fetch
    );

    let received = 0;
    await expect(
      http.stream!('http://example.com/firehose', {
        maxBytes: 4 * 1024,
        onChunk: (c) => {
          received += c.byteLength;
        },
      })
    ).rejects.toBeInstanceOf(HttpError);

    // 关键：收到第 5 块（4KB 之后）就停，不是把 64 块全收下
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(5 * 1024);
    expect(delivered).toBe(64);
  });

  it('默认上限是 64MB，正常大小的小列表不受影响', async () => {
    const http = createFetchHttp(
      (async () => streamingResponse([new Uint8Array(2 * 1024 * 1024)])) as typeof fetch
    );
    const res = await http.stream!('http://example.com/big.m3u', { onChunk: () => undefined });
    expect(res.bytes.byteLength).toBe(2 * 1024 * 1024);
  });

  it('onChunk 抛错时取消底层流，不让上游继续推完', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const http = createFetchHttp((async () => new Response(body)) as typeof fetch);
    await expect(
      http.stream!('http://example.com/loop.m3u', {
        onChunk: () => {
          throw new Error('回调炸了');
        },
      })
    ).rejects.toThrow('回调炸了');
    expect(cancelled).toBe(true);
  });

  it('主动取消记成「已取消」，不是「请求超时」', async () => {
    // 记成 408 会被 quality.ts 的 isRetryableTimeout 当成可重试超时，
    // 于是在用户已经离开页面之后还继续重试别家的源。
    const http = createFetchHttp((async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([65]));
          signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch);
    const controller = new AbortController();
    const task = http.request('http://example.com/a', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10).unref?.();
    await expect(task).rejects.toMatchObject({ message: '已取消', status: 0 });
  });

  it('已经取消的 signal 不再发请求', async () => {
    let calls = 0;
    const http = createFetchHttp((async () => {
      calls += 1;
      return streamingResponse([new Uint8Array([65])]);
    }) as unknown as typeof fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(http.request('http://example.com/b', { signal: controller.signal })).rejects.toMatchObject({
      message: '已取消',
      status: 0,
    });
    expect(calls).toBe(0);
  });
});
