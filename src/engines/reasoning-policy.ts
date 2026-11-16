import { Fault } from '../core/util.js';

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
