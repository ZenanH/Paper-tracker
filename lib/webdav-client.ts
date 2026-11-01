import { lookup } from 'node:dns/promises';
import { Agent, request as httpRequest } from 'undici';
import { config } from './config.ts';
import { AppError } from './security.ts';
import { ExternalError, safeAIAddresses } from './network.ts';

const RESPONSE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT = 20_000;
const propfindBody = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

export type WebDAVOptions = { baseURL: string; remotePath: string; username: string; password: string };

export function validateWebDAVOptions(input: WebDAVOptions): WebDAVOptions {
  let base: URL;
  try { base = new URL(input.baseURL.trim()); } catch { throw new AppError('Enter a valid WebDAV server URL.'); }
  const allowed = config().webdavAllowedOrigins.includes(base.origin);
  if (base.username || base.password || base.search || base.hash || !['http:', 'https:'].includes(base.protocol) || (!allowed && base.protocol !== 'https:')) {
    throw new AppError('Use an HTTPS WebDAV URL. Private or local endpoints must be added to WEBDAV_ALLOWED_ORIGINS.');
  }
  const path = input.remotePath.trim().replace(/^\/+|\/+$/g, '');
  const segments = path.split('/');
  if (!path || path.length > 1024 || segments.length > 24 || segments.some(segment => {
    if (!segment || /[\\\u0000-\u001f\u007f?#]/.test(segment)) return true;
    try { const decoded = decodeURIComponent(segment); return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\'); }
    catch { return true; }
  })) throw new AppError('Enter a relative WebDAV file path without dot segments.');
  const username = input.username.trim();
  if (username.length > 256 || username.includes(':') || input.password.length > 4096) throw new AppError('WebDAV credentials are invalid or too long.');
  if (!!username !== !!input.password) throw new AppError('Enter both a WebDAV username and password, or leave both empty for anonymous access.');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/';
  return { baseURL: base.toString(), remotePath: path, username, password: input.password };
}

function statusError(status: number, method: string): ExternalError {
  if (status === 401 || status === 403) return new ExternalError('webdav_auth_failed', false);
  if (status >= 300 && status < 400) return new ExternalError('webdav_redirect_rejected', false);
  if (status === 404) return new ExternalError('webdav_not_found', false);
  if (status === 405) return new ExternalError('webdav_method_unsupported', false);
  return new ExternalError(status >= 500 || status === 429 ? 'webdav_server_unavailable' : `webdav_${method.toLowerCase()}_rejected`, status >= 500 || status === 429);
}

export function webdavErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    webdav_auth_failed: 'WebDAV rejected the username or password.',
    webdav_connection_failed: 'Could not connect to the WebDAV server. Check the URL and network access.',
    webdav_redirect_rejected: 'The WebDAV server redirected the request. Redirects are blocked to protect credentials.',
    webdav_not_found: 'The WebDAV path was not found. Check the server URL and remote file path.',
    webdav_backup_missing: 'No Paper-tracker configuration backup exists at this WebDAV path.',
    webdav_method_unsupported: 'The server does not support a required WebDAV method.',
    webdav_response_too_large: 'The WebDAV response exceeded the allowed size.',
    webdav_snapshot_invalid: 'The remote file is not a valid Paper-tracker configuration backup.',
    webdav_snapshot_too_large: 'The configuration backup exceeds the 1 MiB WebDAV limit.',
    webdav_encryption_mismatch: 'The backup or saved password uses a different ENCRYPTION_KEY_FILE.',
    webdav_sync_busy: 'Another WebDAV synchronization is running. Try again when it finishes.',
    webdav_sync_superseded: 'This WebDAV operation was superseded by a newer configuration change. Retry the backup.',
    webdav_sync_cancelled: 'WebDAV synchronization was cancelled before it completed. Try again when ready.',
    webdav_server_unavailable: 'The WebDAV server is temporarily unavailable. Try again later.',
    webdav_probe_failed: 'The URL did not respond as a WebDAV collection.',
    webdav_put_rejected: 'The WebDAV server rejected the configuration upload.',
    webdav_get_rejected: 'The WebDAV server rejected the configuration download.',
    webdav_mkcol_rejected: 'The WebDAV server could not create a remote folder.'
  };
  return messages[code] || 'WebDAV synchronization failed. Check the server settings and try again.';
}

export class WebDAVClient {
  private readonly base: URL;
  private readonly target: URL;
  private readonly agent: Agent;
  private readonly authorization?: string;
  private readonly signal?: AbortSignal;

  constructor(options: WebDAVOptions, signal?: AbortSignal) {
    const validated = validateWebDAVOptions(options);
    this.signal = signal;
    this.base = new URL(validated.baseURL);
    this.target = new URL(this.base);
    this.target.pathname = this.base.pathname + validated.remotePath.split('/').map(encodeURIComponent).join('/');
    if (validated.username) this.authorization = `Basic ${Buffer.from(`${validated.username}:${validated.password}`).toString('base64')}`;
    const allowed = config().webdavAllowedOrigins.includes(this.base.origin);
    this.agent = new Agent({ connect: { lookup(hostname, lookupOptions, callback) {
      lookup(hostname, { all: true }).then(addresses => {
        const safe = safeAIAddresses(hostname, addresses, allowed);
        if (!safe) { callback(new Error('WebDAV destination is not allowed.'), '', 4); return; }
        if (lookupOptions.all) callback(null, safe);
        else {
          const address = safe.find(item => !lookupOptions.family || item.family === lookupOptions.family) || safe[0];
          callback(null, address.address, address.family);
        }
      }, error => callback(error, '', 4));
    } } });
  }

  private urlFor(segments: string[]) {
    const url = new URL(this.base);
    url.pathname = this.base.pathname + segments.map(encodeURIComponent).join('/') + '/';
    return url;
  }

  private async request(url: URL, method: string, body?: string, headers: Record<string, string> = {}) {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
      const response = await httpRequest(url, {
        dispatcher: this.agent, method, body,
        headers: { ...(this.authorization ? { authorization: this.authorization } : {}), ...headers },
        headersTimeout: REQUEST_TIMEOUT, bodyTimeout: REQUEST_TIMEOUT,
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
      });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        await this.discard(response);
        throw statusError(response.statusCode, method);
      }
      return response;
    } catch (error) {
      if (error instanceof ExternalError || error instanceof AppError) throw error;
      if (this.signal?.aborted) throw new ExternalError('webdav_sync_cancelled', true);
      throw new ExternalError('webdav_connection_failed', true);
    }
  }

  private async discard(response: Awaited<ReturnType<typeof httpRequest>>) {
    try { await response.body.dump({ limit: RESPONSE_LIMIT }); }
    catch (error) {
      if (this.signal?.aborted) throw new ExternalError('webdav_sync_cancelled', true);
      if ((error as { code?: string })?.code === 'UND_ERR_ABORTED') return;
      throw new ExternalError('webdav_connection_failed', true);
    }
  }

  private async text(response: Awaited<ReturnType<typeof httpRequest>>) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > RESPONSE_LIMIT) {
          const error = new ExternalError('webdav_response_too_large', false);
          response.body.destroy(error);
          throw error;
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (error instanceof ExternalError) throw error;
      throw new ExternalError('webdav_connection_failed', true);
    }
  }

  async probe() {
    const response = await this.request(this.base, 'PROPFIND', propfindBody, { depth: '0', 'content-type': 'application/xml; charset=utf-8' });
    if (![200, 207].includes(response.statusCode)) { await this.discard(response); throw statusError(response.statusCode, 'PROPFIND'); }
    await this.text(response);
  }

  async get() {
    const response = await this.request(this.target, 'GET', undefined, { accept: 'application/json' });
    if (response.statusCode === 404) { await this.discard(response); return null; }
    if (response.statusCode !== 200) { await this.discard(response); throw statusError(response.statusCode, 'GET'); }
    return this.text(response);
  }

  async put(contents: string) {
    const segments = this.target.pathname.slice(this.base.pathname.length).split('/').filter(Boolean).slice(0, -1).map(decodeURIComponent);
    for (let index = 1; index <= segments.length; index++) {
      const directory = this.urlFor(segments.slice(0, index));
      const response = await this.request(directory, 'MKCOL');
      if ([200, 201, 204].includes(response.statusCode)) { await this.discard(response); continue; }
      if (response.statusCode === 405) {
        await this.discard(response);
        const existing = await this.request(directory, 'PROPFIND', propfindBody, { depth: '0', 'content-type': 'application/xml; charset=utf-8' });
        if ([200, 207].includes(existing.statusCode)) { await this.text(existing); continue; }
        await this.discard(existing); throw statusError(existing.statusCode, 'PROPFIND');
      }
      await this.discard(response); throw statusError(response.statusCode, 'MKCOL');
    }
    const response = await this.request(this.target, 'PUT', contents, { 'content-type': 'application/json; charset=utf-8' });
    if (response.statusCode < 200 || response.statusCode >= 300) { await this.discard(response); throw statusError(response.statusCode, 'PUT'); }
    await this.discard(response);
  }

  async close() { await this.agent.close(); }
}
