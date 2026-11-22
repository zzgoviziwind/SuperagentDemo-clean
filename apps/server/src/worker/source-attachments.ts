import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MiB } from '../../../../packages/channels/resources.ts';
import type { Attachment } from '../../../../packages/channels/resources.ts';
import type { AssessmentImage } from '../workbench/runtime.ts';

export async function workerSourceImages(db:DatabaseSync,base:string,taskId:number,signal:AbortSignal) {
  const rows=db.prepare(`SELECT j.event_id,j.results FROM event_attachment_jobs j JOIN events e ON e.id=j.event_id AND e.task_id=j.task_id
    WHERE j.task_id=? AND j.status='completed' AND e.source IN ('dingtalk','redmine')
    AND j.event_id>COALESCE((SELECT MAX(id) FROM events WHERE task_id=? AND event_type='project_rebound'),0)
    ORDER BY j.event_id DESC`).all(taskId,taskId);
  const images:AssessmentImage[]=[],seen=new Set<string>();
  let bytes=0,omitted=0;
  for(const {event_id,results} of rows) {
    const eventId=Number(event_id);
    for(const attachment of JSON.parse(String(results)) as Attachment[]) {
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(attachment.content_type) || seen.has(attachment.sha256)) continue;
      seen.add(attachment.sha256);
      if(images.length>=4 || bytes+attachment.size>20*MiB) {omitted++;continue;}
      signal.throwIfAborted();
      const scope=join(base,String(taskId),String(eventId));
      const path=attachment.local_path;
      const rel=typeof path==='string'&&isAbsolute(path)?relative(scope,path):'';
      if(!rel || rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel)
        || !Number.isInteger(attachment.size) || attachment.size<12 || attachment.size>10*MiB) throw new Error('来源图片路径或大小无效');
      const canonical=await realpath(path);
      const info=await lstat(path);
      if(canonical.toLowerCase()!==path.toLowerCase() || !info.isFile() || info.nlink!==1 || info.size!==attachment.size)
        throw new Error('来源图片已变化');
      const file=await open(canonical,'r');
      const body=Buffer.alloc(attachment.size);
      try {
        const {bytesRead}=await file.read(body,0,body.length,0);
        if(bytesRead!==body.length || (await file.stat()).size!==body.length
          || createHash('sha256').update(body).digest('hex')!==attachment.sha256) throw new Error('来源图片内容已变化');
      } finally {await file.close();}
      images.push({eventId,contentType:attachment.content_type,bytes:body});
      bytes+=body.length;
    }
  }
  return {images,omitted};
}
