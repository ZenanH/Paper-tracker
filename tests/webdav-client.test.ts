import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebDAVClient, validateWebDAVOptions } from '../lib/webdav-client.ts';
import { ExternalError } from '../lib/network.ts';

async function withServer(handler: RequestListener, run: (baseURL: string) => Promise<void>) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${address.port}/dav/`;
  const previous = process.env.WEBDAV_ALLOWED_ORIGINS;
  process.env.WEBDAV_ALLOWED_ORIGINS = new URL(baseURL).origin;
  try { await run(baseURL); }
  finally {
    if (previous === undefined) delete process.env.WEBDAV_ALLOWED_ORIGINS;
    else process.env.WEBDAV_ALLOWED_ORIGINS = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('WebDAV upload/download supports authenticated collections and creates missing folders', async () => {
  const files = new Map<string, string>(), folders = new Set<string>();
  let sawAuthorization = false;
  await withServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.headers.authorization === `Basic ${Buffer.from('alice:secret').toString('base64')}`) sawAuthorization = true;
      if (request.method === 'PROPFIND') { response.writeHead(207).end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>'); return; }
      if (request.method === 'MKCOL') { folders.add(request.url!); response.writeHead(201).end(); return; }
      if (request.method === 'PUT') { files.set(request.url!, Buffer.concat(chunks).toString('utf8')); response.writeHead(201).end(); return; }
      if (request.method === 'GET') {
        const file = files.get(request.url!);
        if (file === undefined) response.writeHead(404).end();
        else response.writeHead(200, { 'content-type': 'application/json' }).end(file);
        return;
      }
      response.writeHead(405).end();
    });
  }, async baseURL => {
    const client = new WebDAVClient({ baseURL, remotePath: 'paper-tracker/config.json', username: 'alice', password: 'secret' });
    try {
      await client.probe();
      await client.put('{"formatVersion":1}');
      assert.equal(await client.get(), '{"formatVersion":1}');
      assert.ok(folders.has('/dav/paper-tracker/'));
      assert.ok(sawAuthorization);
    } finally { await client.close(); }
  });
});

test('WebDAV authentication failures, redirects, and transient server errors remain distinguishable', async () => {
  let mode: 'auth' | 'redirect' | 'retry' = 'auth';
  await withServer((_request, response) => {
    if (mode === 'auth') { response.writeHead(401).end(); return; }
    if (mode === 'redirect') { response.writeHead(302, { location: 'https://elsewhere.example.test/dav/' }).end(); return; }
    response.writeHead(503).end();
  }, async baseURL => {
    const client = new WebDAVClient({ baseURL, remotePath: 'config.json', username: 'alice', password: 'secret' });
    try {
      await assert.rejects(client.probe(), (error: unknown) => error instanceof ExternalError && error.code === 'webdav_auth_failed');
      mode = 'redirect';
      await assert.rejects(client.probe(), (error: unknown) => error instanceof ExternalError && error.code === 'webdav_redirect_rejected');
      mode = 'retry';
      await assert.rejects(client.probe(), (error: unknown) => error instanceof ExternalError && error.code === 'webdav_server_unavailable' && error.retryable);
    } finally { await client.close(); }
  });
});

test('WebDAV rejects responses larger than 1 MiB', async () => {
  await withServer((request, response) => {
    if (request.method === 'PROPFIND') { response.writeHead(207).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end('x'.repeat(1024 * 1024 + 1));
  }, async baseURL => {
    const client = new WebDAVClient({ baseURL, remotePath: 'config.json', username: '', password: '' });
    try {
      await assert.rejects(client.get(), (error: unknown) => error instanceof ExternalError && error.code === 'webdav_response_too_large');
    } finally { await client.close(); }
  });
});

test('WebDAV URL validation requires HTTPS except for an explicitly authorized origin', async () => {
  assert.throws(() => validateWebDAVOptions({ baseURL: 'http://dav.example.test/dav', remotePath: 'config.json', username: '', password: '' }));
  await withServer((_request, response) => response.writeHead(207).end(), async baseURL => {
    const validated = validateWebDAVOptions({ baseURL, remotePath: 'config.json', username: '', password: '' });
    assert.equal(validated.remotePath, 'config.json');
  });
});
