import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_BASE = 'https://cicadas.ai/api/v1/';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CicadasClientError extends Error {
  constructor(code, status = 0) { super(`Cicadas request failed (${code}). No automatic retry was made.`); this.code = code; this.status = status; }
}

export function validateApiBase(raw = DEFAULT_BASE, options = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('CICADAS_API_BASE_URL must be a valid API URL.'); }
  if (url.username || url.password || url.search || url.hash || !['/api/v1', '/api/v1/'].includes(url.pathname) || url.hostname.endsWith('.')) {
    throw new Error('Use an API base ending in /api/v1, without credentials, query or fragment.');
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (loopback && options.allowLoopback !== true) throw new Error('Loopback API bases require explicit local development configuration.');
  if (url.protocol !== 'https:' && !(options.allowLoopback === true && loopback && url.protocol === 'http:')) {
    throw new Error('HTTPS is required; HTTP loopback is allowed only by explicit local development configuration.');
  }
  if (url.origin !== 'https://cicadas.ai' && !loopback && options.allowCustomOrigin !== true) {
    throw new Error('A custom HTTPS API origin requires explicit CICADAS_ALLOW_CUSTOM_ORIGIN=1.');
  }
  url.pathname = '/api/v1/';
  return url;
}

export function createCicadasClient({ apiKey, baseUrl, allowLoopback = false, allowCustomOrigin = false, fetcher = fetch }) {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(apiKey)) throw new Error('Set a customer API key in CICADAS_API_KEY, not in tool arguments.');
  const base = validateApiBase(baseUrl, { allowLoopback, allowCustomOrigin });
  async function fetchApi(path, method = 'GET', body, timeoutMs = 30_000) {
    // All tool operations use these fixed paths. Model arguments cannot select an origin or redirect target.
    if (!/^(catalog|balance|quote|videos|videos\/[A-Za-z0-9-]{36}(\/file)?|videos\?requestId=[0-9a-f-]{36})$/i.test(path)) throw new CicadasClientError('invalid_path');
    let response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new CicadasClientError('transport_uncertain'); }
    if (response.status >= 300 && response.status < 400 || response.headers.has('location')) {
      await response.body?.cancel();
      throw new CicadasClientError('redirect_refused', response.status);
    }
    return response;
  }
  async function call(path, method = 'GET', body) {
    const response = await fetchApi(path, method, body);
    const reader = response.body?.getReader();
    if (!reader) throw new CicadasClientError('invalid_response', response.status);
    let bytes = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new CicadasClientError('response_too_large', response.status); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    let envelope;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged)); }
    catch { throw new CicadasClientError('invalid_response', response.status); }
    if (!response.ok || envelope?.code !== 0 || !envelope.data || typeof envelope.data !== 'object') {
      const code = /^[a-z_]{1,60}$/.test(envelope?.error ?? '') && !envelope.error.includes(apiKey) ? envelope.error : 'api_error';
      throw new CicadasClientError(code, response.status);
    }
    // A misconfigured upstream must not reflect the credential back into the model transcript.
    return JSON.parse(JSON.stringify(envelope.data).split(apiKey).join('[redacted]'));
  }

  async function download(id, directory) {
    if (!UUID.test(id) || typeof directory !== 'string' || !isAbsolute(directory)) throw new CicadasClientError('invalid_download_destination');
    let target, handle, identity;
    let completed = false;
    try {
      const selected = await lstat(directory);
      if (!selected.isDirectory() || selected.isSymbolicLink()) throw new CicadasClientError('invalid_download_destination');
      const root = await realpath(directory);
      target = join(root, `${id.toLowerCase()}.mp4`);
      // O_EXCL refuses existing files; O_NOFOLLOW additionally refuses final symlinks. Never accept a path from a tool argument.
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      identity = await handle.stat();
      const response = await fetchApi(`videos/${id}/file`, 'GET', undefined, 120_000);
      if (response.status !== 200 || (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'video/mp4' || !response.body) {
        await response.body?.cancel(); throw new CicadasClientError('video_unavailable', response.status);
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) { await response.body.cancel(); throw new CicadasClientError('video_too_large'); }
      const hash = createHash('sha256');
      const reader = response.body.getReader();
      let total = 0;
      const prefix = [];
      let prefixBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_VIDEO_BYTES) { await reader.cancel(); throw new CicadasClientError('video_too_large'); }
          if (prefixBytes < 16) { const part = value.subarray(0, 16 - prefixBytes); prefix.push(part); prefixBytes += part.byteLength; }
          hash.update(value);
          let written = 0;
          while (written < value.byteLength) {
            const progress = await handle.write(value, written, value.byteLength - written);
            if (progress.bytesWritten === 0) throw new CicadasClientError('download_write_failed');
            written += progress.bytesWritten;
          }
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
      const header = Buffer.concat(prefix);
      if (total < 16 || header.subarray(4, 8).toString() !== 'ftyp') throw new CicadasClientError('invalid_video');
      await handle.sync();
      completed = true;
      return { localPath: target, bytes: total, sha256: hash.digest('hex') };
    } catch (error) {
      if (error instanceof CicadasClientError) throw error;
      throw new CicadasClientError(error?.code === 'EEXIST' || error?.code === 'ELOOP' ? 'file_exists' : 'download_failed');
    } finally {
      await handle?.close();
      if (!completed && identity && target) {
        const current = await lstat(target).catch(() => null);
        // Remove only the partial file we created, never a later replacement or pre-existing user file.
        if (current && current.ino === identity.ino && current.dev === identity.dev && !current.isSymbolicLink()) await unlink(target).catch(() => undefined);
      }
    }
  }
  return {
    catalog: () => call('catalog'), balance: () => call('balance'),
    quote: input => call('quote', 'POST', input),
    create: input => call('videos', 'POST', input),
    status: id => call(`videos/${id}`),
    requestStatus: requestId => {
      if (!UUID.test(requestId)) throw new CicadasClientError('invalid_request_id');
      return call(`videos?requestId=${requestId}`);
    },
    download,
  };
}
