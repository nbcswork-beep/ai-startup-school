import type { AppRepository } from '../data/repository.js';
import type { NotificationDeliveryDto } from '../types/domain.js';

export interface NotificationSender {
  send(notification:NotificationDeliveryDto):Promise<{sent:true}|{sent:false;errorCode:string;retryable:boolean}>;
}

export class TelegramNotificationSender implements NotificationSender {
  constructor(private readonly botToken:string,private readonly fetcher:typeof fetch=fetch){}

  async send(notification:NotificationDeliveryDto):Promise<{sent:true}|{sent:false;errorCode:string;retryable:boolean}>{
    const button=notification.buttonText&&(notification.buttonUrl||notification.callbackData)?{
      text:notification.buttonText,
      ...(notification.buttonUrl?{url:notification.buttonUrl}:{callback_data:notification.callbackData!})
    }:null;
    try{
      const response=await this.fetcher(`https://api.telegram.org/bot${this.botToken}/sendMessage`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:notification.recipientTelegramId,text:notification.text,...(button?{reply_markup:{inline_keyboard:[[button]]}}:{})})
      });
      if(response.ok)return{sent:true};
      return{sent:false,errorCode:response.status===429?'TELEGRAM_RATE_LIMIT':response.status>=500?'TELEGRAM_TEMPORARY':'TELEGRAM_REJECTED',retryable:response.status===429||response.status>=500};
    }catch{return{sent:false,errorCode:'TELEGRAM_NETWORK',retryable:true};}
  }
}

export class NotificationWorker {
  constructor(private readonly repository:AppRepository,private readonly sender:NotificationSender,private readonly weeklyDay:number,private readonly weeklyHour:number){}

  async run(now=new Date()):Promise<{claimed:number;sent:number;failed:number}>{
    const batch=await this.repository.prepareNotificationBatch(now,this.weeklyDay,this.weeklyHour,50);
    let sent=0,failed=0;
    for(const notification of batch){
      const result=await this.sender.send(notification);
      await this.repository.completeNotificationDelivery(notification.id,result.sent,result.sent?null:result.errorCode,now,result.sent?false:result.retryable);
      if(result.sent)sent+=1;else failed+=1;
    }
    return{claimed:batch.length,sent,failed};
  }
}
