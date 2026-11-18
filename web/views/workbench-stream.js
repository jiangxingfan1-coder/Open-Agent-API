import { api, apiError, authHeaders, LOCAL_ERROR_TEXT } from '../lib/api.js';
import { queueLoad } from '../lib/live.js';
import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';
import { CLIENT_TOOL_TEMPLATES, targetModelName } from './workbench-code.js';

/** Split a streaming text buffer into complete SSE frames and the trailing remainder. */
export function parseSseFrames(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = [];
  let cursor = 0;
  let end;
  while ((end = normalized.indexOf('\n\n', cursor)) >= 0) {
    const raw = normalized.slice(cursor, end);
    cursor = end + 2;
    if (!raw.trim()) continue;
    let event = 'message';
    let id = null;
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = val;
      else if (field === 'id') id = val;
      else if (field === 'data') dataLines.push(val);
    }
    if (!dataLines.length) continue;
    const rawData = dataLines.join('\n');
    if (rawData === '[DONE]') {
      frames.push({ event: 'done', id, data: null });
      continue;
    }
    try {
      frames.push({ event, id, data: JSON.parse(rawData) });
    } catch {
      frames.push({ event, id, data: { raw: rawData } });
    }
  }
  return { frames, rest: normalized.slice(cursor) };
}

/** Upload large local images (> 512 KiB) via /v1/files; keep smaller images inline as data URLs. */
async function prepareImageParts(images, token) {
  const parts = [];
  for (const img of images) {
    if (img.bytes > 512 * 1024 && img.dataUrl) {
      const comma = img.dataUrl.indexOf(',');
      const base64 = comma >= 0 ? img.dataUrl.slice(comma + 1) : '';
      const uploaded = await api(
        'POST',
        '/v1/files',
        { filename: img.name || 'image.png', content: base64, encoding: 'base64' },
        { token },
      );
      parts.push({ type: 'input_image', file_id: uploaded.id });
    } else {
      parts.push({ type: 'input_image', image_url: img.dataUrl });
    }
  }
  return parts;
}

/** Build the headers and JSON request body for POST /v1/responses. */
export function buildResponsesRequest({
  agentId,
  route,
  input,
  imageParts = [],
  toolMode = 'auto',
  clientTools = [],
  toolOutputs = null,
  previousResponseId = null,
  handoff = false,
  project = '',
  recommend = false,
}) {
  const model = targetModelName(agentId, route);
  const tools = clientTools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters || { type: 'object', properties: {} },
  }));
  const metadata = {
    ...(project ? { 'oaa.project': project } : {}),
    ...(recommend ? { 'oaa.orchestration_action': 'recommend' } : {}),
    ...(handoff ? { 'oaa.handoff': 'true' } : {}),
  };
  let wireInput;
  if (Array.isArray(toolOutputs) && toolOutputs.length) {
    wireInput = toolOutputs.map((entry) => ({
      type: 'function_call_output',
      call_id: entry.call_id,
      output: String(entry.output ?? ''),
    }));
  } else if (imageParts.length) {
    wireInput = [
      {
        role: 'user',
        content: [...(input ? [{ type: 'input_text', text: input }] : []), ...imageParts],
      },
    ];
  } else {
    wireInput = input;
  }
  const effectiveMode =
    Array.isArray(toolOutputs) && toolOutputs.length ? 'bridge' : toolMode || 'auto';
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-OAA-Compat': 'true',
    'X-OAA-Progress': 'reasoning',
    ...(tools.length || effectiveMode !== 'auto' ? { 'X-OAA-Client-Tools': effectiveMode } : {}),
  };
  const body = {
    model,
    input: wireInput,
    stream: true,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    ...(tools.length ? { tools } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
  return { headers, body };
}

export function defaultToolResultFor(toolName) {
  const tpl = CLIENT_TOOL_TEMPLATES.find((item) => item.name === toolName);
  return tpl ? tpl.sampleResult : '{"ok":true}';
}

async function fetchOwnerActions(turn, token, onUpdate) {
  if (!turn.runId || token !== state.token) return;
  try {
    const page = await api(
      'GET',
      `/v1/runs/${encodeURIComponent(turn.runId)}/actions?offset=0&limit=10`,
      undefined,
      { token },
    );
    turn.ownerActions = (page.data || []).filter((a) => a.kind !== 'client_tool');
    onUpdate();
  } catch {
    // Keep existing state if reading actions fails transiently.
  }
}

export async function refreshTurnMeta(turn, token, onUpdate, includeArtifacts = false) {
  if (!turn.runId || token !== state.token) return;
  try {
    const reqs = [
      api('GET', `/v1/runs/${encodeURIComponent(turn.runId)}/steps?offset=0&limit=20`, undefined, {
        token,
      }).catch(() => null),
      includeArtifacts
        ? api(
            'GET',
            `/v1/runs/${encodeURIComponent(turn.runId)}/artifacts?offset=0&limit=10`,
            undefined,
            { token },
          ).catch(() => null)
        : Promise.resolve(null),
      includeArtifacts
        ? api('GET', `/v1/runs/${encodeURIComponent(turn.runId)}/state`, undefined, {
            token,
          }).catch(() => null)
        : Promise.resolve(null),
    ];
    const [steps, artifacts, runState] = await Promise.all(reqs);
    if (steps?.data) turn.steps = steps.data;
    if (artifacts?.data) turn.artifacts = artifacts.data;
    if (runState) {
      if (runState.route?.model) turn.resolvedModel = runState.route.model;
      if (runState.usage) turn.usage = runState.usage;
    }
    onUpdate();
  } catch {
    // Metadata enrichment is best-effort.
  }
}

function extractFallbackText(response) {
  if (!Array.isArray(response?.output)) return '';
  const chunks = [];
  for (const item of response.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (typeof part?.text === 'string' && part.text) chunks.push(part.text);
    }
  }
  return chunks.join('\n\n');
}

