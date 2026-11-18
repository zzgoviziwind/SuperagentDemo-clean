import { buildServer } from '../../server.ts';
import { randomInt } from 'node:crypto';

const app=await buildServer({...process.env,SUPERAGENT_DATA_DIR:process.argv[2]});
// Windows port 0 can allocate a low port rejected by the HTTP fetch client.
async function listen() {
  for(let attempt=0;;attempt++){
    try{return await app.listen({host:'127.0.0.1',port:randomInt(49152,65536)});}
    catch(error){
      if(attempt>=15 || !['EADDRINUSE','EACCES'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
    }
  }
}
const address=await listen();
process.once('message',async()=>{await app.close();process.disconnect!();});
process.send!({address});
