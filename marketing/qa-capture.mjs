import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const output = resolve('..', 'screenshots', 'marketing-final');
mkdirSync(output, { recursive: true });
const port = 9444;
const profile = join(tmpdir(), `aiss-marketing-qa-${process.pid}`);
const browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find(item => item.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => {
  socket.addEventListener('open', resolvePromise, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
});
function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, reject) => pending.set(id, { resolve: resolvePromise, reject }));
}

await command('Page.enable');
const report = [];
try {
  for (const [width, height] of [[1440, 900], [1280, 800], [390, 844], [360, 844]]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600, screenWidth: width, screenHeight: height });
    await command('Page.navigate', { url: 'http://127.0.0.1:4174/' });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await command('Runtime.evaluate', { returnByValue: true, expression: `document.readyState === 'complete' && [...document.images].every(image => image.complete) && Boolean(document.querySelector('.hero'))` });
      if (ready.result.value) break;
      await sleep(150);
    }
    await command('Runtime.evaluate', { awaitPromise: true, expression: `document.fonts.ready` });
    await sleep(500);
    const viewport = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    writeFileSync(join(output, `marketing-${width}-viewport.png`), Buffer.from(viewport.data, 'base64'));

    const dimensions = await command('Runtime.evaluate', { returnByValue: true, expression: `({height:document.documentElement.scrollHeight,viewport:innerHeight})` });
    for (let y = 0; y < dimensions.result.value.height; y += Math.max(500, Math.round(height * .72))) {
      await command('Runtime.evaluate', { expression: `scrollTo(0,${y})` });
      await sleep(70);
    }
    await command('Runtime.evaluate', { expression: `scrollTo(0,0)` });
    await sleep(350);
    const layout = await command('Page.getLayoutMetrics');
    const content = layout.cssContentSize || layout.contentSize;
    const full = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: content.width, height: content.height, scale: 1 } });
    writeFileSync(join(output, `marketing-${width}-full.png`), Buffer.from(full.data, 'base64'));

    const metrics = await command('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const toggle=document.querySelector('.menu-toggle');
      let menuTest='desktop';
      if(getComputedStyle(toggle).display!=='none'){toggle.click();menuTest=document.querySelector('.main-nav').classList.contains('is-open')?'open-ok':'open-failed';toggle.click();}
      return {clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,pageHeight:document.documentElement.scrollHeight,portalCount:document.querySelectorAll('.portal-art').length,heroHeight:Math.round(document.querySelector('.hero').getBoundingClientRect().height),menuTest,navLinks:[...document.querySelectorAll('.main-nav a')].map(a=>a.getAttribute('href')),smallTargets:[...document.querySelectorAll('a,button')].filter(el=>el.getClientRects().length).map(el=>({label:(el.textContent||el.ariaLabel||'').trim().replace(/\\s+/g,' ').slice(0,32),w:Math.round(el.getBoundingClientRect().width),h:Math.round(el.getBoundingClientRect().height)})).filter(x=>x.w<44||x.h<44)};
    })()` });
    report.push({ width, ...metrics.result.value });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket.close();
  browser.kill();
}
