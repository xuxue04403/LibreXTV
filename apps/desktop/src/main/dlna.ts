/**
 * 桌面端 DLNA 投屏（发送端）。
 *
 * 做三件事：
 * 1. SSDP 组播搜索局域网内的 MediaRenderer（电视 / 盒子 / 投影）；
 * 2. 拉取设备描述，找到 AVTransport 的控制地址；
 * 3. 通过 SOAP 把当前播放地址推给设备（SetAVTransportURI + Play）。
 *
 * 刻意不依赖 Electron：纯 Node 实现，便于用假渲染器做端到端测试。
 */

import dgram from 'node:dgram';
import os from 'node:os';
import net from 'node:net';

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
/** 一次发现最多解析多少条设备描述（同网段有人刷包时 locations 会涨到几千） */
const MAX_DESCRIBE_TARGETS = 32;
/** 解析设备描述的并发上限（每条一次 fetch，全放开会瞬间打出几百个连接） */
const DESCRIBE_CONCURRENCY = 6;
const AVT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';

/** 设备描述上限：正常几十 KB，给 1MB 足够，防止局域网恶意设备把我们打死 */
const MAX_DESCRIPTION_BYTES = 1024 * 1024;
/** SOAP 响应上限：只有一个 errorCode/errorDescription，256KB 绰绰有余 */
const MAX_SOAP_BYTES = 256 * 1024;

export interface DlnaDevice {
  /** 设备友好名 */
  name: string;
  /** 设备描述 URL */
  location: string;
  /** AVTransport 控制地址 */
  controlUrl: string;
}

interface DiscoverOptions {
  /** 搜索等待时间（毫秒），局域网通常 1-2 秒足够 */
  timeoutMs?: number;
  /** 额外指定的设备描述地址（手动添加） */
  locations?: string[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 从设备描述 XML 中提取名称与 AVTransport 控制地址 */
export function parseDeviceDescription(xml: string, location: string): DlnaDevice | null {
  const nameMatch = /<friendlyName>([\s\S]*?)<\/friendlyName>/i.exec(xml);
  const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) ?? [];
  for (const block of serviceBlocks) {
    if (!block.includes(AVT_SERVICE)) continue;
    const control = /<controlURL>([\s\S]*?)<\/controlURL>/i.exec(block)?.[1]?.trim();
    if (!control) continue;
    let controlUrl: string;
    try {
      controlUrl = new URL(control, location).href;
    } catch {
      continue;
    }
    // controlURL 必须是同源路径：允许任意绝对地址等于允许设备把 SOAP 引到别的主机
    if (new URL(controlUrl).origin !== new URL(location).origin) continue;
    return {
      name: nameMatch ? decodeXml(nameMatch[1]) : new URL(location).hostname,
      location,
      controlUrl,
    };
  }
  return null;
}

/**
 * 带字节上限的响应体读取。
 *
 * DLNA 的对端永远是局域网里的「别人家的设备」，不是可信服务：只设超时
 * （4s/6s）而不设字节上限的话，同网段任意主机都能在这几秒里推几百 MB，
 * 把主进程（进而整个应用）打死。与媒体代理的 readLimited 同一思路：
 * 先看 Content-Length 早退，再边收边累加。
 */
async function readLimitedText(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('响应体过大');
  }
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      await res.body.cancel().catch(() => undefined);
      throw new Error('响应体过大');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function describe(location: string): Promise<DlnaDevice | null> {
  try {
    // SSDP 回包里的 location 来自局域网里任意一台主机（谁都能应答 M-SEARCH）。
    // 这里额外做一次地址白名单：只接受与本机同网段的私网地址，杜绝
    // `http://169.254.169.254/...` 这类云元数据 / 公网地址被顺手套取。
    if (!isAllowedCastAddress(location)) return null;
    const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return parseDeviceDescription(await readLimitedText(res, MAX_DESCRIPTION_BYTES), location);
  } catch {
    return null;
  }
}

/**
 * 投屏目标地址白名单：必须是私网 IPv4，且与本机某块网卡同 /16。
 *
 * 渲染层能通过 `dlna:cast` 传任意 `location`，SSDP 回包也不可信——不加这道
 * 闸门，主进程就会替调用方去 fetch 任意地址（SSRF）。回环单独放行，因为
 * 联调时假渲染器就挂在 127.0.0.1。
 */
export function isAllowedCastAddress(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIPv4(host)) {
    // 只接受点分 IPv4：主机名可能被 DNS 解析到内网/元数据地址，绕开这里
    return false;
  }
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  if (a === 127) return true;
  // 169.254/16 是链路本地（含云元数据），投屏用不到，一律拒绝
  if (a === 169 && b === 254) return false;
  const priv = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!priv) return false;
  return isSameSubnet(host, localSubnets());
}

/** 本机所有非回环 IPv4 的 /16 前缀（投屏只可能来自同一网段） */
function localSubnets(): Set<string> {
  const prefixes = new Set<string>();
  // 回环要放进白名单：本机模拟渲染器（联调）与用户自己的同机投屏都走 127.0.0.1
  prefixes.add('127.0');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && info.address) {
        prefixes.add(info.address.split('.').slice(0, 2).join('.'));
      }
    }
  }
  return prefixes;
}

