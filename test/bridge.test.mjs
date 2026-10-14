import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createCicadasClient, validateApiBase } from '../src/client.mjs';

const fixtureKey = 'fixture_customer_key_not_a_real_credential';
const requestId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const input = { requestId, toolSlug: 'fixture-model', mode: 'text_to_video', prompt: 'A fictional comet crossing the night sky.', maxCredits: 70 };
// Minimal binary contract fixture, not a supplier-generated or visually accepted video.
const fixtureMedia = Buffer.from('000000186674797069736f6d0000000069736f6d69736f32', 'hex');

test('API base refuses plaintext, URL credentials, custom origins and injected paths by default', () => {
  for (const value of ['http://cicadas.ai/api/v1', 'https://user:pass@cicadas.ai/api/v1', 'https://evil.example/api/v1', 'https://cicadas.ai/api/v1?key=anything', 'https://cicadas.ai/api/v1/../payment']) {
    assert.throws(() => validateApiBase(value));
  }
  assert.throws(() => validateApiBase('http://127.0.0.1:7777/api/v1'));
  assert.throws(() => validateApiBase('https://127.0.0.1:7777/api/v1'));
  assert.equal(validateApiBase('http://127.0.0.1:7777/api/v1', { allowLoopback: true }).origin, 'http://127.0.0.1:7777');
  assert.throws(() => validateApiBase('http://evil.example/api/v1', { allowLoopback: true, allowCustomOrigin: true }));
});

test('redirect and lost paid acknowledgement are never retried or followed', async () => {
  let submissions = 0;
  let options;
  const redirectClient = createCicadasClient({ apiKey: fixtureKey, fetcher: async (_url, init) => {
    submissions++; options = init;
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example/collect' } });
  } });
  await assert.rejects(redirectClient.create({ ...input, confirmSpend: true }), error => error.code === 'redirect_refused');
  assert.equal(submissions, 1);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  const uncertainClient = createCicadasClient({ apiKey: fixtureKey, fetcher: async () => { submissions++; throw new Error('fixture network loss'); } });
  await assert.rejects(uncertainClient.create({ ...input, confirmSpend: true }), error => error.code === 'transport_uncertain');
  assert.equal(submissions, 2);
});

test('upstream credential reflection and oversized responses do not reach tool outputs', async () => {
  const client = createCicadasClient({ apiKey: fixtureKey, fetcher: async () => Response.json({ code: 0, data: { reflected: fixtureKey } }) });
  assert.equal(JSON.stringify(await client.balance()).includes(fixtureKey), false);
  const oversized = createCicadasClient({ apiKey: fixtureKey, fetcher: async () => new Response('a'.repeat(300_000)) });
  await assert.rejects(oversized.balance(), error => error.code === 'response_too_large');
});

test('downloads reject non-video, oversize and malformed MP4 and remove only their partial files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cicadas-mcp-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const response of [
    new Response('<html>not a video</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response(fixtureMedia, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(101 * 1024 * 1024) } }),
    new Response('this is not a playable media container', { headers: { 'Content-Type': 'video/mp4' } }),
  ]) {
    const client = createCicadasClient({ apiKey: fixtureKey, fetcher: async () => response });
    await assert.rejects(client.download(jobId, directory));
    await assert.rejects(access(join(directory, `${jobId}.mp4`)));
  }
});

test('real stdio recovers a lost paid acknowledgement by GET requestId with no second POST', async t => {
  let posts = 0;
  const http = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the synthetic request */ }
    if (req.method === 'POST' && req.url === '/api/v1/videos') { posts++; req.socket.destroy(); return; }
    assert.equal(req.method, 'GET');
    assert.equal(req.url, `/api/v1/videos?requestId=${requestId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { job: { id: jobId, status: 'pending', costCredits: 63 } } }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise(resolve => http.close(resolve)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { PATH: process.env.PATH, CICADAS_API_KEY: fixtureKey, CICADAS_API_BASE_URL: `http://127.0.0.1:${http.address().port}/api/v1`, CICADAS_ALLOW_HTTP_LOOPBACK: '1', CICADAS_ENABLE_GENERATION: '1' }, stderr: 'pipe' });
  const client = new Client({ name: 'fixture-recovery-client', version: '0.1.0' });
  await client.connect(transport); t.after(() => client.close());
  const uncertain = await client.callTool({ name: 'create_video', arguments: { ...input, confirmSpend: true } });
  assert.equal(uncertain.isError, true);
  assert.equal(posts, 1);
  const recovered = await client.callTool({ name: 'get_video_request', arguments: { requestId } });
  assert.equal(recovered.structuredContent.job.id, jobId);
  assert.equal(posts, 1);
});

