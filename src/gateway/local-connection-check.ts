import { request } from 'node:http';
import { canonical, Fault, sha } from '../core/util.js';
import type { Principal } from '../core/contracts.js';
import type { DshSnapshot } from '../config/dsh-client.js';
import { clientConflict } from '../config/local-client-files.js';
import type { Auth } from './auth.js';
import type {
  ExtendedTargetId,
  LocalConnectionRecord,
  LocalConnectionState,
  ManagedTargetRecord,
} from './local-connection-state.js';
import type { ManagedTargetAdapter } from './local-provider-targets.js';
import { API_TARGETS, type LocalChannel, type LocalTargetId } from './local-connection-source.js';

export async function recoverManagedRecords(
  auth: Auth,
  state: LocalConnectionState,
  p: Principal,
  rows: ManagedTargetRecord[],
  adapterOf: (target: ExtendedTargetId) => ManagedTargetAdapter,
  revoke: (p: Principal, r: Pick<ManagedTargetRecord, 'id' | 'keyId'>) => void,
): Promise<void> {
  for (const r of rows) {
    if (!['installing', 'syncing', 'removing'].includes(r.phase)) continue;
    const adp = adapterOf(r.target);
    try {
      await adp.locked(async (s) => {
        if (s.file.file !== r.configFile) throw clientConflict();
        const keyOk = await validManagedKey(auth, state, p, r);
        if (r.phase !== 'removing' && s.entryExists && s.entryHash === r.owned.entryHash && keyOk) {
          if (r.pendingSource) Object.assign(r, r.pendingSource);
          r.phase = 'active';
        } else if (
          r.phase === 'syncing' &&
          r.previousEntryHash &&
          s.entryExists &&
          s.entryHash === r.previousEntryHash &&
          keyOk
        ) {
          r.owned.entryHash = r.previousEntryHash;
          if (r.previousModelCount !== undefined) r.owned.modelCount = r.previousModelCount;
          if (r.previousPrimaryModel !== undefined) r.owned.primaryModel = r.previousPrimaryModel;
          r.phase = 'active';
        } else {
          revoke(p, r);
          await state.removeKeyFile(r.id);
          r.phase = (await adp.remove(s, r)) ? 'failed' : 'conflict';
        }
        delete r.previousEntryHash;
        delete r.previousModelCount;
        delete r.previousPrimaryModel;
        delete r.pendingSource;
        r.updatedAt = Date.now();
        await state.saveManaged(r);
      }, r.configFile);
    } catch {
      revoke(p, r);
      await state.removeKeyFile(r.id);
      r.phase = 'conflict';
      r.updatedAt = Date.now();
      await state.saveManaged(r);
    }
  }
}

export async function validManagedKey(
  auth: Auth,
  state: LocalConnectionState,
  p: Principal,
  r: ManagedTargetRecord,
): Promise<boolean> {
  const token = await state.readKeyToken(r.id).catch(() => null);
  if (!token || sha(token) !== r.owned.tokenHash) return false;
  try {
    const caller = auth.revalidate(`Bearer ${token}`);
    const entry = auth.list(p).find((k) => k.id === r.keyId && k.localConnectionId === r.id);
    if (!entry || entry.execution !== r.execution) return false;
    const baseOk =
      caller.owner === p.owner &&
      caller.keyId === r.keyId &&
      caller.scopes.length === 3 &&
      ['read', 'invoke', 'files'].every((s) => caller.scopes.includes(s)) &&
      caller.dataScope !== 'owner';
    if (!baseOk) return false;
    if (r.agent === '*') return caller.agents.length === 1 && caller.agents[0] === '*';
    return (
      caller.agents.length === 1 &&
      caller.agents[0] === r.agent &&
      caller.connection?.toolMode === r.toolMode &&
      caller.connection.allowedModes?.length === 1 &&
      caller.connection.allowedModes[0] === r.toolMode
    );
  } catch {
    return false;
  }
}