/**
 * 只接受与本机同网段的 SSDP 回包，避免被局域网外的伪造响应引到别的网段。
 *
 * 注意不能拿 `socket.address().address` 当基准：UDP socket 一般是 bind 到
 * `0.0.0.0`，那个值永远不可能是对方所在网段，会让所有回包被丢掉（投屏直接找不到设备）。
 */
function isSameSubnet(address: string, prefixes: Set<string>): boolean {
  // 拿不到任何网卡信息时**必须返回 false**：返回 true 等于「任意主机都算同网段」，
  // 会让 SSDP 发现退化成无过滤地 fetch 任意地址（VPN/虚拟网卡环境很容易踩到）。
  if (prefixes.size === 0) return false;
  if (!net.isIPv4(address)) return false;
  return prefixes.has(address.split('.').slice(0, 2).join('.'));
}

/** 单飞：投屏面板挂载即探测、刷新按钮可连点，不能每次都新开 socket */
let inflight: Promise<DlnaDevice[]> | null = null;

/** SSDP 搜索：返回局域网内可投屏的设备 */
export async function discoverDevices(options: DiscoverOptions = {}): Promise<DlnaDevice[]> {
  if (inflight && !options.locations?.length) return inflight;
  const task = discoverOnce(options).finally(() => {
    inflight = null;
  });
  if (!options.locations?.length) inflight = task;
  return task;
}

async function discoverOnce(options: DiscoverOptions = {}): Promise<DlnaDevice[]> {
  const timeoutMs = options.timeoutMs ?? 2200;
  const locations = new Set<string>(options.locations ?? []);
  const subnets = localSubnets();

  await new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve();
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const location = /^location:\s*(.+)$/im.exec(text)?.[1]?.trim();
      if (!location || !/^https?:\/\//i.test(location)) return;
      // 只接受本机网段的响应：否则任意主机都能把自己伪装成渲染器，
      // 后续 SOAP 会被引到它指定的主机（SSRF）
      if (!isSameSubnet(rinfo.address, subnets)) return;
      locations.add(location);
    });

    socket.on('error', () => finish());
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* 部分网卡不支持广播 */
      }
      const targets = [AVT_SERVICE, 'ssdp:all'];
      for (const st of targets) {
        const message = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${st}`,
            '',
            '',
          ].join('\r\n')
        );
        try {
          socket.send(message, 0, message.length, SSDP_PORT, SSDP_HOST);
        } catch {
          /* 网络不可用时静默跳过 */
        }
      }
      setTimeout(finish, timeoutMs);
    });
  });

  // 上限两道：条数（同网段里有人刷 SSDP 时 locations 会涨到几千）与并发
  // （每条都要 fetch 一次描述，全放开会瞬间打出几百个连接）。
  const targets = [...locations].slice(0, MAX_DESCRIBE_TARGETS);
  const devices: (DlnaDevice | null)[] = [];
  for (let i = 0; i < targets.length; i += DESCRIBE_CONCURRENCY) {
    const batch = targets.slice(i, i + DESCRIBE_CONCURRENCY);
    devices.push(...(await Promise.all(batch.map(describe))));
  }
  const unique = new Map<string, DlnaDevice>();
  for (const device of devices) {
    if (device && !unique.has(device.controlUrl)) unique.set(device.controlUrl, device);
  }
  return [...unique.values()];
}

function buildMetadata(url: string, title: string): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:video/mp4:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

async function soap(controlUrl: string, action: string, args: Record<string, string | number>): Promise<string> {
  // controlUrl 理论上已经过 assertCastableDevice 与 describe 的白名单校验，
  // 但 soap 是导出函数，也可能被后续新增的调用路径直接用上，这里再兜一道。
  if (!isAllowedCastAddress(controlUrl)) throw new Error('控制地址不在允许的局域网范围内');
  const argsXml = Object.entries(args)
    .map(([key, value]) => `<${key}>${typeof value === 'number' ? value : escapeXml(String(value))}</${key}>`)
    .join('');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${AVT_SERVICE}">${argsXml}</u:${action}></s:Body></s:Envelope>`;

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${AVT_SERVICE}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(6000),
  });
  // 同上：SOAP 响应同样来自不可信的局域网设备，必须有字节上限
  const text = await readLimitedText(res, MAX_SOAP_BYTES);
  if (!res.ok) {
    // UPnP 错误也返回 200，真正的失败通常在 body 的 errorCode 里
    throw new Error(`投屏失败（HTTP ${res.status}）`);
  }
  const errorCode = /<errorCode>(\d+)<\/errorCode>/i.exec(text)?.[1];
  if (errorCode && errorCode !== '0') {
    const description = /<errorDescription>([\s\S]*?)<\/errorDescription>/i.exec(text)?.[1];
    throw new Error(`设备拒绝投屏（${errorCode}${description ? `：${decodeXml(description)}` : ''}）`);
  }
  return text;
}

/** 把视频地址推送到设备并开始播放 */
export async function castToDevice(device: DlnaDevice, url: string, title: string): Promise<void> {
  await soap(device.controlUrl, 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: url,
    CurrentURIMetaData: buildMetadata(url, title),
  });
  await soap(device.controlUrl, 'Play', { InstanceID: 0, Speed: 1 });
}

/** 停止设备上的投屏 */
export async function stopCast(device: DlnaDevice): Promise<void> {
  await soap(device.controlUrl, 'Stop', { InstanceID: 0 });
}
