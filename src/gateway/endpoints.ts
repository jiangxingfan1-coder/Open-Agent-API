/** 网关版本号：`/health`、`/v1/portal/site` 与 OpenAPI 描述共用这一处。 */
export { PRODUCT_VERSION as GATEWAY_VERSION } from '../core/version.js';

/** Versioned optional gateway capabilities; transport support is still checked per agent. */
export const GATEWAY_FEATURES = [
  'a2a-adapters-v1',
  'acp-adapters-v1',
  'adapter-stream-v1',
  'agent-orchestration-v1',
  'agent-policy-v1',
  'approval-policy-v1',
  'catalog-events-v1',
  'client-tools-policy-v1',
  'conversion-profile-v1',
  'error-catalog-v1',
  'error-codes-v1',
  'harness-bridge-acp-v1',
  'harness-bridge-v1',
  'image-input-v1',
  'local-backends-v1',
  'local-connections-v1',
  'local-usage-v1',
  'model-catalog-v1',
  'oaa-lang-roundtrip-v1',
  'overview-activity-v1',
  'overview-etag-v1',
  'overview-events-v1',
  'platform-setup-v1',
  'queue-insight-v1',
  'run-timeline-v1',
  'stream-progress-v1',
  'structured-output-v1',
  'webhooks-v1',
  'workflow-output-v1',
].sort();

export const buildEndpointDirectory = (baseUrl: string) => {
  const wsBase = baseUrl.replace(/^http/i, 'ws');
  return {
    base_url: baseUrl,
    openai_sdk_base_url: `${baseUrl}/v1`,
    openai_compat_base_url: `${baseUrl}/v1/compat`,
    universal_endpoint: `${baseUrl}/v1/universal`,
    uap_endpoint: `${baseUrl}/v1/uap`,
    responses_endpoint: `${baseUrl}/v1/responses`,
    chat_completions_endpoint: `${baseUrl}/v1/chat/completions`,
    compat_chat_completions_endpoint: `${baseUrl}/v1/compat/chat/completions`,
    claude_messages_endpoint: `${baseUrl}/v1/messages`,
    gemini_models_prefix: `${baseUrl}/v1beta/models`,
    worker_connect_ws: `${wsBase}/v1/nodes/connect`,
  };
};
