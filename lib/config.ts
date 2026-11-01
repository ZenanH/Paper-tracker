import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function config() {
  const home = resolve(/* turbopackIgnore: true */ process.env.PAPER_TRACKER_HOME || '.local/paper-tracker-data');
  const data = resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || join(home, 'data'));
  return {
    home, data, database: join(data, 'paper-tracker.sqlite'),
    catalog: resolve(/* turbopackIgnore: true */ process.env.CATALOG_PATH || 'catalog/catalog.sqlite'),
    appURL: new URL(process.env.APP_URL || 'http://localhost:3000'),
    sessionFile: resolve(/* turbopackIgnore: true */ process.env.SESSION_SECRET_FILE || join(home, 'secrets/session_secret')),
    encryptionFile: resolve(/* turbopackIgnore: true */ process.env.ENCRYPTION_KEY_FILE || join(home, 'secrets/encryption_key')),
    allowedOrigins: (process.env.AI_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    webdavAllowedOrigins: (process.env.WEBDAV_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    mailto: process.env.CROSSREF_MAILTO || ''
  };
}
export function secret(path: string): string {
  if (!existsSync(path)) throw new Error('缺少外挂密钥文件，请先运行 setup 并检查挂载；已有实例不能重新生成密钥。');
  const value = readFileSync(path, 'utf8').trim();
  if (value.length < 16) throw new Error('实例密钥文件无效。');
  return value;
}
