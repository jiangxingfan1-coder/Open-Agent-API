# Public deployment runbook (P0: trusted distribution)

English · [简体中文](zh-CN/deploy-public.md)

> **Which document is this?** This one is the **step-by-step runbook**: the configuration, reverse proxy, key distribution, workers, backup, and go-live checklist for putting a gateway on the public internet today. For the reasons behind it (what blocked going public, who is isolated from whom, and what P1 and P2 will add), see the design document [public-deployment.md](public-deployment.md). Where the two overlap, this runbook is the operational authority.

> Scope: putting one OAA gateway on the public internet for **callers you know and trust** ("form A" in the plan, see §3 of [public-deployment.md](public-deployment.md)). Public calls aimed at strangers need a production-grade execution sandbox, which is not yet available (an optional process-level `sandbox` execution level exists; see [sandbox-design.md](sandbox-design.md)).
>
> All commands and configuration in this document are **examples** to run on your own server. This repository will not do any deployment, DNS, certificate, firewall, or port operation for you.

## 1. Confirm before deploying

- [ ] Which agents will be published on this gateway? **Do not open native agents (Codex, Claude, Antigravity, DSH) to untrusted callers.** They inherit all the host's privileges, and a caller can make them read or write anything on this machine that they can reach.
- [ ] The model credentials are each vendor's API key, not the sign-in state of a personal subscription.
- [ ] The compliance requirements of the target market are confirmed, for example ICP filing and generative AI service filing; see §13 of the plan.
- [ ] Prepare two domains: `api.<domain>` for callers and `console.<domain>` for the management plane. Below, `api.example.com` and `console.example.com` stand in for them.

## 2. Architecture

```
caller SDK / MCP ──HTTPS──▶ reverse proxy (TLS) ──▶ gateway 127.0.0.1:8787
admin browser    ──HTTPS──▶ the same reverse proxy (console domain, source IPs restricted)
publisher worker ──outbound WSS──▶ api.example.com/v1/nodes/connect
```

- The gateway listens only on `127.0.0.1`, and a reverse proxy on the same machine serves it to the outside.
- A worker connects to the gateway on its own initiative, and the network it sits in does not need to open any inbound port.

## 3. Install the gateway

Node.js 24.18 or later in the 24.x line is required.

```bash
npm ci --omit=optional --ignore-scripts
```

```bash
npm run build
```

```bash
npm run oaa -- init --dir /srv/oaa/data
```

`init` generates `/srv/oaa/data/config.json` and `admin.token`, with file permissions that make them readable only by the current user. `admin.token` is the owner-level admin key; do not give it to any caller.

## 4. Gateway configuration

