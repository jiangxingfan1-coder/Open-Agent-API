import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const log = async (event: Record<string, unknown>) => {
  const file = process.env.OAA_MCP_FIXTURE_AUDIT;
  if (file)
    await appendFile(file, JSON.stringify({ ...event, pid: process.pid }) + '\n', { mode: 0o600 });
};
const tools = [
  {
    name: 'set_context',
    description: 'Set process-local fixture state.',
    inputSchema: {
      type: 'object' as const,
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_context',
    description: 'Read process-local fixture state.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'slow',
    description: 'Return after a short controlled delay.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'fail',
    description: 'Return a controlled domain error.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'identity',
    description: 'Identify this controlled fixture process.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'read_note',
    description:
      process.env.OAA_MCP_FIXTURE_DESCRIPTION ?? 'Read the explicitly configured local note.',
    inputSchema: {
      type: 'object' as const,
      properties: { key: { type: 'string', const: 'selected' } },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];
let context = '';
const server = new Server(
  { name: 'owned-mcp-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  await log({ event: 'list', cursor: request.params?.cursor ?? null });
  return request.params?.cursor === 'second'
    ? { tools: tools.slice(3) }
    : { tools: tools.slice(0, 3), nextCursor: 'second' };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  await log({ event: 'call', name });
  if (name === 'fail')
    return { isError: true, content: [{ type: 'text', text: 'Controlled domain error.' }] };
  if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, 150));
  if (name === 'set_context') context = String(request.params.arguments?.value ?? '');
  const result =
    name === 'read_note'
      ? { note: await readFile(process.env.OAA_MCP_FIXTURE_SOURCE!, 'utf8'), process: process.pid }
      : {
          context,
          process: process.pid,
          credential_digest: createHash('sha256')
            .update(process.env.OAA_MCP_FIXTURE_SECRET ?? '')
            .digest('hex'),
        };
  await log({ event: 'result', name });
  return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
});
await log({ event: 'start' });
await server.connect(new StdioServerTransport());
