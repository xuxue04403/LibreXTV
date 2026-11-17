import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startMediaProxy, assertAllowedTarget, fetchChecked, readLimited, type MediaProxy } from './proxy';
import { castToDevice, discoverDevices, parseDeviceDescription, stopCast, type DlnaDevice } from './dlna';
import { fetchRecommend } from './recommend';
import { probeQuality } from './quality';
import type { SourceConfig } from '@librextv/core';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** IPC 抓取（元数据接口）的响应上限；大文件走媒体代理的流式路径 */
const MAX_IPC_BODY_BYTES = 16 * 1024 * 1024;

/**
 * 把 undici 的 `fetch failed` 翻译成人能看懂的原因。
 *
 * undici 在 DNS 解析失败、TLS 握手失败、连接被重置时统一抛 `TypeError: fetch failed`，
 * 真正原因藏在 `cause` 里。原来直接把这个字符串传到界面上，用户看到的
 * 「1 个源失败（fetch failed）」等于什么都没说。
 */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return '网络请求失败';
  const cause = (err as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === 'object'
      ? ((cause as { code?: string }).code ?? (cause as { errno?: string }).errno)
      : undefined;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败';
    case 'ECONNREFUSED':
      return '连接被拒绝';
    case 'ECONNRESET':
      return '连接被重置';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '连接超时';
    case 'UND_ERR_HEADERS_TIMEOUT':
      return '响应超时';
    case 'UND_ERR_SOCKET':
      return '连接中断';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return '证书校验失败';
    default:
      break;
  }
  const message = typeof (cause as { message?: string })?.message === 'string' ? (cause as { message: string }).message : '';
  if (message && message !== err.message) return `${err.message}：${message}`;
  return err.message;
}

let win: BrowserWindow | null = null;
let proxy: MediaProxy | null = null;

const isDev = !!process.env.ELECTRON_RENDERER_URL;

/**
 * 允许用环境变量指定数据目录。
 *
 * 便携版应当把数据放在 exe 旁边（否则同一台机器上的安装版和便携版会互相覆盖
 * 历史、源和设置），自动化脚本也需要一个干净目录来跑，不能污染用户真实数据。
 * 必须放在 app ready 之前执行，setPath 之后才生效。
 */
const userDataOverride = process.env.LIBREXTV_USER_DATA;
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

/** 窗口/任务栏图标：与上游 LibreTV 同一套 artwork（打包后放在 resources/icon.png） */
const appIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '../../resources/icon.png');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    icon: appIcon,
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    title: 'LibreXTV',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 electron 模块，开沙箱不需要额外放宽
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  // 全屏状态回推：F11 / 菜单栏切换不经过渲染层的按钮，靠事件让图标与状态跟上
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen-changed', true));
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen-changed', false));

  // 站外链接交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win?.webContents.getURL() ?? '';
    if (url !== current) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL as string);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 构建冒烟：LTV_SMOKE=<png 路径> 时加载完成后截图并退出（CI / 本地验证用）
  // LTV_SMOKE_SEED：写入 localStorage 的 zustand 快照（JSON 字符串），用于预置数据源
  // LTV_SMOKE_JS：截图前执行的页面脚本（例如触发搜索、点击卡片）
  // LTV_SMOKE_DELAY：截图前的等待毫秒数（默认 2000），慢异步页面可调大
  const smokeShot = process.env.LTV_SMOKE;
  const smokeSeed = process.env.LTV_SMOKE_SEED;
  const smokeJs = process.env.LTV_SMOKE_JS;
  const smokeDelay = Math.max(0, Number(process.env.LTV_SMOKE_DELAY ?? 2000) || 0);
  if (smokeShot) {
    let seeded = false;
    win.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    win.webContents.on('did-finish-load', () => {
      void (async () => {
        if (smokeSeed && !seeded) {
          seeded = true;
          try {
            await win?.webContents.executeJavaScript(
              `localStorage.setItem('librextv-desktop-v1', ${JSON.stringify(smokeSeed)})`
            );
          } catch (err) {
            console.error('smoke seed failed', err);
          }
          win?.webContents.reload();
          return;
        }
        await new Promise((r) => setTimeout(r, smokeDelay));
        if (smokeJs) {
          try {
            await win?.webContents.executeJavaScript(smokeJs);
          } catch (err) {
            console.error('smoke js failed', err);
          }
          await new Promise((r) => setTimeout(r, 6000));
        }
        try {
          const image = await win?.webContents.capturePage();
          if (image) await fs.writeFile(smokeShot, image.toPNG());
        } catch (err) {
          console.error('smoke capture failed', err);
        } finally {
          app.exit(0);
        }
      })();
    });
  }

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出 LibreXTV' }],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  proxyBase: proxy?.base ?? '',
  isDev,
}));

