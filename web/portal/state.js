// Shared portal state and the two navigation helpers every view needs.
export const state = {
  site: null,
  account: null,
};

export const go = (path) => {
  location.hash = `#${path}`;
};
export const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
// Re-run the current route (after a mutation that changes what the page shows).
export const refresh = () => emit('portal:refresh');

// Where the OpenAI-compatible base URL, the origin and the responses endpoint live.
export function endpoints() {
  const site = state.site;
  const origin = (site?.base_url || location.origin).replace(/\/+$/, '');
  const e = site?.endpoints ?? {};
  return {
    origin,
    openai: e.openai_sdk_base_url || `${origin}/v1`,
    responses: e.responses_endpoint || `${origin}/v1/responses`,
  };
}
