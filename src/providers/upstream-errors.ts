/**
 * Turns a failed upstream model response into a Fault that names the provider, the kind of
 * problem and the fix. The upstream body is only inspected (first 4 KiB) to classify the
 * failure; it is never copied into the message, which reaches callers.
 */
import type { ProviderConfig } from '../config/config.js';
import { Fault } from '../core/util.js';

const read = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    return text.slice(0, 4096).toLowerCase();
  } catch {
    return '';
  }
};

/** Known request fields that some compatible services reject, and the setting that avoids each. */
const INCOMPATIBLE: readonly [RegExp, (c: Pick<ProviderConfig, 'maxTokensField'>) => string][] = [
  [
    /max_completion_tokens/,
    () =>
      'it does not accept max_completion_tokens; set "maxTokensField": "max_tokens" for this provider',
  ],
  [
    /stream_options|include_usage/,
    () => 'it does not accept stream_options; set "streamUsage": false for this provider',
  ],
  [
    /\btools?\b.*(not|un)\s*support|function call(ing)? (is )?not supported|does not support tools/,
    () =>
      'the model does not support tool calls; pick a model that does, or publish the agent without tools',
  ],
  [
    /image|vision|multimodal/,
    () => 'the model does not accept images; set "imageInput": "none" or pick a vision model',
  ],
];

export async function upstreamFault(
  name: string | undefined,
  config: Pick<ProviderConfig, 'baseUrl' | 'maxTokensField'>,
  response: Response,
  model: string,
): Promise<Fault> {
  const who = `Model provider ${name ?? '(unnamed)'} (${config.baseUrl})`;
  const status = response.status;
  const body = status === 400 || status === 404 || status === 422 ? await read(response) : '';
  await response.body?.cancel().catch(() => {});
  if (status === 429)
    return new Fault(
      'upstream_rate_limited',
      `${who} returned HTTP 429 (rate limited or out of quota).`,
      429,
    );
  if (status === 401 || status === 403)
    return new Fault(
      'upstream_auth_failed',
      `${who} rejected the API key (HTTP ${status}). Check the key referenced by apiKeyEnv / apiKeyFile, its region and its permissions.`,
      502,
    );
  const modelHint =
    /model/.test(body) && /(not.?found|not exist|does not exist|unknown|invalid)/.test(body);
  if (status === 404 || modelHint)
    return new Fault(
      'upstream_model_not_found',
      `${who} does not know the model "${model}" or the endpoint path (HTTP ${status}). Check the model name (oaa models --check lists them) and baseUrl.`,
      502,
    );
  if (status === 400 || status === 422)
    for (const [pattern, fix] of INCOMPATIBLE)
      if (pattern.test(body))
        return new Fault(
          'upstream_incompatible',
          `${who} refused the request (HTTP ${status}): ${fix(config)}.`,
          502,
        );
  return new Fault('upstream_failed', `${who} returned HTTP ${status}.`, 502);
}