/**
 * 首页推荐：渲染层只传枚举参数（kind / 榜单 id / 推荐类型 / 内置标签），
 * 第三方地址与 UA/Referer 全在主进程固定，避免把任意 URL 抓取面暴露给页面。
 */
ipcMain.handle('recommend:fetch', async (_event, input: unknown) => {
  try {
    const items = await fetchRecommend(input);
    return { ok: true as const, items, fetchedAt: Date.now() };
  } catch (err) {
    return {
      ok: false as const,
      items: [],
      error: err instanceof Error ? err.message : '推荐内容加载失败',
    };
  }
});

/**
 * 画质探测：渲染层传源配置与影片 ID，主进程负责抓播放列表/分片前缀。
 * 放主进程的原因：m3u8 与分片没有 CORS 头，渲染层 fetch 会被浏览器拦；
 * 且分片只读前缀，不必把几十 MB 的内容搬进渲染层。
 */
ipcMain.handle('quality:probe', async (_event, input: unknown) => {
  if (!input || typeof input !== 'object') {
    return { ok: false as const, error: '无效的探测请求', retryable: false, cached: false };
  }
  const { source, vodId } = input as { source?: unknown; vodId?: unknown };
  if (!source || typeof source !== 'object' || typeof vodId !== 'string') {
    return { ok: false as const, error: '无效的探测请求', retryable: false, cached: false };
  }
  try {
    const result = await probeQuality({ source: source as SourceConfig, vodId });
    return result;
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : '画质探测失败',
      retryable: false,
      cached: false,
    };
  }
});

