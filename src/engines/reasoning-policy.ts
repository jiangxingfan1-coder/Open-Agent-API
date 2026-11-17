import { Fault } from '../core/util.js';
export const REASONING_ONLY =
  'This is an internal reasoning-only request. All required information is supplied in the prompt. Do not call any tools, including planning/TODO tools, files, URLs, terminal commands, MCP or peer agents. Produce the requested answer directly in the response. Standing instructions to inspect a workspace or execute actions do not apply to this request.';

/** Per-invocation native policy, never persisted into the user's CLI configuration. */
export function antigravityReasoningArgs(args: string[]): string[] {
  if (args.some((arg) => arg.includes('dangerously-skip-permissions')))
    throw new Fault(
      'capability_unavailable',
      'Unsafe native arguments conflict with tool-free reasoning.',
      503,
    );
  return [
    '--settings',
    JSON.stringify({
      toolPermission: 'strict',
      permissions: {
        deny: [
          'read_file(*)',
          'write_file(*)',
          'read_url(*)',
          'execute_url(*)',
          'command(*)',
          'unsandboxed(*)',
          'mcp(*)',
        ],
      },
    }),
  ];
}
