import { mkdirSync, existsSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const home='/instance';
const envPath=join(home,'compose.env');
if (!existsSync(envPath) && (!/^\d+$/.test(process.env.PUID||'') || Number(process.env.PUID) === 0 || !/^\d+$/.test(process.env.PGID||''))) throw new Error('PUID 必须为非 root 用户 ID，PGID 必须为有效组 ID。');
if (!existsSync(envPath) && process.getuid() !== 0 && Number(process.env.PUID) !== process.getuid()) throw new Error('请以所配置 PUID 的用户运行 setup，或由 root 准备目录所有权。');
mkdirSync(join(home,'data'),{recursive:true,mode:0o700});
mkdirSync(join(home,'secrets'),{recursive:true,mode:0o700});
const existing=existsSync(join(home,'data','paper-tracker.sqlite'));
for(const name of ['session_secret','encryption_key']) {
 const path=join(home,'secrets',name);
 if(!existsSync(path)) {
  if(existing)throw new Error('Existing instance is missing '+name+'; restore the original secret.');
  writeFileSync(path,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
 }
 chmodSync(path,0o600);
}
if(!existsSync(envPath)) {
 const values={PAPER_TRACKER_DATA:process.env.INSTANCE_HOST_PATH,PUID:process.env.PUID,PGID:process.env.PGID,APP_URL:process.env.APP_URL||`http://localhost:${process.env.WEB_PORT||'3000'}`,WEB_PORT:process.env.WEB_PORT||'3000',BIND_ADDRESS:process.env.BIND_ADDRESS||'127.0.0.1',COMPOSE_PROJECT_NAME:process.env.COMPOSE_PROJECT_NAME||'paper-tracker',AI_ALLOWED_ORIGINS:process.env.AI_ALLOWED_ORIGINS||'',WEBDAV_ALLOWED_ORIGINS:process.env.WEBDAV_ALLOWED_ORIGINS||'',CROSSREF_MAILTO:process.env.CROSSREF_MAILTO||''};
 writeFileSync(envPath,Object.entries(values).map(([key,value])=>key+'='+JSON.stringify(value).replaceAll('$', '$$')).join('\n')+'\n',{flag:'wx',mode:0o600});
 if (process.getuid() === 0 && !existing) {
  for (const path of [home,join(home,'data'),join(home,'secrets'),envPath,join(home,'secrets/session_secret'),join(home,'secrets/encryption_key')]) chownSync(path,Number(process.env.PUID),Number(process.env.PGID));
 }
}
