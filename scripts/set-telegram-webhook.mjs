import { stderr } from 'node:process';
import { readTerminalValue } from './secure-prompt.mjs';

async function main(){
  const webhookUrl=process.argv[2];
  if(!webhookUrl)throw new Error('Usage: npm run bot:set-webhook -- https://your-domain/api/telegram/webhook');
  const parsed=new URL(webhookUrl);
  if(parsed.protocol!=='https:')throw new Error('Webhook URL must use HTTPS');
  const token=await readTerminalValue('Telegram bot token (paste with Ctrl+V): ',{hidden:true});
  const secret=await readTerminalValue('TELEGRAM_WEBHOOK_SECRET (paste with Ctrl+V): ',{hidden:true});
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw new Error('Invalid Telegram bot token format');
  if(!/^[A-Za-z0-9_-]{16,256}$/.test(secret))throw new Error('Webhook secret must contain 16-256 letters, digits, underscores, or hyphens');
  let response;
  try{response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:webhookUrl,secret_token:secret,allowed_updates:['message'],drop_pending_updates:false})})}
  catch{throw new Error('Telegram webhook request failed')}
  const result=await response.json().catch(()=>({ok:false,description:'Invalid Telegram response'}));
  if(!response.ok||!result.ok)throw new Error(result.description||`Telegram returned ${response.status}`);
  console.log('Telegram webhook registered successfully.');
}

main().catch(error=>{stderr.write(`Unable to register Telegram webhook: ${error instanceof Error?error.message:'Unknown error'}\n`);process.exitCode=1});
