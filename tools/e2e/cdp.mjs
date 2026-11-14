/**
 * 极简 CDP 客户端：用 Node 内置 WebSocket 驱动桌面端做端到端验证。
 *
 * 之所以不用 puppeteer：仓库不想为一个验证脚本引入几百 MB 的浏览器依赖，
 * 而 Electron 已经开着 `--remote-debugging-port`，直连足够。
 *
 * 用法：node tools/e2e/cdp.mjs <操作> [参数...]
 *   eval <表达式>        在页面上下文求值并打印结果
 *   click <文本>         点击文本匹配的按钮/链接
 *   type <文本>          在当前焦点元素输入
 *   shot <路径>          截图
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT ?? 9333);

async function target() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面 target');
  return page.webSocketDebuggerUrl;
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === undefined) {
        // 事件推送：交给订阅者，无人订阅则忽略
        for (const handler of this.handlers.get(msg.method) ?? []) {
          try {
            handler(msg.params);
          } catch {
            /* 订阅者异常不影响会话 */
          }
        }
        return;
      }
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      }
    });
  }

  /** 订阅 CDP 事件（如 Network.requestWillBeSent） */
  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

export async function connect() {
  const url = await target();
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  const session = new Session(ws);
  await session.send('Runtime.enable');
  await session.send('Page.enable');
  return session;
}

/** 在页面里求值，返回 JS 值的 JSON 表示 */
export async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(detail.exception?.description ?? detail.text ?? '页面求值异常');
  }
  return result.result.value;
}

/**
 * 同 evaluate，但允许在表达式里写 await。
 *
 * evaluate 包的是同步箭头函数，`await` 会直接语法错误（`await is only valid in
 * async functions`）。要调用 `window.librextv.info()` 这类返回 Promise 的接口时用这个。
 */
export async function evaluateAsync(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(detail.exception?.description ?? detail.text ?? '页面求值异常');
  }
  return result.result.value;
}

export async function click(session, text) {
  const escaped = JSON.stringify(text);
  return evaluate(
    session,
    `const wanted = ${escaped};
     const nodes = [...document.querySelectorAll('button, a, [role="button"], .card, .cat-chip')];
     const hit = nodes.find((n) => (n.textContent || '').includes(wanted) && !n.disabled);
     if (!hit) return { ok: false, seen: nodes.map((n) => (n.textContent || '').trim().slice(0, 24)).slice(0, 40) };
     hit.click();
     return { ok: true, text: (hit.textContent || '').trim().slice(0, 40) };`
  );
}

export async function shot(session, path) {
  const result = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  return path;
}

// 只有直接运行本文件才走 CLI；被 import 时（含 `node -e`）不进这段
const entry = process.argv[1] ? `file:///${process.argv[1].replace(/\\/g, '/')}` : '';
if (entry && import.meta.url === entry) {
  const [op, ...rest] = process.argv.slice(2);
  const session = await connect();
  try {
    if (op === 'eval') {
      console.log(JSON.stringify(await evaluate(session, rest.join(' ')), null, 2));
    } else if (op === 'evala') {
      // 允许 await：量「点进去到第一张卡片出现」这种时序，只能在页面里等
      console.log(JSON.stringify(await evaluateAsync(session, rest.join(' ')), null, 2));
    } else if (op === 'click') {
      console.log(JSON.stringify(await click(session, rest.join(' ')), null, 2));
    } else if (op === 'shot') {
      console.log(await shot(session, rest[0]));
    } else {
      console.error('未知操作：' + op);
      process.exitCode = 1;
    }
  } finally {
    session.ws.close();
  }
}
