import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outputDir = resolve('screenshots');
mkdirSync(outputDir, { recursive: true });
const port = 9333;
const profile = join(tmpdir(), `aiss-qa-${process.pid}`);
const browser = spawn(chrome, ['--headless=new','--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore', windowsHide: true });

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function pageTarget() {
  for (let attempt=0; attempt<50; attempt+=1) {
    try { const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page=targets.find(target=>target.type==='page'); if(page)return page; } catch {}
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

const target=await pageTarget();
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise,reject)=>{socket.addEventListener('open',resolvePromise,{once:true});socket.addEventListener('error',reject,{once:true});});
let nextId=1;
const pending=new Map();
socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve:resolvePromise,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(message.error.message)):resolvePromise(message.result);}});
function command(method,params={}) { const id=nextId++; socket.send(JSON.stringify({id,method,params})); return new Promise((resolvePromise,reject)=>pending.set(id,{resolve:resolvePromise,reject})); }

await command('Page.enable');
const targets=[
  ['home','home','.home-page'],
  ['learn','learn','.learn-page'],
  ['schedule','learn','.week-route'],
  ['project','project','.project-page'],
  ['portfolio','portfolio','.portfolio-page'],
  ['profile','profile','.profile-page'],
  ['homework','homework=73000000-0000-4000-8000-000000000002','.homework-page'],
  ['lesson','lesson=22000000-0000-4000-8000-000000000003','.lesson-page'],
  ['error','lesson=99999999-0000-4000-8000-000000000999','.error-state']
];
const report=[];
try {
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true,screenWidth:390,screenHeight:844});
  await command('Page.navigate',{url:'http://127.0.0.1:5173/#home'});
  for (let wait=0;wait<60;wait+=1) { const ready=await command('Runtime.evaluate',{returnByValue:true,expression:`Boolean(document.querySelector('.home-page'))`}); if(ready.result.value)break; await sleep(150); }
  for (const width of [390,360]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:844});
    for (const [name,hash,expected] of targets) {
      await command('Runtime.evaluate',{expression:`location.hash=${JSON.stringify(`#${hash}`)}`});
      for (let wait=0;wait<40;wait+=1) { const ready=await command('Runtime.evaluate',{returnByValue:true,expression:`Boolean(document.querySelector('${expected}'))`}); if(ready.result.value)break; await sleep(150); }
      await sleep(700);
      const metrics=await command('Runtime.evaluate',{returnByValue:true,expression:`({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,smallTargets:[...document.querySelectorAll('button,a[href]')].filter(b=>b.getClientRects().length).map(b=>({label:(b.innerText||b.ariaLabel||'').trim().slice(0,30),w:Math.round(b.getBoundingClientRect().width),h:Math.round(b.getBoundingClientRect().height)})).filter(x=>x.w<44||x.h<44)})`});
      const shot=await command('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
      writeFileSync(join(outputDir,`phase2-cdp-${width}-${name}.png`),Buffer.from(shot.data,'base64'));
      report.push({width,name,...metrics.result.value});
    }
  }
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await command('Runtime.evaluate',{expression:`location.hash='#home'`});
  await sleep(400);
  const reduced=await command('Runtime.evaluate',{returnByValue:true,expression:`({activeAnimations:document.getAnimations().filter(animation=>animation.playState==='running').length,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches})`});
  report.push({width:360,name:'reduced-motion',...reduced.result.value});
  console.log(JSON.stringify(report,null,2));
} finally {
  socket.close();
  browser.kill();
}
