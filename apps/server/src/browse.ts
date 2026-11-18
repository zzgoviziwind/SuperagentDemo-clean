import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fail } from './auth.js';
import { within } from './projects.js';
import { admin } from './sql.js';

const run = promisify(execFile);
const skipped = new Set(['node_modules','target','dist','build','__pycache__','logs','output','data']);
const picker = Buffer.from(`Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择项目目录'
$dialog.ShowNewFolderButton = $false
$dialog.SelectedPath = $env:SUPERAGENT_PICKER_INITIAL
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))
  }
} finally { $dialog.Dispose() }`,'utf16le').toString('base64');

export function registerBrowse(app:FastifyInstance,env:NodeJS.ProcessEnv) {
  const rootNames=(env.SUPERAGENT_ALLOWED_REPO_ROOTS??'').split(delimiter).filter(Boolean);
  let selecting=false;
  async function directory(input:string) {
    const value=input || rootNames[0] || process.cwd();
    if(!isAbsolute(value)) fail(422,'目录必须为绝对路径');
    try {
      const path=await realpath(value);
      if(!await stat(path).then(s=>s.isDirectory())) fail(422,'请选择目录');
      const roots=await Promise.all(rootNames.map(r=>realpath(r)));
      if(roots.length && !roots.some(r=>within(r,path))) fail(422,'目录超出项目范围');
      return path;
    } catch {return fail(422,'目录不存在或超出项目范围');}
  }
  app.get('/api/v1/project-workspace',async req=>{
    admin(req.principal);
    const {path}=z.object({path:z.string().default('')}).parse(req.query);
    const current=await directory(path);
    const children=await readdir(current,{withFileTypes:true});
    const directories=children.filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&!d.isSymbolicLink()).map(d=>({
      name:d.name,path:join(current,d.name),repository:existsSync(join(current,d.name,'.git'))})).sort((a,b)=>a.name.localeCompare(b.name));
    const pending=[{path:current,depth:0}],repositories:{name:string;path:string}[]=[];
    let visited=0,complete=true;
    while(pending.length && visited<=2000) {
      const next=pending.pop()!;
      try {
        for(const entry of await readdir(next.path,{withFileTypes:true})) {
          if(++visited>2000) {complete=false;break;}
          if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name.startsWith('.')||skipped.has(entry.name)) continue;
          const sub=join(next.path,entry.name);
          if(existsSync(join(sub,'.git'))) repositories.push({name:relative(current,sub).split(sep).join('/'),path:sub});
          else if(next.depth<1) pending.push({path:sub,depth:next.depth+1});
        }
      } catch {complete=false;}
    }
    let branches:string[]=[],currentBranch:string|null=null,warning:string|null=null;
    if(existsSync(join(current,'.git'))) {
      const git=async(args:string[])=>(await run('git',['--no-optional-locks','-C',current,...args],{timeout:5000,windowsHide:true})).stdout.trim();
      try {currentBranch=await git(['branch','--show-current']);branches=(await git(['for-each-ref','--format=%(refname:short)','refs/heads/'])).split(/\r?\n/).filter(Boolean);}
      catch {warning='当前目录的 Git 信息暂不可读取';}
    }
    const parent=dirname(current)===current?null:await directory(dirname(current)).catch(()=>null);
    return {path:current,parent,directories,branches,current_branch:currentBranch,repositories,repositories_complete:complete,warning};
  });
  app.get('/api/v1/project-workspace/codex-projects',async req=>{
    admin(req.principal);
    const items:{id:string;name:string;path:string}[]=[];
    try {
      const file=join(env.CODEX_HOME??join(homedir(),'.codex'),'.codex-global-state.json');
      if((await stat(file)).size>16*1024*1024) throw new Error();
      const state=z.object({'local-projects':z.record(z.string(),z.object({name:z.string().optional(),rootPaths:z.array(z.string()).default([])})).default({})}).parse(JSON.parse(await readFile(file,'utf8')));
      for(const [id,item] of Object.entries(state['local-projects'])) for(const root of item.rootPaths) {
        const path=await directory(root).catch(()=>null);
        if(path) items.push({id,name:item.name??id,path});
      }
      return {items};
    } catch {return {items,reason:'本机 Codex 项目列表暂不可读取，可浏览目录选择'};}
  });
  app.post('/api/v1/project-workspace/select-directory',async req=>{
    admin(req.principal);
    const {path}=z.object({path:z.string().default('')}).parse(req.body);
    if(process.platform!=='win32') fail(501,'可使用网页目录浏览');
    if(selecting) fail(409,'请先完成当前目录选择');
    selecting=true;
    try {
      const initial=await directory(path);
      const system=env.SystemRoot??'C:\\Windows';
      const exe=join(system,'System32','WindowsPowerShell','v1.0','powershell.exe');
      const result=await run(exe,['-NoProfile','-NonInteractive','-STA','-EncodedCommand',picker],{timeout:180000,windowsHide:true,maxBuffer:65536,
        env:{SystemRoot:system,PATH:join(system,'System32'),TEMP:env.TEMP,TMP:env.TMP,SUPERAGENT_PICKER_INITIAL:initial}});
      const selected=Buffer.from(result.stdout.trim(),'base64').toString('utf8');
      return {path:selected?await directory(selected):null};
    } catch(err) {
      if(err instanceof Error && 'statusCode' in err) throw err;
      fail(503,'系统目录选择窗口不可用或已超时，可使用网页目录浏览');
    } finally {selecting=false;}
  });
}
