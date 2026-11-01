import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, secret } from './config.ts';

export class AppError extends Error {
  constructor(public message: string, public status = 400, public code = 'invalid_request') { super(message); }
}
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function sign(value: string) { return createHmac('sha256', secret(config().sessionFile)).update(value).digest('base64url'); }
export function equal(a: string, b: string) { const x = Buffer.from(hash(a)), y = Buffer.from(hash(b)); return timingSafeEqual(x, y); }
export function encrypt(value: string): string {
  const key = createHash('sha256').update(secret(config().encryptionFile)).digest();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64url')).join('.');
}
export function decrypt(value: string, label = 'AI 密钥'): string {
  const [iv, tag, data] = value.split('.').map(b => Buffer.from(b, 'base64url'));
  const key = createHash('sha256').update(secret(config().encryptionFile)).digest();
  try { const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'); }
  catch { throw new AppError(`${label}无法解密，请检查是否挂载了原实例的加密密钥。`, 503, 'encryption_key_mismatch'); }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== config().appURL.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError('请求来源不匹配，请检查 APP_URL。', 403, 'origin_mismatch');
}
export function encodeCursor(payload: unknown) { const value = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${value}.${sign(value)}`; }
export function decodeCursor<T>(value: string): T {
  if (value.length > 2048) throw new AppError('分页游标无效。');
  const [payload, signature] = value.split('.');
  if (!signature || !equal(sign(payload), signature)) throw new AppError('分页游标无效。');
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T; }
  catch { throw new AppError('分页游标无效。'); }
}
