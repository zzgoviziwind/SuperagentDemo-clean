// Loaded only by the dedicated HTTP test child. Both provider URLs terminate at its loopback receipt server.
const send=globalThis.fetch;
const origin=new URL(process.env.TEST_FEISHU_LOOPBACK);
if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:') throw new Error('Expected loopback fixture');
globalThis.fetch=(input,opts)=>{
  const u=new URL(input instanceof Request?input.url:input);
  if(['https://accounts.feishu.cn','https://open.feishu.cn'].includes(u.origin)) return send(new URL(u.pathname+u.search,origin),opts);
  if(u.hostname!=='127.0.0.1') throw new Error('Unexpected fixture connection');
  return send(input,opts);
};
