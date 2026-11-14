/** 网关版本号：`/health`、`/v1/portal/site` 与 OpenAPI 描述共用这一处。 */
export { PRODUCT_VERSION as GATEWAY_VERSION } from '../core/version.js';

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
