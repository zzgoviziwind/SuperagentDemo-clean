import type { CardConfig } from './feishu.ts';

type Frame={headers:{key:string;value:string}[]};
type FrameHandler={handleEventData(frame:Frame):Promise<void>};

// SDK 1.76 routes event frames through its fragment cache/acknowledgement path
// and drops card frames before dispatch. Normalize only that frame type.
export function forwardCardFrames(client:unknown) {
  const target=client as FrameHandler;
  if(typeof target.handleEventData!=='function') throw new Error('飞书长连接卡片协议不兼容');
  const dispatch=target.handleEventData.bind(target);
  target.handleEventData=frame=>dispatch(frame.headers.some(h=>h.key==='type'&&h.value==='card')
    ? {...frame,headers:frame.headers.map(h=>h.key==='type'&&h.value==='card'?{...h,value:'event'}:h)}:frame);
}

export async function connectFeishu(c:CardConfig,secret:string,signal:AbortSignal,
  receive:(payload:unknown)=>Promise<unknown>,onFailure:()=>void) {
  const sdk=await import('@larksuiteoapi/node-sdk');
  signal.throwIfAborted();
  const logger={debug(){},info(){},warn(){},error(){},trace(){}};
  const client=new sdk.WSClient({appId:c.appId,appSecret:secret,domain:sdk.Domain.Feishu,logger,
    handshakeTimeoutMs:10000,autoReconnect:true,onError:onFailure});
  forwardCardFrames(client);
  const eventDispatcher=new sdk.EventDispatcher({logger,encryptKey:c.encryptKey||undefined})
    .register({'card.action.trigger':async (payload:unknown)=>{
      if(signal.aborted) return {toast:{type:'error',content:'服务已停止'}};
      try{return await receive(payload);}
      catch{return {toast:{type:'error',content:'飞书回调身份或卡片无效'}};}
    }});
  signal.addEventListener('abort',()=>client.close({force:true}),{once:true});
  void client.start({eventDispatcher}).catch(onFailure);
  return ()=>client.getConnectionStatus().state==='connected';
}
