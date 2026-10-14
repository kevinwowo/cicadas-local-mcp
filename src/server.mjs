import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { createCicadasClient, CicadasClientError } from './client.mjs';

const requestSchema = z.object({
  requestId: z.string().uuid(), toolSlug: z.string().min(1).max(80), modelKey: z.string().min(1).max(60).optional(),
  mode: z.literal('text_to_video'), prompt: z.string().min(3).max(4000),
  aspectRatio: z.string().max(10).optional(), duration: z.number().int().min(1).max(60).optional(),
  resolution: z.string().max(10).optional(), audio: z.boolean().optional(),
  maxCredits: z.number().int().min(1).max(10_000),
}).strict();

export function createCicadasMcpServer(client, { enableGeneration = false, downloadDirectory } = {}) {
  const server = new McpServer({ name: 'cicadas-local', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Use the catalog and a free quote first. Get the user\'s approval for the quoted cost before create_video. Generation spends real Cicadas credits. After an ambiguous creation response, use get_video_request with the original requestId to recover; never retry paid creation automatically or invent a new requestId. Keep the API key outside the conversation. V1 is text-to-video only.',
  });
  const safeCall = operation => async args => {
    try {
      const result = await operation(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const code = error instanceof CicadasClientError ? error.code : 'operation_failed';
      return { isError: true, content: [{ type: 'text', text: `Cicadas ${code}. No automatic retry was made. For an uncertain paid response, call get_video_request with the original requestId to recover; do not submit a new operation.` }] };
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  server.registerTool('list_video_models', { description: 'List currently available Cicadas text-to-video models and accepted options. Does not create a task or charge.', inputSchema: z.object({}).strict(), annotations: read }, safeCall(() => client.catalog()));
  server.registerTool('get_credit_balance', { description: 'Read account credits and this API key\'s conservative remaining lifetime cap.', inputSchema: z.object({}).strict(), annotations: read }, safeCall(() => client.balance()));
  server.registerTool('quote_video', { description: 'Validate a text-to-video request and obtain its current credit cost. Free; does not submit. Required before paid creation.', inputSchema: requestSchema, annotations: read }, safeCall(input => client.quote(input)));
  server.registerTool('get_video_job', { description: 'Read an owner-bound video job status. Successful results contain a private API file path, not a supplier URL or download token. No generation is submitted.', inputSchema: z.object({ jobId: z.string().uuid() }).strict(), annotations: read }, safeCall(({ jobId }) => client.status(jobId)));
  server.registerTool('get_video_request', { description: 'Recover an owner-bound operation using its original UUID requestId when the creation response or job ID was lost. Reads stored state even if new generation is paused; does not create, retry or charge.', inputSchema: z.object({ requestId: z.string().uuid() }).strict(), annotations: read }, safeCall(({ requestId }) => client.requestStatus(requestId)));
  if (downloadDirectory) {
    server.registerTool('download_video', {
      description: 'Copy an existing private MP4 to the operator-configured local download directory. No generation or charge. The filename is the job UUID; existing files and symlinks are never overwritten. Returns a local absolute path and SHA-256, without download tokens.',
      inputSchema: z.object({ jobId: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, safeCall(({ jobId }) => client.download(jobId, downloadDirectory)));
  }
  if (enableGeneration) {
    server.registerTool('create_video', {
      description: 'PAID: generate one text-to-video clip using existing Cicadas credits. Requires explicit user approval, confirmSpend:true, a credit cap, and the exact quoted request. One UUID requestId identifies this operation across manual recovery; no automatic retry.',
      inputSchema: requestSchema.extend({ confirmSpend: z.literal(true) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, safeCall(input => client.create(input)));
  }
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const client = createCicadasClient({ apiKey: process.env.CICADAS_API_KEY,
      baseUrl: process.env.CICADAS_API_BASE_URL,
      allowLoopback: process.env.CICADAS_ALLOW_HTTP_LOOPBACK === '1',
      allowCustomOrigin: process.env.CICADAS_ALLOW_CUSTOM_ORIGIN === '1',
    });
    serveStdio(() => createCicadasMcpServer(client, { enableGeneration: process.env.CICADAS_ENABLE_GENERATION === '1', downloadDirectory: process.env.CICADAS_DOWNLOAD_DIRECTORY || undefined }));
  } catch {
    process.stderr.write('Cicadas MCP configuration is invalid. Check the API key and HTTPS API base; no secret was printed.\n');
    process.exitCode = 1;
  }
}