function upsertCallerCall(turn, call) {
  if (!call?.call_id) return;
  const idx = turn.callerCalls.findIndex((c) => c.call_id === call.call_id);
  const entry = {
    call_id: call.call_id,
    name: call.name || 'tool',
    arguments:
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
  };
  if (idx >= 0) turn.callerCalls[idx] = entry;
  else turn.callerCalls.push(entry);
}

/** Stream a turn (initial user prompt or bridged tool-result continuation) against /v1/responses. */
export async function executeStreamingTurn({
  session,
  turn,
  input = '',
  images = [],
  toolOutputs = null,
  onUpdate,
}) {
  const token = state.token;
  const controller = new AbortController();
  turn.controller = controller;
  turn.streaming = true;
  turn.error = '';
  if (!toolOutputs) {
    turn.status = 'in_progress';
    turn.waitingOn = null;
  } else {
    turn.status = 'in_progress';
    turn.waitingOn = null;
    turn.callerCalls = [];
    if (turn.text) turn.text += '\n\n';
  }
  onUpdate();

  let stepSyncTimer = null;
  const scheduleStepSync = () => {
    if (stepSyncTimer || !turn.runId) return;
    stepSyncTimer = setTimeout(() => {
      stepSyncTimer = null;
      void refreshTurnMeta(turn, token, onUpdate, false);
    }, 450);
  };

  try {
    const imageParts = toolOutputs ? [] : await prepareImageParts(images, token);
    const prevId = toolOutputs ? turn.runId : session.lastResponseId;
    const handoff =
      !toolOutputs &&
      !!prevId &&
      ((session.lastAgentId && session.lastAgentId !== turn.agentId) ||
        (session.lastRoute && session.lastRoute !== turn.route));
    const reqInit = buildResponsesRequest({
      agentId: turn.agentId,
      route: turn.route,
      input,
      imageParts,
      toolMode: turn.toolMode,
      clientTools: turn.clientTools,
      toolOutputs,
      previousResponseId: prevId,
      handoff,
      project: turn.project,
      recommend: turn.recommend,
    });

    let response;
    try {
      response = await fetch('/v1/responses', {
        method: 'POST',
        headers: authHeaders(token, reqInit.headers),
        body: JSON.stringify(reqInit.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw Error(LOCAL_ERROR_TEXT.connection_failed);
    }

    const headerRunId = response.headers.get('X-Run-ID');
    if (headerRunId) turn.runId = headerRunId;

    if (!response.ok || !response.body) {
      const errBody = await response.json().catch(() => ({}));
      throw apiError(response.status, errBody);
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        const d = frame.data || {};
        if (typeof d.sequence_number === 'number') turn.lastSeq = d.sequence_number;
        if (d.response?.id && !turn.runId) turn.runId = d.response.id;

        if (frame.event === 'response.reasoning_summary_text.delta') {
          turn.reasoning += d.delta || '';
          scheduleStepSync();
          onUpdate();
        } else if (frame.event === 'response.output_text.delta') {
          if (turn.status === 'requires_action') {
            turn.status = 'in_progress';
            turn.waitingOn = null;
            turn.ownerActions = [];
          }
          turn.text += d.delta || '';
          onUpdate();
        } else if (
          frame.event === 'response.output_item.done' &&
          d.item?.type === 'function_call'
        ) {
          upsertCallerCall(turn, d.item);
        } else if (
          frame.event === 'response.in_progress' &&
          d.response?.metadata?.['oaa.status'] === 'requires_action'
        ) {
          turn.status = 'requires_action';
          turn.waitingOn = 'owner';
          onUpdate();
          void fetchOwnerActions(turn, token, onUpdate);
        } else if (frame.event === 'response.completed') {
          const resp = d.response || {};
          if (resp.id) turn.runId = resp.id;
          if (resp.usage) turn.usage = resp.usage;
          if (resp.metadata?.['oaa.status'] === 'requires_action') {
            for (const item of resp.output || []) {
              if (item?.type === 'function_call') upsertCallerCall(turn, item);
            }
            turn.status = 'requires_action';
            turn.waitingOn = 'caller';
          } else {
            if (!turn.text) turn.text = extractFallbackText(resp);
            turn.status = 'completed';
            turn.waitingOn = null;
            turn.ownerActions = [];
            turn.callerCalls = [];
            session.lastResponseId = turn.runId;
            session.lastAgentId = turn.agentId;
            session.lastRoute = turn.route;
          }
          onUpdate();
        } else if (
          frame.event === 'response.failed' ||
          frame.event === 'response.incomplete' ||
          frame.event === 'response.cancelled' ||
          frame.event === 'error'
        ) {
          const problem = d.response?.error || d.error;
          turn.status =
            frame.event === 'response.incomplete'
              ? 'incomplete'
              : frame.event === 'response.cancelled'
                ? 'cancelled'
                : 'failed';
          turn.waitingOn = null;
          if (problem?.message) turn.error = problem.message;
          onUpdate();
        }
      }
    }
    await refreshTurnMeta(turn, token, onUpdate, true);
    queueLoad(['runs']);
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (turn.status === 'in_progress') turn.status = 'cancelled';
    } else {
      turn.status = 'failed';
      turn.error = err.message || t('wb.err.failed');
    }
    onUpdate();
  } finally {
    if (stepSyncTimer) clearTimeout(stepSyncTimer);
    turn.streaming = false;
    turn.controller = null;
    onUpdate();
  }
}

/** Follow a run's native event stream (/v1/runs/:id/events) if an earlier HTTP stream detached. */
export async function attachRunEventsStream(session, turn, token, onUpdate) {
  if (!turn.runId || turn.streaming) return;
  const controller = new AbortController();
  turn.controller = controller;
  turn.streaming = true;
  onUpdate();
  try {
    const response = await fetch(
      `/v1/runs/${encodeURIComponent(turn.runId)}/events?after=${turn.nativeCursor || 0}`,
      {
        headers: authHeaders(token, { Accept: 'text/event-stream' }),
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        const ev = frame.data || {};
        if (typeof ev.id === 'number') turn.nativeCursor = ev.id;
        if (frame.event === 'response.output_text.delta') {
          turn.status = 'in_progress';
          turn.waitingOn = null;
          turn.text += ev.data?.delta || '';
          onUpdate();
        } else if (frame.event === 'run.requires_action') {
          const kind = ev.data?.approval?.kind;
          turn.status = 'requires_action';
          turn.waitingOn = kind === 'client_tool' ? 'caller' : 'owner';
          if (turn.waitingOn === 'owner') void fetchOwnerActions(turn, token, onUpdate);
          onUpdate();
        } else if (frame.event === 'response.completed') {
          turn.status = 'completed';
          turn.waitingOn = null;
          turn.ownerActions = [];
          session.lastResponseId = turn.runId;
          session.lastAgentId = turn.agentId;
          session.lastRoute = turn.route;
          onUpdate();
        } else if (frame.event === 'response.failed' || frame.event === 'response.cancelled') {
          turn.status = frame.event === 'response.cancelled' ? 'cancelled' : 'failed';
          turn.waitingOn = null;
          if (ev.data?.error?.message) turn.error = ev.data.error.message;
          onUpdate();
        }
      }
    }
    await refreshTurnMeta(turn, token, onUpdate, true);
  } catch {
    // Ignore abort or transient stream closure.
  } finally {
    turn.streaming = false;
    turn.controller = null;
    onUpdate();
  }
}

/** Submit an owner approval decision (approve / deny) for a paused run. */
export async function submitOwnerDecision({
  session,
  turn,
  actionId,
  decision,
  replyJson,
  onUpdate,
}) {
  const token = state.token;
  let responseObj = {};
  if (decision === 'approve' && replyJson && replyJson.trim()) {
    const parsed = JSON.parse(replyJson.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Error(t('wb.approval.invalidJson'));
    }
    responseObj = parsed;
  }
  await api(
    'POST',
    `/v1/runs/${encodeURIComponent(turn.runId)}/actions/${encodeURIComponent(actionId)}`,
    { decision, response: responseObj },
    { token },
  );
  turn.ownerActions = (turn.ownerActions || []).filter((a) => a.id !== actionId);
  if (!turn.ownerActions.length) {
    turn.waitingOn = null;
    turn.status = decision === 'deny' ? 'failed' : 'in_progress';
  }
  onUpdate();
  queueLoad(['runs']);
  // If the original /v1/responses stream had already closed before the owner clicked Approve,
  // attach to /v1/runs/:id/events so the remaining output still streams live into the bubble.
  if (!turn.streaming && decision === 'approve') {
    void attachRunEventsStream(session, turn, token, onUpdate);
  } else if (!turn.streaming) {
    await refreshTurnMeta(turn, token, onUpdate, true);
  }
}
