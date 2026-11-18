import type { Principal, Run } from '../core/contracts.js';
import { isOwnerWide, principalSubject } from '../core/contracts.js';
import { Fault, faultOf } from '../core/util.js';
import type { Store } from '../store/store.js';
import type { Kernel } from './kernel.js';
import {
  TaskWorkflows,
  type WorkflowExecution as Execution,
  type WorkflowRecord as StoredWorkflow,
} from '../store/task-workflows.js';
import { validateTaskWorkflow, workflowAgents, type TaskWorkflow } from '../lang/task-workflow.js';
import { cronMatchesMinute, cronMinuteSlot } from '../lang/cron.js';
import { executeGraph, projectGraphOutput } from '../lang/graph.js';
import { invocationSchema } from './invocation.js';
import { projects } from '../store/projects.js';

type WorkflowExecution = Execution<TaskWorkflow>;
type WorkflowRecord = StoredWorkflow<TaskWorkflow>;
export class WorkflowRunner {
  readonly records: TaskWorkflows<TaskWorkflow>;
  private tasks = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private closed = false;
  private timer?: NodeJS.Timeout;
  private observe = (event: { owner: string; runId: string; status: string; agentId: string }) => {
    if (event.status !== 'completed' || this.closed) return;
    const run = this.store.run(event.runId, event.owner);
    if (run.metadata['oaa.workflow_execution'] || run.metadata['oaa.evaluation']) return;
    for (const record of this.records.list(event.owner)) {
      const trigger = record.definition.trigger;
      if (
        record.archivedAt ||
        !record.definition.enabled ||
        trigger.kind !== 'event' ||
        trigger.agent !== event.agentId ||
        (trigger.subject ?? principalSubject(record.authority)) !== run.subject
      )
        continue;
      try {
        const key = `event:${record.revision}:${event.runId}`;
        const input = {
          run_id: run.id,
          agent: run.agentId,
          output: run.output
            .map((m) => m.text)
            .join('\n')
            .slice(0, 12000),
        };
        this.trigger(record, input, key);
      } catch (error) {
        try {
          this.records.noteTrigger(
            event.owner,
            record.definition.id,
            record.revision,
            faultOf(error).code,
          );
        } catch {
          /* Observation cannot change the source task result. */
        }
      }
    }
  };
  constructor(
    private readonly store: Store,
    private readonly kernel: Kernel,
    private readonly refresh: (p: Principal) => Principal,
  ) {
    this.records = new TaskWorkflows<TaskWorkflow>(store);
    store.events.on('summary', this.observe);
  }
  start() {
    this.timer ??= setInterval(() => this.tick(), 15000).unref();
    setImmediate(() => this.tick());
  }
  authorize(p: Principal, record: WorkflowRecord) {
    for (const agent of workflowAgents(record.definition))
      this.kernel.authorize(p, agent, 'invoke');
    if (record.definition.project) projects(this.store).require(p, record.definition.project);
  }
  view(p: Principal, record: WorkflowRecord) {
    if (
      !isOwnerWide(p) &&
      principalSubject(p) !== principalSubject(record.authority) &&
      !record.definition.project
    )
      throw new Fault('scope_denied', 'Workflow belongs to another caller.', 403);
    this.authorize(p, record);
    return {
      definition: record.definition,
      revision: record.revision,
      archived_at: record.archivedAt,
      trigger_status: record.triggerStatus,
    };
  }
  tick(now = Date.now()) {
    if (this.closed) return;
    for (const pending of this.records.pendingEvents()) {
      const owner = String(pending.owner),
        workflow = String(pending.workflow),
        event = String(pending.event);
      const record = this.records.get(owner, workflow);
      if (record.archivedAt || !record.definition.enabled || record.revision !== pending.revision) {
        this.records.dropPending(owner, workflow, event);
        continue;
      }
      try {
        this.trigger(record, JSON.parse(String(pending.input)), event);
      } catch (error) {
        const code = faultOf(error).code;
        // A changed grant is not a transient capacity failure.
        if (error instanceof Fault && code !== 'concurrency_limit')
          this.records.dropPending(owner, workflow, event);
        this.records.noteTrigger(owner, workflow, record.revision, code);
      }
    }
    for (const record of this.records.list()) {
      const trigger = record.definition.trigger;
      if (record.archivedAt || !record.definition.enabled) continue;
      if (trigger.kind !== 'interval' && trigger.kind !== 'cron') continue;
      let receiptKey: string;
      if (trigger.kind === 'interval') {
        const slot = Math.floor(now / (trigger.minutes * 60000));
        receiptKey = `time:${record.revision}:${slot}`;
      } else {
        const slot = cronMinuteSlot(now);
        if (!cronMatchesMinute(trigger.expression, trigger.timezone ?? 'UTC', slot * 60000))
          continue;
        receiptKey = `cron:${record.revision}:${slot}`;
      }
      try {
        if (
          this.records
            .executions(record.authority.owner, true)
            .some((e) => e.definition.id === record.definition.id)
        )
          continue;
        this.trigger(record, trigger.input, receiptKey);
      } catch (error) {
        try {
          this.records.noteTrigger(
            record.authority.owner,
            record.definition.id,
            record.revision,
            faultOf(error).code,
          );
        } catch {
          /* A failed status update cannot widen the stored grant. */
        }
      }
    }
    for (const execution of this.records.executions(undefined, true)) {
      if (this.tasks.size >= 4) break;
      if (!this.tasks.has(execution.id)) this.run(execution);
    }
  }
  private admission(
    principal: Principal,
    record: WorkflowRecord,
    input: unknown,
    fileIds: string[],
  ) {
    if (record.archivedAt)
      throw new Fault('invalid_request', 'Restore the archived workflow before running it.');
    const authority = this.refresh(principal);
    this.authorize(authority, record);
    if (Buffer.byteLength(JSON.stringify(input) ?? '') > 100000)
      throw new Fault('invalid_request', 'Workflow input exceeds its limit.');
    return {
      owner: authority.owner,
      subject: principalSubject(authority),
      definition: record.definition,
      revision: record.revision,
      authority,
      input,
      fileIds,
    };
  }
  private trigger(record: WorkflowRecord, input: unknown, key: string) {
    const value = this.admission(record.authority, record, input, []);
    const trigger = record.definition.trigger;
    if (trigger.kind === 'event') {
      this.kernel.authorize(value.authority, trigger.agent, 'read');
      const subject = trigger.subject ?? principalSubject(record.authority);
      if (subject !== value.subject && !isOwnerWide(value.authority))
        throw new Fault('scope_denied', 'The source event is no longer visible.', 403);
    }
    const execution = this.records.admitTrigger(value, key);
    if (!execution) return;
    // Child execution must not start until both its queue row and receipt have committed.
    if (this.tasks.size < 4) this.run(execution);
    this.records.noteTrigger(execution.owner, record.definition.id, record.revision);
  }
  launch(principal: Principal, record: WorkflowRecord, input: unknown, fileIds: string[]) {
    const execution = this.records.create(this.admission(principal, record, input, fileIds));
    if (this.tasks.size < 4) this.run(execution);
    return execution;
  }
  private run(execution: WorkflowExecution) {
    const controller = new AbortController();
    const work = (
      execution.status === 'cancelling'
        ? this.finishCancellation(execution)
        : this.execute(execution, controller.signal)
    ).finally(() => {
      this.tasks.delete(execution.id);
      if (!this.closed) setImmediate(() => this.tick());
    });
    this.tasks.set(execution.id, { controller, work });
    return work;
  }
  private async execute(execution: WorkflowExecution, signal: AbortSignal) {
    execution.status = 'running';
    this.records.save(execution);
    try {
      const p = this.refresh(execution.authority);
      this.authorize(p, {
        definition: execution.definition,
        revision: execution.revision,
        authority: p,
      });
      const allowed = new Set(workflowAgents(execution.definition));
      const { definition } = validateTaskWorkflow(execution.definition, allowed);
      const outputs = await executeGraph(
        definition.graph.steps,
        definition.concurrency,
        signal,
        async (step, args, stepSignal) => {
          const current = this.refresh(execution.authority);
          this.kernel.authorize(current, step.tool, 'invoke');
          let child: Run;
          const existing = Object.hasOwn(execution.nodes, step.id)
            ? execution.nodes[step.id]
            : undefined;
          if (existing) child = this.store.run(existing, execution.owner, execution.subject);
          else {
            if (Object.keys(execution.nodes).length >= 64)
              throw new Fault('invalid_graph', 'Workflow expanded beyond 64 agent calls.');
            const body = invocationSchema.parse({
              agent: step.tool,
              input: args.input,
              model: args.model ?? 'auto',
              file_ids: args.file_ids ?? execution.fileIds,
              background: true,
              metadata: {
                'oaa.durable': 'true',
                'oaa.workflow_execution': execution.id,
                ...(typeof args.output_kind === 'string'
                  ? { 'oaa.output_kind': args.output_kind }
                  : {}),
                ...(typeof args.format === 'string' ? { 'oaa.output_format': args.format } : {}),
                ...(definition.project ? { 'oaa.project': definition.project } : {}),
                ...(typeof args.strategy === 'string'
                  ? { 'oaa.routing_strategy': args.strategy }
                  : {}),
              },
            });
            child = this.kernel.submitWorkflowStage(current, body, execution.id, step.id);
            execution.nodes = { ...execution.nodes, [step.id]: child.id };
          }
          if (child.status === 'interrupted')
            throw new Fault(
              'reconciliation_required',
              'A workflow stage has an interrupted or uncertain outcome.',
              409,
            );
          let result: Run;
          try {
            result = await this.kernel.wait(child.id, false, stepSignal);
          } catch (error) {
            if (!this.closed && stepSignal.aborted)
              await this.kernel.cancel(current, child.id).catch(() => {});
            throw error;
          }
          if (result.status !== 'completed')
            throw new Fault(
              'reconciliation_required',
              `Workflow stage ${step.id} ended ${result.status}; no automatic replay was attempted.`,
              409,
            );
          return {
            output: result.output
              .map((m) => m.text)
              .join('\n')
              .slice(0, 12000),
            run_id: result.id,
            artifacts: result.artifactIds.map((id) => ({ id })),
          };
        },
        undefined,
        { input: execution.input, $input: execution.input },
      );
      execution.output = projectGraphOutput(definition.graph.output, outputs, {
        input: execution.input,
        $input: execution.input,
      });
      execution.status = 'completed';
      delete execution.error;
    } catch (error) {
      if (this.closed) return;
      execution.error = faultOf(error).code;
      execution.status = signal.aborted
        ? 'cancelled'
        : execution.error === 'reconciliation_required'
          ? 'blocked'
          : 'failed';
    } finally {
      if (
        !this.closed &&
        this.records.execution(execution.owner, execution.id).status !== 'cancelling'
      )
        this.records.save(execution);
    }
  }
  visible(p: Principal, execution: WorkflowExecution, detail = false) {
    if (
      p.owner !== execution.owner ||
      (!isOwnerWide(p) && principalSubject(p) !== execution.subject)
    )
      throw new Fault('scope_denied', 'Workflow execution belongs to another caller.', 403);
    this.authorize(p, {
      definition: execution.definition,
      revision: execution.revision,
      authority: p,
    });
    const { authority: _authority, cancellation: _cancellation, ...value } = execution;
    const stages = this.records.stages(execution);
    const waiting = stages.filter((s) => s.waiting_on);
    return {
      ...value,
      cancel_requested: !!execution.cancellation,
      progress: {
        started: stages.length,
        completed: stages.filter((s) => s.status === 'completed').length,
        ...(waiting.length
          ? {
              waiting_on: waiting.some((s) => s.waiting_on === 'owner')
                ? ('owner' as const)
                : ('caller' as const),
            }
          : {}),
      },
      ...(detail ? { stages } : {}),
    };
  }
  async cancel(p: Principal, execution: WorkflowExecution) {
    this.visible(p, execution);
    if (['completed', 'failed', 'cancelled'].includes(execution.status)) return;
    execution.status = 'cancelling';
    execution.cancellation = this.refresh(p);
    this.records.save(execution);
    const task = this.tasks.get(execution.id);
    if (task) {
      task.controller.abort();
      await task.work;
    }
    const current = this.records.execution(execution.owner, execution.id);
    if (current.status !== 'cancelling') return;
    await (this.tasks.get(execution.id)?.work ?? this.run(current));
  }
  private async finishCancellation(execution: WorkflowExecution) {
    try {
      for (const stage of this.records.stages(execution)) {
        if (stage.status === 'unavailable')
          throw new Fault(
            'reconciliation_required',
            'A workflow child state is unavailable; cancellation could not be verified.',
            409,
          );
        if (!['queued', 'in_progress', 'requires_action'].includes(stage.status)) continue;
        if (this.closed) return;
        await this.kernel.cancel(
          this.refresh(execution.cancellation ?? execution.authority),
          stage.run_id,
        );
      }
      execution.status = 'cancelled';
      delete execution.error;
    } catch (error) {
      execution.status = 'blocked';
      execution.error = faultOf(error).code;
    } finally {
      if (!this.closed) this.records.save(execution);
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.store.events.off('summary', this.observe);
    for (const task of this.tasks.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map((t) => t.work));
  }
}
