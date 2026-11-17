import { currentAndNext, maybeGunzip, parseXmltv, type EpgProgram, type LiveEpg } from '@librextv/core';
import { http } from './bridge';

/**
 * 节目单（XMLTV）缓存。
 *
 * 为什么必须缓存且要缓存失败：一个 XMLTV 动辄几十 MB，而它包含**所有**频道的
 * 节目单。原来每次换台都重新下一次整份文件，换台越多越慢；而 iptv-org 的节目单
 * 超过主进程 16MB 的响应上限，注定失败——若不记住失败，每换一个台都要白等一遍。
 *
 * 因此：按 URL 缓存解析结果（含失败），10 分钟过期，同一 URL 只解析一次。
 */
const TTL_MS = 10 * 60 * 1000;

type ParsedEpg = Map<string, EpgProgram[]>;
type Entry = { at: number; ok: boolean; byChannel?: ParsedEpg };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

/**
 * 取（并缓存）一份 XMLTV。
 *
 * **`signal` 只影响本次调用，不绑到单飞的 promise 上**。早先的实现把第一个
 * 调用方的 signal 传给网络请求，于是换台时那一次 `abort()` 会把整个在途请求取消，
 * catch 里返回 `{ok:false}` 又被写进 10 分钟 TTL 的缓存 —— 用户切回同一批频道
 * （它们共用一个 epgUrl）时节目单全空，而且 10 分钟内不会自愈。
 *
 * 现在改成：谁调用谁判断要不要用结果；请求本身用一个页面无关的 controller，
 * 只有在「没有任何调用方还关心」时才真正取消。实现上简化为——请求不带外部
 * signal，但每个调用方在自己的 signal 触发后立刻返回缓存的旧值（或空），
 * 不阻塞 UI，网络请求继续跑完并填充缓存供后续频道复用。
 */
function load(epgUrl: string): Promise<Entry> {
  const hit = cache.get(epgUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit);

  const pending = inflight.get(epgUrl);
  if (pending) return pending;

  const task = (async (): Promise<Entry> => {
    try {
      const res = await http.request(epgUrl, {
        headers: { Accept: 'application/xml, text/xml, application/gzip, */*' },
        timeoutMs: 20_000,
      });
      if (!res.ok) return { at: Date.now(), ok: false };
      const bytes = await maybeGunzip(res.bytes);
      const text = new TextDecoder('utf-8').decode(bytes);
      return { at: Date.now(), ok: true, byChannel: parseXmltv(text) };
    } catch {
      return { at: Date.now(), ok: false };
    } finally {
      inflight.delete(epgUrl);
    }
  })();

  inflight.set(epgUrl, task);
  void task.then((entry) => {
    // 失败也缓存：iptv-org 的节目单超过主进程 16MB 上限，注定失败；
    // 不记住失败的话，每换一个台都要白等一遍。这里的失败是真的失败——
    // 请求已不再绑调用方 signal，不会把「用户换台」误记成「拉取失败」。
    cache.set(epgUrl, entry);
  });
  return task;
}

/** 在 [signal] abort 时立刻以 null 收尾，用于「不再等这份节目单」 */
function abortedAs<T>(signal: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

/**
 * 取某频道当前/下一档节目；任何失败都返回空结果，绝不抛错（节目单不该影响看直播）
 *
 * [signal] 用于「换台/退出播放页就不再等结果」：一份 XMLTV 动辄几十 MB，
 * 用户在这个台上只待了两秒就换走，没必要让 UI 继续等。请求本身仍在后台跑完并进缓存，
 * 下一个频道直接命中。
 */
export async function loadChannelEpg(
  epgUrl: string,
  channelId: string,
  signal?: AbortSignal
): Promise<LiveEpg> {
  const empty: LiveEpg = { channelId, programs: [] };
  // 已经取消：直接给空，别再去等一个几十 MB 的请求
  if (signal?.aborted) {
    const cached = cache.get(epgUrl);
    if (!cached?.ok) return empty;
  }
  const task = load(epgUrl);
  const entry = signal ? await Promise.race([task, abortedAs<Entry>(signal)]) : await task;
  const progs = entry?.ok ? (entry.byChannel?.get(channelId) ?? []) : [];
  const { current, next } = currentAndNext(progs);
  return { channelId, current, next, programs: progs };
}
