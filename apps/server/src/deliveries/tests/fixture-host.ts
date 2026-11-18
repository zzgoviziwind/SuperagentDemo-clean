import { buildServer } from '../../server.ts';

const app=await buildServer({...process.env,SUPERAGENT_DATA_DIR:process.argv[2]});
const address=await app.listen({host:'127.0.0.1',port:0});
process.once('message',async()=>{await app.close();process.disconnect!();});
process.send!({address});
