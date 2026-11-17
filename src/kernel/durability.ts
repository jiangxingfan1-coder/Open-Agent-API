import {
  requiredExecution,
  type AgentDefinition,
  type Checkpoint,
  type Principal,
  type Run,
} from '../core/contracts.js';
import { Fault, faultOf } from '../core/util.js';
import { supportsReasoning } from '../fabric/model-pool.js';
import type { KernelRuntime } from './runtime.js';
import { projectPrincipal } from './project-memory.js';
import { projects } from '../store/projects.js';
import { workflowAllowsChildRecovery } from '../store/task-workflows.js';

export function durability(
  agent: AgentDefinition,
  metadata: Record<string, string>,
): Checkpoint['durability'] {
  const flag = metadata['oaa.durable'];
  if (flag !== undefined && flag !== 'true' && flag !== 'false')
    throw new Fault('invalid_request', 'oaa.durable must be true or false.');
  if (flag !== 'true') return undefined;
  const timeout = Number(metadata['oaa.timeout_ms'] ?? agent.limits.timeoutMs);
  const attempts = Number(metadata['oaa.max_resume_attempts'] ?? 10);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > agent.limits.timeoutMs ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 100
  )
    throw new Fault(
      'invalid_request',
      'Durable timeout must be within the publication limit; recovery attempts must be 1-100.',
    );
  return { deadlineAt: Date.now() + timeout, attempts: 0, maxAttempts: attempts };
}

export function recoverDurable(
  rt: KernelRuntime,
  resume: (principal: Principal, id: string) => Run,
) {
  for (const run of rt.store.allRuns(['interrupted'])) {
    const policy = run.checkpoint.durability;
    if (
      !policy ||
      !['gateway_restarted', 'shutting_down', 'cancelled'].includes(run.error?.code ?? '')
    )
      continue;
    try {
      if (!workflowAllowsChildRecovery(rt.store, run))
        throw new Fault(
          'reconciliation_required',
          'The workflow is cancelling or no longer active; its child was not replayed.',
          409,
        );
      if (Date.now() >= policy.deadlineAt || policy.attempts >= policy.maxAttempts)
        throw new Fault(
          'not_resumable',
          'The durable deadline or recovery-attempt budget was exhausted.',
          409,
        );
      const agent = rt.store.bundle(run.owner, run.agentId, run.digest).agent;
      const safe =
        requiredExecution(agent) === 'workspace' ||
        (run.metadata['oaa.tools_disabled'] === 'true' &&
          supportsReasoning(rt.hub, run.owner, agent));
      if (!safe || rt.store.steps(run.id).some((s) => s.status === 'uncertain'))
        throw new Fault(
          'reconciliation_required',
          'Unconfirmed host effects require reconciliation; they were not replayed.',
          409,
        );
      if (run.checkpoint.project)
        projects(rt.store).require(projectPrincipal(run), run.checkpoint.project.id);
      // Do not carry the key ID on this synthetic caller: Auth must resolve the current original key.
      const principal: Principal = {
        owner: run.owner,
        name: 'durable-recovery',
        subject: run.subject,
        agents: run.checkpoint.grantedAgents ?? [run.agentId],
        scopes: ['invoke', 'read', 'files'],
        execution: run.checkpoint.execution,
        hostAgents: run.checkpoint.hostAgents,
      };
      policy.attempts++;
      rt.store.save(run);
      const resumed = resume(principal, run.id);
      resumed.metadata['oaa.recovery'] = 'resumed';
      rt.store.save(resumed);
    } catch (error) {
      run.metadata['oaa.recovery'] = faultOf(error).code;
      rt.store.save(run);
    }
  }
}
