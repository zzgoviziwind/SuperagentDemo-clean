import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { ChannelError } from './common.ts';

export const MiB=1024*1024;
export type Attachment={local_path:string;filename:string;size:number;content_type:string;sha256:string};
const mimes:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain','.log':'text/plain'};
export function invalid(code:string):never {throw new ChannelError(code);}
export function filename(value:unknown) {
  if(typeof value!=='string'||!value || value.length>180 || /[\x00-\x1f<>:"/\\|?*]|[. ]$/u.test(value)
    || /^(con|aux|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.|$)/i.test(value)) invalid('attachment_filename_invalid');
  return value;
}
export async function directory(path:string):Promise<string> {
  if(!isAbsolute(path) || normalize(path)!==path) invalid('attachment_root_invalid');
  const parent=dirname(path);
  if(parent===path) return realpath(path);
  await directory(parent);
  try{await mkdir(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e;}
  if((await lstat(path)).isSymbolicLink() || (await realpath(path)).toLowerCase()!==path.toLowerCase() || !(await lstat(path)).isDirectory())
    invalid('attachment_root_unsafe');
  return path;
}
export async function discard(base:string,path:string):Promise<void> {
  const rel=relative(base,path);
  if(!rel || rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) invalid('attachment_cleanup_scope');
  await directory(base);
  const st=await lstat(path).catch(()=>null);
  if(!st) return;
  if(st.isSymbolicLink()||!st.isDirectory()){await unlink(path);return;}
  if((await realpath(path)).toLowerCase()!==resolve(path).toLowerCase()) invalid('attachment_cleanup_scope');
  for(const n of await readdir(path)) await discard(path,join(path,n));
  await rmdir(path);
}
export async function accept(dir:string,name:unknown,body:Buffer,type:unknown,limit:number) {
  const file=filename(name),mime=mimes[extname(file).toLowerCase()];
  if(!mime || mime!==String(type).split(';')[0].trim().toLowerCase() || !body.length || body.length>limit) invalid('attachment_type_or_size');
  let valid=false;
  switch(mime) {
    case 'image/png': valid=body.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));break;
    case 'image/jpeg': valid=body.subarray(0,3).equals(Buffer.from('ffd8ff','hex'));break;
    case 'image/gif': valid=['GIF89a','GIF87a'].includes(body.toString('ascii',0,6));break;
    case 'image/webp': valid=body.toString('ascii',0,4)==='RIFF' && body.toString('ascii',8,12)==='WEBP';break;
    case 'application/pdf': valid=body.toString('ascii',0,5)==='%PDF-';break;
    case 'text/plain': {
      const text=new TextDecoder('utf-8',{fatal:true}).decode(body);
      valid=!text.includes('\0') && !/^\s*<(?:html|!doctype|svg|script)/i.test(text);break;
    }
  }
  if(!valid) invalid('attachment_content_mismatch');
  const path=join(await directory(dir),file), out=await open(path,'wx');
  try{await out.writeFile(body);await out.sync();}finally{await out.close();}
  return {local_path:path,filename:file,content_type:mime,size:body.length,sha256:createHash('sha256').update(body).digest('hex')};
}
export async function boundedBytes(response:Response,limit:number) {
  const expected=response.headers.get('content-length');
  const reader=response.body?.getReader();
  if(!reader) return invalid('attachment_empty');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{
    if(expected!==null && (!/^\d+$/.test(expected)||Number(expected)>limit)) invalid('attachment_size_limit');
    for(;;){const {done,value}=await reader.read();if(done) break;bytes+=value.length;
      if(bytes>limit) invalid('attachment_size_limit');chunks.push(value);}
    if(!bytes || expected!==null && Number(expected)!==bytes) invalid('attachment_incomplete');
    return Buffer.concat(chunks);
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function inventory(root:string) {
  const files=new Map<string,number>();let total=0,dirs=0;
  async function visit(path:string) {
    const st=await lstat(path);
    if(st.isSymbolicLink() || (await realpath(path)).toLowerCase()!==path.toLowerCase()) invalid('dws_media_unsafe_path');
    if(st.isDirectory()){
      if(++dirs>32) invalid('dws_media_size_limit');
      for(const n of await readdir(path)) await visit(join(path,filename(n)));
    } else {
      if(!st.isFile()||st.nlink!==1||st.size>10*MiB || files.size>=10 || (total+=st.size)>40*MiB) invalid('dws_media_size_limit');
      files.set(relative(root,path).split(sep).join('/'),st.size);
    }
  }
  await visit(root);return files;
}
export function fileMime(path:string){return mimes[extname(basename(path)).toLowerCase()];}