Add or change the following fields in `config.json`, and leave the rest as `init` generated it:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "publicBaseUrl": "https://api.example.com",
  "trustProxy": true,
  "allowedHosts": ["api.example.com", "console.example.com"],
  "allowedOrigins": ["https://console.example.com"],
  "consoleHosts": ["console.example.com"],
  "maxActiveRunsPerSubject": 4,
  "defaultKeyExecution": "workspace"
}
```

| Field | Purpose |
|---|---|
| `host: 127.0.0.1` | Reachable only by the reverse proxy on this machine, not exposed directly |
| `publicBaseUrl` | The endpoint catalog returned by `GET /v1/me` is generated from this address |
| `trustProxy` | Reads `X-Forwarded-Proto/Host` and `X-Forwarded-For` (the source IP used by audit records and developer platform rate limiting). Turn it on only when there really is a reverse proxy in front |
| `allowedHosts` | Responds only to these Hosts; everything else gets 403 `invalid_host` |
| `consoleHosts` | The console and admin keys are usable only on these domains (see "Management plane and API domain separation" in `docs/protocol.md`) |
| `maxActiveRunsPerSubject` | How many unfinished requests each caller may have at the same time; the owner total limit is still 32 |
| `defaultKeyExecution` | A newly created key can by default call only agents of the `workspace` level, and cannot call native agents, adapters, or host tools. When truly needed, specify `"execution": "host"` explicitly when creating the key, and only for trusted parties |

If the gateway has its own local worker (`localWorker`) and will enable native agents or adapters, we recommend turning on the environment variable allowlist:

```json
{
  "localWorker": {
    "nativeEnv": { "mode": "allowlist", "allow": ["ANTHROPIC_API_KEY"] }
  }
}
```

In allowlist mode a child process receives only these variables:

- Base variables: `PATH`, `HOME`, `LANG`, `TMPDIR`, and so on, plus `LC_*`.
- Proxy variables: `HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`, passed through as is, so network behavior is the same before and after turning it on.
- The variables you list in `allow`.

`OAA_*` is never passed to a child process in any mode. The default `inherit` mode is the same as before and inherits all other variables.

## 5. Reverse proxy

Requirements:

- Support for HTTP/1.1 Upgrade, which workers' WSS connections need.
- Long connections do not time out, or the timeout is not shorter than the longest duration of a single run. The gateway's SSE sends a heartbeat every 15 seconds.
- A request body limit of no less than 24 MiB.
- Forward `Host` as is, and **overwrite** the `X-Forwarded-*` headers the client brings, and never pass through values sent by the client.
- Static assets such as fonts are served by the gateway, and font files carry long cache headers (`immutable`), so no special configuration is needed. If the proxy only lets fixed paths through, allow `/styles/`, `/shared/`, `/fonts/`, and under the portal `/portal/styles/`, `/portal/shared/`, `/portal/fonts/`.

Caddy example (certificates are obtained and renewed automatically):

```caddyfile
api.example.com {
    request_body {
        max_size 24MB
    }
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}

console.example.com {
    @outside not remote_ip 203.0.113.0/24
    respond @outside 403
    reverse_proxy 127.0.0.1:8787
}
```

Nginx example (certificate configuration omitted):

```nginx
server {
    server_name api.example.com;
    client_max_body_size 24m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

Nginx's `$connection_upgrade` must be defined in the `http` block with `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`. Write another block for `console.example.com` in the same way, and restrict source IPs with `allow` / `deny`.

In addition, `oaa tunnel` can use cloudflared to produce a temporary public address, which suits demos and is not recommended for long-term use.

## 6. Start

```bash
npm run oaa -- serve --config /srv/oaa/data/config.json --detach
```

`--detach` confirms that the background process has started, and the PID and log are written in the data directory. If you need it to start at boot, run `serve` without `--detach` under a process manager such as systemd.

After it starts, check on the server:

```bash
curl -s http://127.0.0.1:8787/health
```

Accessed directly on the machine it returns `pid`. Accessed through `https://api.example.com/health` there is no `pid`, which is expected.

## 7. Distribute caller keys

Give each caller a separate key, created on the **console domain**:

```bash
curl -s https://console.example.com/v1/keys \
  -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"partner-a","agents":["agent/research"],"scopes":["invoke","read","files"],"quota":{"rpm":60,"maxConcurrentRuns":2}}'
```

- The returned `token` is shown only this once; hand it over through a secure channel.
- The default `data_scope` is `own`: a caller can see only their own runs, files, and memory, isolated from each other (see "Caller data isolation" in `docs/protocol.md`).
- For a key that needs to see all callers' data, such as a read-only monitoring dashboard, add `"data_scope": "owner"` when creating it, and grant only the `read` scope.
- Do not give callers the `admin` scope. Once `consoleHosts` is configured, an admin key cannot be used on the API domain either.
- Denied calls (permission, isolation, quota) go into the audit records, which you can view with an admin key on the console domain through `GET /v1/audit`.

How a caller writes it:

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key="the key given to them")
response = client.responses.create(model="agent/research", input="Analyze these materials.")
```

If you want callers to **use their own model quota**, add `"byok": true` in the worker's provider configuration (see "Caller-supplied model keys" in `docs/protocol.md`). The caller then brings their own key in a request header:

```python
client = OpenAI(
    base_url="https://api.example.com/v1",
    api_key="the key given to them",
    default_headers={"X-OAA-Provider-Key": "the caller's own model provider key"},
)
```

Note: once `byok` is on, the caller's key is sent to the `baseUrl` configured for that provider, so turn it on only for upstream addresses you trust.

### Distributing through the developer platform

If you want developers to register and create keys themselves, instead of you handing them out one by one, you can configure the `platform` section to enable the developer platform (for the configuration and interfaces see [platform.md](platform.md)). Then:

- Developers register, redeem credits, and create their own API keys in the portal `https://api.example.com/portal/`. The scopes of keys created in the portal are fixed to `invoke`, `read`, and `files`, with no `admin`. The execution level is decided by `platform.keyExecution` and can only be `workspace` or `sandbox`.
- Developers can call only the agents you have listed and enabled on the console's "Developer platform" page.
- Credits are issued by you (redemption codes or manual adjustment); the platform does not take payments.
- Do not list native agents (Codex, Claude, Antigravity, DSH). They run with host privileges, and a key of the `workspace` level cannot call them anyway (see `defaultKeyExecution` in §4).
- Account keys do not appear in the list of `GET /v1/keys`.

