/**
 * 并发闸门。
 *
 * 采集站的容忍度很低：一次分类浏览本来就要打「源数 × 子分类数」个请求，
 * 4 个源 × 6 个子分类 = 24 个并发；启动预热再叠上来就是几十个同时出去，
 * 上游会直接 503 / 断开，表现就是「所有源都失败、这个分类一部片子都没有」。
 *
 * 这里给分类相关的请求加一个全局闸门，把并发压回个位数。
 */
export interface Limiter {
  <T>(task: () => Promise<T>): Promise<T>;
  /** 当前排队 + 执行中的任务数（调试与测试用） */
  readonly size: number;
}

export function createLimiter(concurrency: number): Limiter {
  const max = Math.max(1, Math.floor(concurrency));
  let running = 0;
  let waiting = 0;
  const queue: Array<() => void> = [];

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    waiting++;
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        waiting--;
        running++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running--;
            const next = queue.shift();
            if (next) next();
          });
      };
      if (running < max) start();
      else queue.push(start);
    });
  };

  // 注意不能用 Object.assign：它在赋值的那一刻就把 getter 求值了，
  // `size` 会被固化成 0（这个坑被 limiter.test.ts 抓到了）。
  Object.defineProperty(run, 'size', {
    get: () => running + waiting,
    enumerable: true,
  });

  return run as Limiter;
}

/**
 * 分类浏览 / 分类表用的共享闸门。
 *
 * 定在 12：这个值是「所有源合起来」的上限，单源自己还有 `sourceLimiter(3)`
 * 兜底，所以放宽它不会让某一个站被打爆——真正会被打爆的维度是「单源并发」，
 * 而那个维度已经单独管住了。
 *
 * 原来定在 6，是按「4 个源 × 3 个子分类」估的；内置源涨到 13 个之后，
 * 13 个源的分类表在 6 个槽位里排 3 轮，慢源（单源 10 秒超时）一占就是两轮，
 * 实测「电影」分类首次浏览 44.6 秒、首页 8 分类探测 104 秒，主要就是排队等出来的。
 * 放宽到 12 之后同样的请求量只需一半轮次。
 */
export const CATALOG_LIMITER_CONCURRENCY = 12;
export const catalogLimiter = createLimiter(CATALOG_LIMITER_CONCURRENCY);

const sourceLimiters = new Map<string, Limiter>();

/**
 * 单个源自己的闸门：一个源内部的子分类请求不要扎堆。
 *
 * 按源地址分配，所以源之间仍然可以并行；同为 3 是因为实测单个采集站
 * 同时超过 3 个请求就开始 503。
 */
export function sourceLimiter(key: string): Limiter {
  let limiter = sourceLimiters.get(key);
  if (!limiter) {
    limiter = createLimiter(3);
    sourceLimiters.set(key, limiter);
  }
  return limiter;
}
