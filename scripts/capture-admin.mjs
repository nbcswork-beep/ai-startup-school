import { spawn } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const output=resolve('screenshots','admin-control-center');mkdirSync(output,{recursive:true});
const port=9666,profile=join(tmpdir(),`aiss-admin-qa-${process.pid}`),browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(resolvePromise=>setTimeout(resolvePromise,ms));
async function target(){for(let i=0;i<60;i+=1){try{const list=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),page=list.find(item=>item.type==='page');if(page)return page}catch{}await sleep(100)}throw new Error('Chrome DevTools endpoint did not start')}
const page=await target(),socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolvePromise,reject)=>{socket.addEventListener('open',resolvePromise,{once:true});socket.addEventListener('error',reject,{once:true})});
let nextId=1;const pending=new Map(),errors=[];socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);if(message.method==='Log.entryAdded'&&message.params.entry.level==='error')errors.push(message.params.entry.text);if(message.method==='Network.responseReceived'&&message.params.response.status>=400)errors.push(`${message.params.response.status} ${message.params.response.url}`);if(message.id&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result)}});
function command(method,params={}){const id=nextId++;socket.send(JSON.stringify({id,method,params}));return new Promise((resolvePromise,reject)=>pending.set(id,{resolve:resolvePromise,reject}))}
await command('Page.enable');await command('Runtime.enable');await command('Log.enable');await command('Network.enable');
const routes=['overview','students','teachers','guardians','groups','classes','homework','projects','portfolios','mentoring','reports','notifications','users','system','security'],tabletRoutes=['overview','students','classes','system','security'],report=[];
if(process.env.ADMIN_QA_DEV_AUTH==='true'){
  await command('Page.navigate',{url:'http://127.0.0.1:5173/login.html?activate=qa-placeholder-token-without-network-request'});await sleep(250);
  const auth=await command('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`fetch('/api/v1/auth/development',{method:'POST',credentials:'include'}).then(response=>response.status)`});
  if(auth.result.value!==200)throw new Error(`Development Admin authentication failed (${auth.result.value})`);
}
try{
  for(const [width,height,currentRoutes] of [[1440,900,routes],[1280,800,routes],[1024,768,tabletRoutes],[390,844,['students','teachers','guardians']],[360,800,['students','teachers','guardians']]]){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false,screenWidth:width,screenHeight:height});
    await command('Page.navigate',{url:`http://127.0.0.1:5173/admin.html?qa=${width}#overview`});
    for(let i=0;i<60;i+=1){const ready=await command('Runtime.evaluate',{returnByValue:true,expression:`Boolean(document.querySelector('.admin-shell'))`});if(ready.result.value)break;await sleep(150)}
    for(const route of currentRoutes){await command('Runtime.evaluate',{expression:`location.hash=${JSON.stringify(`#${route}`)}`});await sleep(route==='system'||route==='classes'?500:220);await command('Runtime.evaluate',{awaitPromise:true,expression:'document.fonts.ready'});const metrics=await command('Runtime.evaluate',{returnByValue:true,expression:`({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,pageHeight:document.documentElement.scrollHeight,route:location.hash,adminShell:Boolean(document.querySelector('.admin-shell')),studentNavigation:Boolean(document.querySelector('.bottom-nav,.student-nav')),teacherNavigation:[...document.querySelectorAll('.brand small')].some(x=>x.textContent.includes('TEACHER OS'))})`});const shot=await command('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(join(output,`admin-${width}-${route}.png`),Buffer.from(shot.data,'base64'));report.push({width,route,...metrics.result.value})}
    if(width===1440||width===390||width===360){await command('Runtime.evaluate',{expression:`location.hash='#students'`});await sleep(250);await command('Runtime.evaluate',{expression:`document.querySelector('[data-action="new-student"]')?.click()`});await sleep(150);const shot=await command('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(join(output,`admin-${width}-create-student.png`),Buffer.from(shot.data,'base64'));report.push({width,route:'create-student',modal:Boolean((await command('Runtime.evaluate',{returnByValue:true,expression:`document.querySelector('.modal-layer.open')!==null`})).result.value)})}
  }
  console.log(JSON.stringify({report,consoleErrors:[...new Set(errors)]},null,2));
}finally{socket.close();browser.kill()}