## 8. Connect a remote worker

1. Register the node on the console domain: `POST /v1/nodes/enroll`, with the request body `{"node_id":"workstation-2","agents":["agent/research"],"capabilities":["*"]}`. The returned `token` is the node credential, completely separate from caller keys.
2. Write the configuration on the worker machine, with `gatewayUrl` set to `https://api.example.com` and `tokenFile` pointing to the node credential obtained in the previous step. For the full format see "Workers" in [operations.md](operations.md#workers).
3. Run on the worker machine:

```bash
npm run oaa -- node join --config /private/path/worker.json
```

You can use `oaa node drain`, `oaa node resume`, and `oaa node revoke` to pause, resume, or revoke a node.

## 9. Backup, upgrade, and rollback

- All data is in the data directory: `state.sqlite` plus `files/`. For a backup, stop the gateway first, or use SQLite's online backup (`VACUUM INTO`), and do not directly copy a database file that is being written while the gateway runs.
- **Upgrading to schema v4 makes a backup automatically**, at `<dataDir>/backups/state-v<old version>-before-subjects-<timestamp>.sqlite`. v4 cannot be opened by an older gateway (it reports `schema_too_new`). To roll back: stop the new gateway, copy the backup back over `state.sqlite`, and start the old version.
- After the upgrade, non-admin read-only keys created before can by default see only their own data. Those that need a global view should be recreated with `data_scope: "owner"`.

## 10. Go-live checklist

- [ ] From the public internet, accessing `https://api.example.com/` returns 404, and `/health` returns 200 without `pid`.
- [ ] From the public internet, accessing `https://api.example.com/v1/agents` with an admin key returns 403 `admin_host_denied`.
- [ ] Create a run with caller key A and read it with key B: it returns 404 `run_not_found`.
- [ ] Accessing with a forged Host (for example `curl -H 'Host: evil.example.net'`) returns 403 `invalid_host`.
- [ ] At least one remote worker has connected over WSS and completed a run successfully.
- [ ] The data directory already has a backup, and a restore has actually been rehearsed once.
- [ ] Send one non-streaming call to `https://api.example.com/v1` with the official OpenAI SDK and confirm the result is normal; then call an agent that does not exist and confirm the error the SDK raises carries `error.code`.
- [ ] Disconnect a run's event stream midway (for example close `GET /v1/responses/{id}?stream=true` halfway through reading), and after reconnecting you can receive the terminal event.

## 11. Known limitations (outside the scope of P0)

- There is no sandbox by default. Native agents and host scripts run with the host's privileges. An optional process-level `sandbox` execution level now exists (srt; script tools, and in code Claude and Codex, which has not yet been tested with the real CLIs), but it is not yet isolation fit for strangers at scale; see [sandbox-design.md](sandbox-design.md).
- A single gateway with SQLite cannot scale horizontally and has no failover; that is P2.
- Each key's RPM count is in process memory and resets to zero on restart.
- Billing and self-service registration are available only after configuring `platform` (see [platform.md](platform.md)). Credits are issued by the operator; there is no payment channel and no email: there is no email verification, and passwords are reset by the operator.
