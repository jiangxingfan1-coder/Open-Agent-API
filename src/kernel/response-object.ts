import { terminal, type Run } from '../core/contracts.js';

export function responseObject(run: Run): Record<string, unknown> {
  const status =
    run.status === 'requires_action'
      ? 'in_progress'
      : run.status === 'interrupted'
        ? 'incomplete'
        : run.status;
  return {
    id: run.id,
    object: 'response',
    created_at: Math.floor(run.createdAt / 1000),
    completed_at: run.status === 'completed' ? Math.floor(run.updatedAt / 1000) : null,
    status,
    error: run.status === 'failed' ? run.error : null,
    incomplete_details: ['incomplete', 'interrupted'].includes(run.status)
      ? { reason: run.error?.code ?? 'interrupted' }
      : null,
    model: run.agentId,
    output: run.output.map((m) => ({
      id: m.id,
      type: 'message',
      role: 'assistant',
      status:
        m.status ??
        (run.status === 'completed'
          ? 'completed'
          : terminal(run.status)
            ? 'incomplete'
            : 'in_progress'),
      content: [{ type: 'output_text', text: m.text, annotations: [], logprobs: [] }],
    })),
    // 官方 ResponseUsage 里两个明细对象是必填的；网关不知道缓存与推理
    // token 的拆分，给 0。
    usage: run.usage
      ? {
          ...run.usage,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        }
      : null,
    metadata: {
      ...run.metadata,
      'oaa.status': run.status,
      'oaa.agent_version': run.digest,
      'oaa.selected_model': run.route.model,
      'oaa.selected_route': run.route.id,
      'oaa.session_id': run.sessionId,
    },
    previous_response_id: run.previousId,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    // A structured-output run echoes the caller's own format object (docs/structured-output.md).
    text: { format: run.checkpoint.outputContract?.format ?? { type: 'text' } },
    store: true,
  };
}