export function assertChannelMatchesTarget(target: LocalTargetId, channel?: LocalChannel): void {
  if (!channel) return;
  const expected: LocalChannel = (API_TARGETS as readonly string[]).includes(target)
    ? 'api'
    : 'mcp';
  if (channel !== expected)
    throw new Fault(
      'invalid_request',
      `Target '${target}' uses the '${expected}' channel, not '${channel}'.`,
      400,
    );
}

export function validDshKey(
  auth: Auth,
  p: Principal,
  r: LocalConnectionRecord,
  s: DshSnapshot,
): boolean {
  const token = s.refs[r.owned.credentialRef];
  if (typeof token !== 'string' || sha(token) !== r.owned.tokenHash) return false;
  try {
    const caller = auth.revalidate(`Bearer ${token}`);
    const owned = auth.list(p).some((k) => k.id === r.keyId && k.localConnectionId === r.id);
    return (
      owned &&
      caller.owner === p.owner &&
      caller.keyId === r.keyId &&
      caller.agents.length === 1 &&
      caller.agents[0] === r.agent &&
      caller.scopes.length === 3 &&
      ['read', 'invoke', 'files'].every((scope) => caller.scopes.includes(scope)) &&
      caller.dataScope !== 'owner' &&
      caller.connection?.toolMode === r.toolMode &&
      caller.connection.allowedModes?.length === 1 &&
      caller.connection.allowedModes[0] === r.toolMode
    );
  } catch {
    return false;
  }
}

export function assertDshUnchanged(
  r: LocalConnectionRecord | undefined,
  s: DshSnapshot,
  id: string,
): void {
  const providerId = `oaa-${id}`,
    ref = `OAA_DSH_${id.toUpperCase()}`;
  if (s.profileProviders.includes(providerId)) throw clientConflict();
  const provider = s.providers[providerId],
    value = s.refs[ref];
  if (!r || r.phase === 'removed') {
    if (provider !== undefined || value !== undefined) throw clientConflict();
  } else if (
    (provider !== undefined && canonical(provider) !== canonical(r.owned.provider)) ||
    (value !== undefined && (typeof value !== 'string' || sha(value) !== r.owned.tokenHash))
  )
    throw clientConflict();
}

function loopbackGet(
  url: URL,
  token: string,
  verify: (body: unknown) => boolean,
): Promise<{ ok: boolean; status?: number; code?: string }> {
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    return Promise.resolve({ ok: false, code: 'unreachable' });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { ok: boolean; status?: number; code?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = request(
      url,
      { method: 'GET', agent: false, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65_536) {
            req.destroy();
            finish({ ok: false, code: 'unreachable' });
          } else chunks.push(chunk);
        });
        res.once('error', () => finish({ ok: false, code: 'unreachable' }));
        res.once('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {}
          finish({ ok: res.statusCode === 200 && verify(parsed), status: res.statusCode });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, code: 'unreachable' });
    }, 5000);
    req.once('error', () => finish({ ok: false, code: 'unreachable' }));
    req.end();
  });
}

/** Direct loopback only: never send a client credential through inherited HTTP proxy settings. */
export async function checkLocalModel(
  base: string,
  model: string,
  token: string,
): Promise<{ ok: boolean; status?: number; code?: string }> {
  return loopbackGet(
    new URL(`${base}/models/${encodeURIComponent(model)}`),
    token,
    (body) => (body as { id?: unknown } | undefined)?.id === model,
  );
}

/** Direct loopback catalog metadata check for gateway-wide MCP bridges; never invokes a model. */
export async function checkLocalMcpCatalog(
  v1Base: string,
  token: string,
): Promise<{ ok: boolean; status?: number; code?: string }> {
  return loopbackGet(new URL(`${v1Base}/catalog/agents?limit=1`), token, (body) =>
    Array.isArray((body as { data?: unknown } | undefined)?.data),
  );
}
