import type { DatabaseSync } from 'node:sqlite';
import { actionHash } from '../storage/index.ts';
import type { Fields, Json } from '../storage/index.ts';

export class ChannelError extends Error {
  readonly uncertain: boolean;
  constructor(code:string,uncertain=false) { super(code); this.uncertain=uncertain; }
}
export interface Incoming {
  source:'redmine'|'dingtalk'; external_id:string; event_type:string; actor_id:string; thread_id:string;
  project_external_id:string; issue_id?:string; content:string; occurred_at:string; metadata:Fields; attachments:Json[];
}
export type Emit=(event:Incoming)=>Promise<void>;
export function utc(value:string|number) {
  if(typeof value==='string' && !/(?:Z|[+-]\d\d:\d\d)$/i.test(value)) throw new ChannelError('invalid_event_timezone');
  const iso=new Date(value).toISOString();
  const fraction=typeof value==='string' ? value.match(/\.(\d+)(?:Z|[+-])/i)?.[1] : undefined;
  return iso.slice(0,20)+(fraction?.padEnd(6,'0').slice(0,6) ?? iso.slice(20,23)+'000')+'Z';
}
export const digest=actionHash;
export class CursorStore {
  readonly db: DatabaseSync;
  constructor(db:DatabaseSync){ this.db=db; }
  get<T>(key:string):T|null {
    const row=this.db.prepare('SELECT value FROM connector_cursors WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : null;
  }
  set(key:string,value:unknown) {
    this.db.prepare(`INSERT INTO connector_cursors(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
      WHERE NOT (json_type(connector_cursors.value)='text' AND json_type(excluded.value)='text'
        AND json_extract(connector_cursors.value,'$')>json_extract(excluded.value,'$'))`)
      .run(key,JSON.stringify(value));
  }
}
export async function limitedJson(response:Response,max=4*1024*1024):Promise<any> {
  if(!response.body) return {};
  const reader=response.body.getReader(), chunks:Uint8Array[]=[];
  let bytes=0;
  try {
    for(;;) {
      const {done,value}=await reader.read();
      if(done) break;
      bytes+=value.length;
      if(bytes>max){await reader.cancel();throw new ChannelError('channel_response_too_large');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
