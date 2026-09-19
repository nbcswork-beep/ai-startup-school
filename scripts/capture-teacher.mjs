import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const output=resolve('screenshots','teacher-os'); mkdirSync(output,{recursive:true});
const port=9555,profile=join(tmpdir(),`aiss-teacher-qa-${process.pid}`);
const browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(resolvePromise=>setTimeout(resolvePromise,ms));
async function target(){for(let i=0;i<60;i+=1){try{const list=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=list.find(item=>item.type==='page');if(page)return page}catch{}await sleep(100)}throw new Error('Chrome DevTools endpoint did not start')}
const page=await target(),socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolvePromise,reject)=>{socket.addEventListener('open',resolvePromise,{once:true});socket.addEventListener('error',reject,{once:true})});
let nextId=1;const pending=new Map(),errors=[];socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);if(message.method==='Log.entryAdded'&&message.params.entry.level==='error')errors.push(message.params.entry.text);if(message.method==='Network.responseReceived'&&message.params.response.status>=400)errors.push(`${message.params.response.status} ${message.params.response.url}`);if(message.id&&pending.has(message.id)){const request=pending.get(message.id);pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result)}});
function command(method,params={}){const id=nextId++;socket.send(JSON.stringify({id,method,params}));return new Promise((resolvePromise,reject)=>pending.set(id,{resolve:resolvePromise,reject}))}
await command('Page.enable');await command('Runtime.enable');await command('Log.enable');await command('Network.enable');
const routes=[['overview','overview'],['group','group=70000000-0000-4000-8000-000000000001'],['class','class=71000000-0000-4000-8000-000000000001'],['attendance','attendance=71000000-0000-4000-8000-000000000001'],['homework','homework'],['review','review=74000000-0000-4000-8000-000000000002'],['student','student=10000000-0000-4000-8000-000000000001'],['projects','projects'],['mentoring','mentoring'],['reports','reports']];
const report=[];
try{
  for(const [width,height] of [[1440,900],[1280,800]]){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false,screenWidth:width,screenHeight:height});
    await command('Page.navigate',{url:`http://127.0.0.1:5173/teacher.html?qa=${width}#overview`});
    for(let i=0;i<60;i+=1){const ready=await command('Runtime.evaluate',{returnByValue:true,expression:`Boolean(document.querySelector('.os-shell'))`});if(ready.result.value)break;await sleep(150)}
    for(const [name,hash] of routes){
      await command('Runtime.evaluate',{expression:`location.hash=${JSON.stringify(`#${hash}`)}`});
      await command('Runtime.evaluate',{awaitPromise:true,expression:'document.fonts.ready'});await sleep(250);
      const metrics=await command('Runtime.evaluate',{returnByValue:true,expression:`({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,pageHeight:document.documentElement.scrollHeight,route:location.hash,protectedShell:Boolean(document.querySelector('.sidebar')),studentNavigation:Boolean(document.querySelector('.bottom-nav,.student-nav'))})`});
      const shot=await command('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(join(output,`teacher-${width}-${name}.png`),Buffer.from(shot.data,'base64'));report.push({width,name,...metrics.result.value});
    }
    if(width===1440){
      await command('Runtime.evaluate',{expression:`location.hash='#classes'`});await sleep(350);
      await command('Runtime.evaluate',{expression:`document.querySelector('[data-action="new-class"]').click()`});await sleep(150);
      const form=await command('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(join(output,'teacher-1440-class-form.png'),Buffer.from(form.data,'base64'));
      report.push({width,name:'class-form',modal:Boolean((await command('Runtime.evaluate',{returnByValue:true,expression:`document.querySelector('.modal')!==null`})).result.value)});
      await command('Runtime.evaluate',{expression:`document.querySelector('.modal-head button').click()`});
    }
  }
  console.log(JSON.stringify({report,consoleErrors:[...new Set(errors)]},null,2));
}finally{socket.close();browser.kill()}
