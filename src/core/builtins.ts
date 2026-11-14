import { builtinToolNames, type BuiltinToolName, type ToolBinding } from './contracts.js';

export { builtinToolNames, type BuiltinToolName };
export const builtinNames = new Set<string>(builtinToolNames);

export const builtin = (name: BuiltinToolName): ToolBinding => ({
  name,
  handler: { kind: 'builtin', name },
  capability: {
    id: `oaa/${name}`,
    version: '1',
    placement: 'portable',
    effect: name === 'write_file' || name === 'memory_write' ? 'idempotent-write' : 'read',
    description: {
      read_file: 'Read a UTF-8 input or workspace file by its relative path.',
      write_file:
        'Write a UTF-8 report artifact. The result includes its downloadable artifact reference.',
      list_files: 'List the input files and generated workspace files.',
      read_skill: 'Load the full instructions of a published skill by its path.',
      memory_read: 'Read durable cross-session memory entries by namespace and key or prefix.',
      memory_write: 'Persist a durable cross-session memory entry under a namespace and key.',
    }[name],
    inputSchema:
      name === 'list_files'
        ? { type: 'object', properties: {}, additionalProperties: false }
        : name === 'memory_read'
          ? {
              type: 'object',
              properties: {
                namespace: { type: 'string', maxLength: 120 },
                key: { type: 'string', maxLength: 240 },
                prefix: { type: 'string', maxLength: 240 },
              },
              additionalProperties: false,
            }
          : name === 'memory_write'
            ? {
                type: 'object',
                properties: {
                  namespace: { type: 'string', maxLength: 120 },
                  key: { type: 'string', maxLength: 240 },
                  value: {},
                },
                required: ['key', 'value'],
                additionalProperties: false,
              }
            : {
                type: 'object',
                properties: {
                  path: { type: 'string', maxLength: 240 },
                  ...(name === 'write_file'
                    ? { content: { type: 'string', maxLength: 1_000_000 } }
                    : {}),
                },
                required: name === 'write_file' ? ['path', 'content'] : ['path'],
                additionalProperties: false,
              },
    requiresApproval: false,
    timeoutMs: 30_000,
    cacheTtlMs: 0,
    resultExport: true,
  },
});