test('official SDK stdio initialize/list/call reaches only mock HTTP and explicit create once', async t => {
  const requests = [];
  const received = [];
  let providerPaused = false;
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path: req.url, method: req.method });
    if (body) received.push(body);
    assert.equal(req.headers.authorization, `Bearer ${fixtureKey}`);
    assert.equal(req.headers.cookie, undefined);
    if (providerPaused && req.url === '/api/v1/videos' && req.method === 'POST') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: -1, error: 'live_generation_required', message: 'Synthetic provider paused' })); return;
    }
    if (req.url === `/api/v1/videos/${jobId}/file`) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fixtureMedia.length });
      res.end(fixtureMedia); return;
    }
    let data = {};
    if (req.url === '/api/v1/catalog') data = { version: 'fixture', scope: 'text_to_video', items: providerPaused ? [] : [{ toolSlug: 'fixture-model' }] };
    if (req.url === '/api/v1/balance') data = { balanceCredits: 100, key: { remainingCredits: 1000 } };
    if (req.url === '/api/v1/quote') data = { requestId: body.requestId, credits: 63, charged: false };
    if (req.url === '/api/v1/videos') data = { job: { id: jobId, status: 'pending', costCredits: 63 } };
    if (req.url === `/api/v1/videos/${jobId}`) data = { job: { id: jobId, status: 'success', filePath: `/api/v1/videos/${jobId}/file` } };
    if (req.url === `/api/v1/videos?requestId=${requestId}` && req.method === 'GET') data = { job: { id: jobId, status: 'success', filePath: `/api/v1/videos/${jobId}/file` } };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ code: 0, data }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise(resolve => http.close(resolve)));
  const port = http.address().port;
  const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const downloads = await mkdtemp(join(tmpdir(), 'cicadas-mcp-fixture-'));
  t.after(() => rm(downloads, { recursive: true, force: true }));
  async function connect(enabled) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry],
      env: { PATH: process.env.PATH, CICADAS_API_KEY: fixtureKey, CICADAS_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`, CICADAS_ALLOW_HTTP_LOOPBACK: '1', CICADAS_ENABLE_GENERATION: enabled ? '1' : '0', ...(enabled ? { CICADAS_DOWNLOAD_DIRECTORY: downloads } : {}) }, stderr: 'pipe' });
    const client = new Client({ name: 'fixture-mcp-client', version: '0.1.0' });
    await client.connect(transport); t.after(() => client.close());
    return client;
  }
  const readOnly = await connect(false);
  const readTools = await readOnly.listTools();
  assert.deepEqual(readTools.tools.map(tool => tool.name).sort(), ['get_credit_balance', 'get_video_job', 'get_video_request', 'list_video_models', 'quote_video']);
  await readOnly.callTool({ name: 'list_video_models', arguments: {} });
  await readOnly.callTool({ name: 'quote_video', arguments: input });
  assert.equal(requests.filter(req => req.path === '/api/v1/videos').length, 0);
  const paid = await connect(true);
  const tools = await paid.listTools();
  const createTool = tools.tools.find(tool => tool.name === 'create_video');
  assert.equal(createTool.annotations.readOnlyHint, false);
  assert.equal(createTool.annotations.destructiveHint, true);
  const invalid = await paid.callTool({ name: 'create_video', arguments: input });
  assert.equal(invalid.isError, true);
  const injection = await paid.callTool({ name: 'create_video', arguments: { ...input, confirmSpend: true, userId: 'other-account' } });
  assert.equal(injection.isError, true);
  const created = await paid.callTool({ name: 'create_video', arguments: { ...input, confirmSpend: true } });
  assert.equal(created.structuredContent.job.id, jobId);
  assert.equal(requests.filter(req => req.path === '/api/v1/videos').length, 1);
  assert.equal(received.find(body => body.confirmSpend)?.requestId, requestId);
  providerPaused = true;
  const recovered = await paid.callTool({ name: 'get_video_request', arguments: { requestId } });
  assert.equal(recovered.structuredContent.job.id, jobId);
  const emptyCatalog = await paid.callTool({ name: 'list_video_models', arguments: {} });
  assert.deepEqual(emptyCatalog.structuredContent.items, []);
  const status = await paid.callTool({ name: 'get_video_job', arguments: { jobId } });
  assert.equal(status.structuredContent.job.filePath, `/api/v1/videos/${jobId}/file`);
  await paid.callTool({ name: 'get_credit_balance', arguments: {} });
  const downloaded = await paid.callTool({ name: 'download_video', arguments: { jobId } });
  assert.equal(downloaded.structuredContent.localPath, join(await realpath(downloads), `${jobId}.mp4`));
  assert.equal(downloaded.structuredContent.sha256, createHash('sha256').update(fixtureMedia).digest('hex'));
  assert.deepEqual(await readFile(downloaded.structuredContent.localPath), fixtureMedia);
  const before = requests.length;
  const duplicate = await paid.callTool({ name: 'download_video', arguments: { jobId } });
  assert.equal(duplicate.isError, true);
  assert.equal(requests.length, before);
  const secondId = '44444444-4444-4444-8444-444444444444';
  await symlink(downloaded.structuredContent.localPath, join(downloads, `${secondId}.mp4`));
  const symlinked = await paid.callTool({ name: 'download_video', arguments: { jobId: secondId } });
  assert.equal(symlinked.isError, true);
  assert.equal(requests.length, before);
  const pathInjection = await paid.callTool({ name: 'download_video', arguments: { jobId, directory: '/tmp/unapproved' } });
  assert.equal(pathInjection.isError, true);
  assert.equal(JSON.stringify(status).includes(fixtureKey), false);
  assert.equal(requests.filter(req => req.path === '/api/v1/videos').length, 1);
});
