import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const [file,...args]=process.argv.slice(2);
appendFileSync(file,JSON.stringify(args)+'\n');
const arg=k=>args[args.indexOf(k)+1];
const mediaFixture=existsSync(file+'.media')?JSON.parse(readFileSync(file+'.media','utf8')):null;
const historicalTime=()=>new Date(Math.max(Date.parse(arg('--start')),Date.parse(arg('--end'))-2000)).toISOString();
if(arg('--profile')!=='offline-profile') process.exit(2);
if(args.includes('auth') && args.includes('status') && args.includes('--readonly')) {
  process.stdout.write(JSON.stringify({data:{authenticated:true,userId:mediaFixture?.account??'operator'}}));
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
} else if(args.includes('+conversation-info')){
  const id=arg('--group');
  if(id==='offline-env-probe'){
    writeFileSync(file+'.env',JSON.stringify({configDir:process.env.DWS_CONFIG_DIR??null,home:process.env.HOME,
      hasHostToken:Object.hasOwn(process.env,'SUPERAGENT_API_TOKEN'),hasSiblingVariable:Object.hasOwn(process.env,'DWS_TEST_HOST_ONLY')}));
  }
  process.stdout.write(JSON.stringify({result:{conversationInfo:{openConversationId:id==='wrong-id'?'other':id,
    singleChat:id==='private',title:id==='no-title'?' ':' 医院研发群 '}}}));
} else if(args.includes('+chat-search')) {
  const query=arg('--query');
  if(query==='DWS 拒绝') process.exit(4);
  if(query==='等待超时' || query==='查询中停用'){
    writeFileSync(file+'.search-pid',String(process.pid));
    setInterval(()=>{},1000);
  } else if(query==='坏页') process.stdout.write('{"result":{"chats":{}}}');
  else if(query==='坏 JSON') process.stdout.write('{');
  else if(args.includes('--cursor')){
    if(arg('--cursor')!=='opaque +/页=2') process.exit(3);
    process.stdout.write(JSON.stringify({result:{chats:[{openConversationId:'cid-2'}],complete:true,hasMore:false}}));
  } else process.stdout.write(JSON.stringify({data:{chats:[{openConversationId:'cid-1',name:'医院研发群'},null,{name:'无标识'}],
    complete:false,hasMore:true,nextCursor:'opaque +/页=2',stopReason:'single_page'}}));
} else if(args.includes('+messages-reply')) {
  const expected=arg('--message-id')==='peer-message' && arg('--group')==='private-chat' && arg('--open-dingtalk-id')==='peer';
  if(!expected) process.exit(3);
  process.stdout.write(JSON.stringify({data:{deliveryStatus:'delivered',messageId:'offline-answer'}}));
} else if(args.includes('+messages-mget')) {
  if(arg('--output-dir')!=='downloads'||!args.includes('--download-resources')) process.exit(6);
  if(mediaFixture){
    const id=arg('--msg-ids'),f=mediaFixture;
    if(id!=='peer-message') process.exit(7);
    mkdirSync('downloads');
    const downloads=[];
    for(let i=0;i<(f.files??1);i++){
      const bytes=f.size?Buffer.alloc(f.size):Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1sAAAAASUVORK5CYII=','base64');
      if(f.size) Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
      if(f.badSignature) bytes.fill(0);
      const localPath='downloads/photo-'+i+'.png';
      writeFileSync(localPath,bytes);
      downloads.push({localPath,sizeBytes:bytes.length,messageId:f.ledgerMessage??id,resourceType:'mediaId',resourceId:f.resource??'photo'});
    }
    if(f.delay){writeFileSync(file+'.reading','1');await new Promise(resolve=>setTimeout(resolve,f.delay));}
    process.stdout.write(JSON.stringify({data:{complete:true,hasMore:false,messages:[{messageId:f.message??id,
      conversationId:f.chat??'private-chat',senderId:f.sender}],resourceDownloads:{ok:true,partial:false,failedCount:0,
      requestedCount:downloads.length,downloadedCount:downloads.length,downloads}}}));
    process.exitCode=0;
  } else {
  const messageId=arg('--msg-ids'),conversationId='private-chat',localPath='downloads/notes.txt',bytes=Buffer.from('附件原文');
  mkdirSync('downloads');writeFileSync(localPath,bytes);
  const item={localPath,resourceType:'fileId',resourceId:'file-1',sizeBytes:bytes.length,messageId};
  const data={complete:true,hasMore:false,messages:[{messageId,conversationId}],resourceDownloads:{ok:true,partial:false,failedCount:0,failures:[],
    requestedCount:1,downloadedCount:1,downloads:[item]}};
  if(messageId==='different-source') data.messages[0].conversationId='other-chat';
  process.stdout.write(JSON.stringify({data}));
  }
} else if(args.includes('+chat-messages') && args.includes('--open-dingtalk-id')) {
  if(arg('--open-dingtalk-id')!=='peer' || arg('--page-limit')!=='5') process.exit(5);
  const conversationId='private-chat',createTime=historicalTime();
  const peerMessages=mediaFixture?.anchors??[mediaFixture?.anchor??'peer-message'];
  const messages=[...peerMessages.map(id=>['peer',id]),['operator','history-own'],['peer','history-unrelated']].map(([senderId,messageId])=>
    ({senderId,messageId,conversationId,createTime,text:'离线私聊历史'}));
  process.stdout.write(JSON.stringify({data:{complete:true,hasMore:false,conversationId,messages}}));
} else if(args.includes('+chat-messages')) {
  const time=historicalTime();
  process.stdout.write(JSON.stringify({data:{complete:true,hasMore:false,conversationId:arg('--group'),messages:[
    {messageId:'historical',senderId:'old-peer',createTime:time,conversationId:arg('--group'),text:'历史消息'}]}}));
} else process.exit(4);