ipcMain.handle(
  'http:fetch',
  async (
    _event,
    url: string,
    options?: { headers?: Record<string, string>; timeoutMs?: number; method?: string; body?: string }
  ) => {
    const started = Date.now();
    const fail = (status: number, error: string) => ({
      ok: false,
      status,
      url,
      headers: {} as Record<string, string>,
      text: '',
      bytes: new Uint8Array(),
      ms: Date.now() - started,
      error,
    });

    // 与媒体代理同一套边界：渲染层不能借这条 IPC 探测内网或做任意方法请求
    let target: URL;
    try {
      target = await assertAllowedTarget(url, process.env.LTV_ALLOW_PRIVATE_MEDIA === '1');
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : '地址不可用');
    }
    const method = (options?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') return fail(405, '不支持的请求方法');

    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/json, text/plain, */*',
      ...(options?.headers ?? {}),
    };
    try {
      // 逐跳校验（S2）：只在入口校验一次、然后 redirect:'follow' 的话，
      // 一个公网 URL 302 到 127.0.0.1 就能绕过全部内网防护。
      const res = await fetchChecked(
        target,
        {
          method,
          headers,
          body: options?.body,
          signal: AbortSignal.timeout(Math.min(60_000, Math.max(1000, options?.timeoutMs ?? 12_000))),
        },
        process.env.LTV_ALLOW_PRIVATE_MEDIA === '1'
      );
      // 流式限长（M1）：不能先 arrayBuffer() 再判长度，chunked 响应不受控
      let buf: Uint8Array;
      try {
        buf = await readLimited(res, MAX_IPC_BODY_BYTES);
      } catch (err) {
        if (err instanceof Error && err.message === '响应体过大') return fail(413, '响应体过大');
        throw err;
      }
      const headerMap: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headerMap[k.toLowerCase()] = v;
      });
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        headers: headerMap,
        text: new TextDecoder('utf-8').decode(buf),
        bytes: buf,
        ms: Date.now() - started,
      };
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // undici 在 DNS / TLS / 连接被重置时只给一个 "fetch failed"，对用户毫无信息量。
      // 把真正的原因（cause）解出来，界面上才有可行动的提示。
      return fail(timeout ? 408 : 0, timeout ? '请求超时' : describeFetchError(err));
    }
  }
);

/**
 * 流式抓取（直播 M3U / XMLTV）。
 *
 * 为什么单独开一条通道：`http:fetch` 必须等响应体整个落地才返回，
 * 而 iptv-org 的 index.m3u 有 2.5MB、实测服务器限速到 ~35KB/s，要下 70 秒。
 * 这里改为边收边把分块推给渲染层，主播只要几百毫秒就能看到第一批频道。
 *
 * 每个流带一个递增 id，配 `http:stream:cancel` 用于切页/换源时中止。
 */
const activeStreams = new Map<number, AbortController>();
let streamSeq = 0;

ipcMain.handle(
  'http:stream',
  async (
    event,
    url: string,
    options?: { headers?: Record<string, string>; idleTimeoutMs?: number; streamId?: number }
  ) => {
    const started = Date.now();
    let target: URL;
    try {
      target = await assertAllowedTarget(url, process.env.LTV_ALLOW_PRIVATE_MEDIA === '1');
    } catch (err) {
      return { ok: false, status: 400, url, error: err instanceof Error ? err.message : '地址不可用', ms: 0 };
    }

    const streamId = options?.streamId ?? ++streamSeq;
    const controller = new AbortController();
    activeStreams.set(streamId, controller);
    // 不再用 `http:stream:started` 广播分配 id：那是 webContents 级广播，并发开流时
    // 各 invoke 会互相抢「第一个收到的 id」。现在 id 由 preload 在开流前定好传下来。
    const idleTimeoutMs = Math.min(120_000, Math.max(5_000, options?.idleTimeoutMs ?? 30_000));
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      // 只限「多久没数据」，不限制总时长：大列表合法地要下一分钟
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };

    try {
      armIdle();
      // 同样必须逐跳校验（S2）：直播源 302 到内网时，follow 会绕开入口校验
      const res = await fetchChecked(
        target,
        {
          headers: {
            'User-Agent': DEFAULT_UA,
            Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, application/xml, text/plain, */*',
            ...(options?.headers ?? {}),
          },
          signal: controller.signal,
        },
        process.env.LTV_ALLOW_PRIVATE_MEDIA === '1',
        assertAllowedTarget,
        idleTimeoutMs
      );

      const headerMap: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headerMap[k.toLowerCase()] = v;
      });

      if (!res.ok) {
        return { ok: false, status: res.status, url: res.url || url, headers: headerMap, error: `HTTP ${res.status}`, ms: Date.now() - started };
      }
      if (!res.body) {
        return { ok: true, status: res.status, url: res.url || url, headers: headerMap, bytes: 0, ms: Date.now() - started };
      }

      const reader = res.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        bytes += value.byteLength;
        if (bytes > MAX_IPC_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, status: 413, url, headers: headerMap, error: '响应体过大', ms: Date.now() - started };
        }
        // 拷贝一份再发：value 的 buffer 可能被 undici 复用
        event.sender.send('http:stream:chunk', streamId, Buffer.from(value));
      }
      return { ok: true, status: res.status, url: res.url || url, headers: headerMap, bytes, ms: Date.now() - started };
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted);
      // 读循环里抛错时上游连接还挂着：这里主动断一次，
      // 否则那条 socket 要等对端超时才会释放（大列表翻页失败时会累积）。
      if (!aborted) controller.abort();
      return {
        ok: false,
        status: aborted ? 408 : 0,
        url,
        error: aborted ? '请求超时' : err instanceof Error ? err.message : '网络请求失败',
        ms: Date.now() - started,
      };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      activeStreams.delete(streamId);
    }
  }
);

ipcMain.handle('http:stream:cancel', (_event, streamId: number) => {
  activeStreams.get(streamId)?.abort();
  activeStreams.delete(streamId);
});

ipcMain.handle('window:toggle-fullscreen', () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});
ipcMain.handle('window:set-fullscreen', (_event, value: boolean) => {
  win?.setFullScreen(Boolean(value));
  return Boolean(value);
});
ipcMain.handle('window:is-fullscreen', () => win?.isFullScreen() ?? false);

ipcMain.handle('window:minimize', () => win?.minimize());

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
});

ipcMain.handle('dialog:save-text', async (_event, defaultName: string, content: string) => {
  if (!win) return { ok: false as const, canceled: true };
  const result = await dialog.showSaveDialog(win, {
    // 文件名只取 basename：渲染层不能借此把文件写到任意目录
    defaultPath: path.basename(String(defaultName || 'librextv-export.json')),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false as const, canceled: true };
  await fs.writeFile(result.filePath, content, 'utf8');
  return { ok: true as const, path: result.filePath };
});

/**
 * 校验渲染层传来的 DLNA 设备对象，并返回**可信的那一份**。
 *
 * S3 当初只修了 `dlna:cast`，`dlna:stop` 仍然把渲染层给的 `device.controlUrl`
 * 直接交给 `soap()` 去 POST。于是渲染层获得一个「向任意地址 POST XML」的原语
 * （能打内网，而 `http:fetch` 只能到公网）。
 *
 * 只校验「controlUrl 与 location 同源」是不够的：这两个字段**都来自渲染层**，
 * 传 `{location:'http://10.0.0.5:8080/desc.xml', controlUrl:'http://10.0.0.5:8080/任意路径'}`
 * 就能满足同源，照样向任意内网地址发 SOAP。
 *
 * 所以改成：拿 location 去拉设备描述，**从描述 XML 里重新解析 controlURL**，
 * 并且要求它和渲染层传来的那个一致。这样 SOAP 的目标必须真的被那台设备声明过。
 */
async function assertCastableDevice(device: DlnaDevice): Promise<DlnaDevice> {
  if (!device || typeof device.location !== 'string' || typeof device.controlUrl !== 'string') {
    throw new Error('设备信息不完整');
  }
  let deviceUrl: URL;
  let control: URL;
  try {
    deviceUrl = new URL(device.location);
    control = new URL(device.controlUrl);
  } catch {
    throw new Error('设备地址无效');
  }
  if (deviceUrl.protocol !== 'http:' && deviceUrl.protocol !== 'https:') throw new Error('设备地址协议不受支持');
  if (control.protocol !== 'http:' && control.protocol !== 'https:') throw new Error('控制地址协议不受支持');
  if (control.origin !== deviceUrl.origin) throw new Error('控制地址与设备不同源');

  // 最后一步：真的去读一次设备描述，用 XML 里声明的 controlURL 作为可信来源。
  // 这既是「设备确实存在」的确认，也让 SOAP 的目标不能再由渲染层随意指定。
  // DLNA 设备必然在内网，所以这里 allowPrivate = true；但能发 SOAP 的地址
  // 必须是这台设备在自己的描述里声明过的那个，而不是渲染层给的字符串。
  const desc = await fetchChecked(
    deviceUrl,
    { signal: AbortSignal.timeout(6_000), headers: { Accept: 'text/xml, application/xml' } },
    true
  );
  if (!desc.ok) throw new Error(`设备描述读取失败（HTTP ${desc.status}）`);
  const xml = (await readLimited(desc, 64 * 1024)).toString('utf8');
  const parsed = parseDeviceDescription(xml, device.location);
  if (!parsed) throw new Error('设备描述无法解析');
  if (parsed.controlUrl !== control.href) throw new Error('控制地址与设备描述不一致');
  return parsed;
}

// —— DLNA 投屏（发送端） ——
ipcMain.handle('dlna:discover', async () => {
  try {
    return { ok: true as const, devices: await discoverDevices() };
  } catch (err) {
    return { ok: false as const, devices: [], error: err instanceof Error ? err.message : '搜索失败' };
  }
});

ipcMain.handle('dlna:cast', async (_event, device: DlnaDevice, url: string, title: string) => {
  try {
    // 渲染层传来的 device 不可全信：用设备描述里声明的那份 controlURL 覆盖掉它
    const trusted = await assertCastableDevice(device);
    if (!/^https?:\/\//i.test(url)) throw new Error('投屏地址无效');
    await castToDevice(trusted, url, title);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : '投屏失败' };
  }
});

ipcMain.handle('dlna:stop', async (_event, device: DlnaDevice) => {
  try {
    // 与 cast 同一套校验：stop 也会向 controlUrl 发 SOAP，不能留成后门
    const trusted = await assertCastableDevice(device);
    await stopCast(trusted);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : '停止失败' };
  }
});

ipcMain.handle('dialog:open-text', async () => {  if (!win) return { ok: false as const, canceled: true };
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json', 'txt'] }],
  });
  const file = result.filePaths[0];
  if (result.canceled || !file) return { ok: false as const, canceled: true };
  // 用户选错文件（比如一个几 GB 的视频）时，原来的 readFile(file,'utf8')
  // 会把整个文件读进主进程内存。订阅/备份都是文本，10MB 足够，超了直接拒绝。
  const stat = await fs.stat(file);
  if (stat.size > 10 * 1024 * 1024) {
    return { ok: false as const, canceled: false, error: '文件超过 10MB，可能不是订阅或备份文件' };
  }
  const content = await fs.readFile(file, 'utf8');
  return { ok: true as const, path: file, content };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('org.librextv.desktop');
    proxy = await startMediaProxy();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // closeAllConnections 才能让 keep-alive 下的 server.close 立即回调，否则会挂住退出
    void proxy?.close();
  });
}
