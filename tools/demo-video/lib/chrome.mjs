// 无头 Chrome 的最小 CDP 客户端：用 --remote-debugging-pipe（继承的管道 fd 3/4，不监听任何端口）。
// 每个实例一份独立的临时用户目录，用完即删。只做渲染需要的几件事：打开页面、执行脚本、截图。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('找不到 Chrome。可以用环境变量 CHROME_PATH 指定可执行文件。');
  return found;
}

export class Chrome {
  /** @param {{width:number,height:number,scale?:number}} size */
  static async launch({ width, height, scale = 1 }) {
    const profile = await mkdtemp(path.join(tmpdir(), 'oaa-demo-chrome-'));
    const child = spawn(
      findChrome(),
      [
        '--headless=new',
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        '--allow-file-access-from-files',
        '--disable-gpu',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        `--window-size=${width},${height}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    );
    const chrome = new Chrome(child, profile);
    await chrome.#attach();
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    return chrome;
  }

  #child;
  #profile;
  #next = 1;
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #sessionId = null;
  #listeners = [];
  closed = false;
  /** 页面里抛出的未捕获异常与 console.error（渲染页出错时靠它定位）。 */
  pageErrors = [];

  constructor(child, profile) {
    this.#child = child;
    this.#profile = profile;
    child.on('exit', () => {
      this.closed = true;
      for (const { reject } of this.#pending.values()) reject(new Error('Chrome 已退出'));
      this.#pending.clear();
    });
    child.stdio[4].on('data', (chunk) => this.#onData(chunk));
    this.#listeners.push((m) => {
      if (m.method === 'Runtime.exceptionThrown')
        this.pageErrors.push(
          m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text,
        );
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        this.pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    });
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let zero;
    while ((zero = this.#buffer.indexOf(0)) >= 0) {
      const text = this.#buffer.subarray(0, zero).toString('utf8');
      this.#buffer = this.#buffer.subarray(zero + 1);
      if (!text) continue;
      const message = JSON.parse(text);
      if (message.id && this.#pending.has(message.id)) {
        const { resolve, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) for (const fn of this.#listeners) fn(message);
    }
  }

  send(method, params = {}, { browser = false } = {}) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (this.#sessionId && !browser) payload.sessionId = this.#sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdio[3].write(
        Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([0])]),
      );
    });
  }

  async #attach() {
    const { targetInfos } = await this.send('Target.getTargets', {}, { browser: true });
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await this.send(
      'Target.attachToTarget',
      { targetId: page.targetId, flatten: true },
      { browser: true },
    );
    this.#sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  /** 打开地址并等 load 事件；页面自己再决定何时「就绪」（见 evaluate）。 */
  async goto(url) {
    // 先回到空白页：只差一个 #hash 的跳转是同文档导航，不会触发 load，也不会重新执行页面脚本。
    await this.#navigate('about:blank');
    await this.#navigate(url);
  }

  async #navigate(url) {
    const loaded = new Promise((resolve) => {
      const fn = (m) => {
        if (m.method === 'Page.loadEventFired') {
          this.#listeners = this.#listeners.filter((x) => x !== fn);
          resolve();
        }
      };
      this.#listeners.push(fn);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** 执行表达式（支持 await），返回按值序列化的结果；页面抛错时带上描述。 */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails)
      throw new Error(
        `页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}` +
          (this.pageErrors.length ? `\n页面报错：\n${this.pageErrors.slice(0, 5).join('\n')}` : ''),
      );
    return result.value;
  }

  /** clip（可选）：{x, y, width, height}，单位是 CSS 像素；输出的像素数是它乘以设备像素比。 */
  async screenshot({ format = 'png', quality, clip } = {}) {
    const { data } = await this.send('Page.captureScreenshot', {
      format,
      ...(quality ? { quality } : {}),
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return Buffer.from(data, 'base64');
  }

  async close() {
    if (!this.closed) {
      try {
        await this.send('Browser.close', {}, { browser: true });
      } catch {}
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          this.#child.kill('SIGKILL');
          resolve();
        }, 3000);
        this.#child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        if (this.closed) resolve();
      });
    }
    await rm(this.#profile, { recursive: true, force: true });
  }
}
