# Usage & Quotas

English · [简体中文](zh-CN/usage-monitor.md)

The console uses OAA's own design system and keeps three accounting scopes separate:

- **OAA usage**: reported input, output and total tokens, per day and per agent, from retained gateway runs. Completed delegated usage is subtracted from the parent's inclusive total before summing executions. Unknown and partial reports remain explicit lower bounds. Buckets use execution start time in UTC, not provider billing-event time. Pruned or never-reported history cannot be reconstructed.
- **Account quotas**: CodexBar-reported quota windows, remaining percentages, reset times and balances when supplied. A quota percentage is not a remaining token count. Shared account limits are not divided among agents or models. A zero balance is retained; missing metrics are not zero. Synthetic placeholder windows are omitted and named windows with unknown usage do not become full allowances.
- **Local tokens**: ccusage daily input/output/cache-read/cache-write totals from local agent histories. This can include calls already counted by OAA, so the two scopes are never added. No-cost/offline mode prevents API-price estimates from being presented as subscription spending.

OAA API-key limits are **lifetime local grants**, independent of the selected report period and provider subscription quotas. An unset key limit is unbounded, not a zero balance.

## Collectors

The 2026-11-16 comparison considered these upstream projects:

| Project | Strength | Selection |
| --- | --- | --- |
| [CodexBar](https://github.com/steipete/CodexBar) | Broad account-quota coverage; the reviewed registry has 114 provider IDs, including Codex, Claude, Antigravity and Qoder; CLI JSON and a credential-free shared cache | Primary quota integration. Registration does not prove every provider works or reports every metric. |
| [ccusage](https://github.com/ccusage/ccusage) | Unified local token reports for 19 agent sources, including cache token categories | Complementary local-history integration. |
| [Quota](https://github.com/pinkpixel-dev/quota) | Read-only account readers and desktop/editor integrations | Reviewed, not embedded. |
| [clanker-usage](https://github.com/wakamex/clanker-usage) | Unified plan/quota interface for a smaller provider set | Reviewed, not embedded. |
| [goso](https://github.com/ainoya/goso) | Focused Claude/Codex/Antigravity terminal reports with explicit derived-data labels | Reviewed, not embedded. |

Source revisions and full MIT notices for the two integrations are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). No upstream UI is embedded and no upstream source is modified.

## Access And Collection

All monitor routes require a direct loopback owner-wide administrator on a local gateway, bound to its local worker owner. Forwarded, cross-origin, scoped and foreign-owner calls are refused. Public-mode gateways do not start collectors. A remote read key cannot see this machine's account allowances.

Collectors are **disabled by default**. In Data Sources:

1. For CodexBar, choose its opt-in private shared cache or an explicitly installed CLI. The default macOS cache is `~/Library/Application Support/CodexBar/CLIUsageCache/usage.json`; enable sharing in CodexBar itself. The cache carries quota windows, not credentials or account identity.
2. CLI quota collection requires individual provider IDs (up to eight) and an explicit `cli`, `oauth` or `api` source. `auto`, `web`, `all` and `both` are not used. OAA sets `CODEXBAR_DISABLE_KEYCHAIN_ACCESS=1`, never supplies a model prompt, and never imports browser cookies itself. Provider-owned authentication may refresh in the selected collector/agent. Sources needing browser cookies, such as CodexBar's current Qoder integration, require a separately prepared quota snapshot rather than silent cookie access.
3. Enabling ccusage explicitly authorizes local history scanning. It runs `daily --by-agent --json --offline --no-cost`, with a 90-day cutoff and UTC buckets, from OAA's private collector directory. It does not modify source logs.
4. The upload action accepts a CodexBar usage/cache JSON or ccusage daily JSON. Imported snapshots are in-memory and do not enable recurring collection. Import time never changes a quota's observation time.

Enabled collectors refresh every five minutes, with a 30-second manual-refresh cooldown. Processes run without a shell, with bounded output and deadlines, excluding `OAA_*` credentials. Only basic/path environment variables are forwarded. Executables and their upstream provider implementations are trusted local software, not an OS sandbox. Collection failures retain last-known data but cannot make it fresh. Quotas older than 15 minutes, past a reset boundary, or missing a trustworthy observation time are marked last-known/unavailable.

Configuration writes are private, atomic and revision-checked. Administrative authority is revalidated before changes commit. OAA's normalized results exclude raw collector diagnostics, access tokens, conversation text, project paths and session IDs. Account emails, when present, are masked.

## API

Feature `local-usage-v1` advertises:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/local/usage?days=7` | OAA ledger (1–90 days), lifetime key allowances and collector state |
| POST | `/v1/local/usage/settings` | `{settings, revision, confirmed:true}`; configure opt-in collectors |
| POST | `/v1/local/usage/refresh` | Refresh enabled collectors; never starts a model generation |
| POST | `/v1/local/usage/import` | `{collector, snapshot}`; collector is `codexbar` or `ccusage`; bounded JSON import |

Providers without a compatible quota interface remain unavailable. Discovery, fixture tests and successful imports do not establish live account entitlement or complete vendor accounting.
