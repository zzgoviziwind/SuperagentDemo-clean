import { buildServer } from './server.js';
import { preparePythonRollback } from './rollback.js';

async function serve() {
  const port = Number(process.env.SUPERAGENT_PORT ?? 18765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  const app = await buildServer(process.env);
  try {
    const address = await app.listen({host:'127.0.0.1',port});
    process.stdout.write(JSON.stringify({implementation:'typescript',address})+'\n');
    process.once('SIGTERM', () => { void app.close(); });
    process.once('SIGINT', () => { void app.close(); });
  } catch (error) {
    await app.close();
    throw error;
  }
}

if(process.argv.length===2) await serve();
else if(process.argv.length===3 && process.argv[2]==='--prepare-python-rollback')
  process.stdout.write(JSON.stringify(await preparePythonRollback(process.env))+'\n');
else throw new Error('不支持的启动参数');
