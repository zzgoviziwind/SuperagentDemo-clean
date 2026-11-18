import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
const [file,...args]=process.argv.slice(2);
appendFileSync(file,JSON.stringify(args)+'\n');
const arg=k=>args[args.indexOf(k)+1];
if(arg('--profile')!=='offline-profile') process.exit(2);
if(args.includes('auth') && args.includes('status') && args.includes('--readonly')) {
  process.stdout.write(JSON.stringify({data:{authenticated:true,userId:'operator'}}));
} else if(args.includes('+listen-im')) {
  process.stderr.write('[event] ready test\n');
  const direct=arg('--kind')==='all-direct';
  const type=direct?'user_im_message_receive_o2o_all':'user_im_message_receive_group';
  const conversation=direct?'private-chat':arg('--chat-id');
  for(const actor of ['operator','peer']) {
    process.stdout.write(JSON.stringify({type,profile:'offline-profile',sender_open_dingtalk_id:actor,conversation_id:conversation,
      message_id:actor+'-message',event_time:Date.now(),content:'合成消息'})+'\n');
  }
  process.stdin.resume();
} else if(args.includes('+messages-reply')) {
  const expected=arg('--message-id')==='peer-message' && arg('--group')==='private-chat' && arg('--open-dingtalk-id')==='peer';
  if(!expected) process.exit(3);
  process.stdout.write(JSON.stringify({data:{deliveryStatus:'delivered',messageId:'offline-answer'}}));
} else if(args.includes('+messages-mget')) {
  if(arg('--output-dir')!=='downloads'||!args.includes('--download-resources')) process.exit(6);
  const messageId=arg('--msg-ids'),conversationId='private-chat',localPath='downloads/notes.txt',bytes=Buffer.from('附件原文');
  mkdirSync('downloads');writeFileSync(localPath,bytes);
  const item={localPath,resourceType:'fileId',resourceId:'file-1',sizeBytes:bytes.length,messageId};
  const data={complete:true,hasMore:false,messages:[{messageId,conversationId}],resourceDownloads:{ok:true,partial:false,failedCount:0,failures:[],
    requestedCount:1,downloadedCount:1,downloads:[item]}};
  if(messageId==='different-source') data.messages[0].conversationId='other-chat';
  process.stdout.write(JSON.stringify({data}));
} else if(args.includes('+chat-messages') && args.includes('--open-dingtalk-id')) {
  if(arg('--open-dingtalk-id')!=='peer' || arg('--page-limit')!=='5') process.exit(5);
  const conversationId='private-chat',createTime=new Date(Date.now()-2000).toISOString();
  const messages=[['peer','peer-message'],['operator','history-own'],['peer','history-unrelated']].map(([senderId,messageId])=>
    ({senderId,messageId,conversationId,createTime,text:'离线私聊历史'}));
  process.stdout.write(JSON.stringify({data:{complete:true,hasMore:false,conversationId,messages}}));
} else if(args.includes('+chat-messages')) {
  const time=new Date(Date.now()-1000).toISOString();
  process.stdout.write(JSON.stringify({data:{complete:true,hasMore:false,conversationId:arg('--group'),messages:[
    {messageId:'historical',senderId:'old-peer',createTime:time,conversationId:arg('--group'),text:'历史消息'}]}}));
} else process.exit(4);
