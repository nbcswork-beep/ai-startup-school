import { emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';

const webhookUrl=process.argv[2];
if(!webhookUrl){console.error('Usage: npm run bot:set-webhook -- https://your-domain/api/telegram/webhook');process.exitCode=1}
else{
  const parsed=new URL(webhookUrl);
  if(parsed.protocol!=='https:')throw new Error('Webhook URL must use HTTPS');
  if(!stdin.isTTY||!stdout.isTTY)throw new Error('Run this command in an interactive terminal');
  emitKeypressEvents(stdin);
  const hidden=async label=>{stdout.write(label);stdin.setRawMode(true);stdin.resume();let value='';try{for await(const chunk of stdin){const text=String(chunk);if(text==='\r'||text==='\n')break;if(text==='\u0003')throw new Error('Cancelled');if(text==='\u007f'||text==='\b'){value=value.slice(0,-1);continue}if(!text.startsWith('\u001b'))value+=text}}finally{stdin.setRawMode(false);stdout.write('\n')}return value};
  const token=await hidden('Telegram bot token: ');
  const secret=await hidden('TELEGRAM_WEBHOOK_SECRET: ');
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw new Error('Invalid Telegram bot token format');
  if(!/^[A-Za-z0-9_-]{16,256}$/.test(secret))throw new Error('Webhook secret must contain 16-256 letters, digits, underscores, or hyphens');
  const response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:webhookUrl,secret_token:secret,allowed_updates:['message'],drop_pending_updates:false})});
  const result=await response.json().catch(()=>({ok:false,description:'Invalid Telegram response'}));
  if(!response.ok||!result.ok)throw new Error(result.description||`Telegram returned ${response.status}`);
  console.log('Telegram webhook registered successfully.');
}
