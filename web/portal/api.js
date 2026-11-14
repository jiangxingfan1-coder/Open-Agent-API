import { emit } from './state.js';

// Portal session token (oas_…). It only works on /v1/portal/*; API keys (sk-oaa-…) never go here.
const SESSION_KEY = 'oaa.portal.session.v1';
export const session = {
  token() {
    let stored = '';
    try {
      stored = localStorage.getItem(SESSION_KEY) || '';
    } catch {
      stored = '';
    }
    return stored || session.memory;
  },
  set(token) {
    try {
      localStorage.setItem(SESSION_KEY, token);
    } catch {
      // Private mode: the session lasts until the page is closed.
      session.memory = token;
    }
  },
  clear() {
    session.memory = '';
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing stored.
    }
  },
  memory: '',
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// The two codes that mean "this token is no use any more": drop it and send the user to log in.
const SESSION_LOST = new Set(['session_invalid', 'account_disabled']);

export async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) {
    const token = session.token();
    if (!token) {
      emit('portal:session-lost', { code: 'session_invalid' });
      throw new ApiError(401, 'session_invalid');
    }
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'connection_failed');
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const code = data?.error?.code || `http_${response.status}`;
    if (auth && SESSION_LOST.has(code)) {
      session.clear();
      emit('portal:session-lost', { code });
    }
    throw new ApiError(response.status, code, data?.error?.message);
  }
  return data;
}

const q = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
};

export const portal = {
  site: () => api('/v1/portal/site'),
  agents: () => api('/v1/portal/agents'),
  agent: (id) => api(`/v1/portal/agent${q({ id })}`),
  signup: (body) => api('/v1/portal/signup', { method: 'POST', body }),
  login: (body) => api('/v1/portal/login', { method: 'POST', body }),
  logout: () => api('/v1/portal/logout', { method: 'POST', auth: true }),
  account: () => api('/v1/portal/account', { auth: true }),
  changePassword: (body) =>
    api('/v1/portal/account/password', { method: 'POST', body, auth: true }),
  keys: () => api('/v1/portal/keys', { auth: true }),
  createKey: (name) => api('/v1/portal/keys', { method: 'POST', body: { name }, auth: true }),
  deleteKey: (id) =>
    api(`/v1/portal/keys/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true }),
  redeem: (code) => api('/v1/portal/redeem', { method: 'POST', body: { code }, auth: true }),
  usage: (days = 30) => api(`/v1/portal/usage${q({ days })}`, { auth: true }),
  ledger: (limit, cursor) => api(`/v1/portal/ledger${q({ limit, cursor })}`, { auth: true }),
  runs: (limit, cursor, agent) =>
    api(`/v1/portal/runs${q({ limit, cursor, agent })}`, { auth: true }),
  run: (id) => api(`/v1/portal/runs/${encodeURIComponent(id)}`, { auth: true }),
  // Public: the one-time reset code from the operator stands in for the old password.
  resetPassword: (body) => api('/v1/portal/password-reset', { method: 'POST', body }),
};
