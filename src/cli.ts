#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { access, readFile, mkdir, open } from 'node:fs/promises';
import { constants, openSync, closeSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentSchema } from './core/contracts.js';
import { initialize, loadConfig, loadWorkerConfig } from './config/config.js';
import { adapterEnginePattern, isNativeEngine } from './config/agent-presets.js';
import { createGateway } from './gateway/server.js';
import { buildBundle, builtin, makeBundle, validateBundle } from './lang/bundle.js';
import {
  decompileToOaaLang,
  diagnoseOaaLang,
  formatOaaLang,
  oaaSourceHasComments,
} from './lang/lang.js';
import { GatewayClient } from './client/client.js';
import { connectWorker } from './fabric/network.js';
import { serveMcp } from './client/mcp.js';
import { runMcpRelay } from './client/mcp-relay.js';
import { CLI_TEXT, cliFailure, cliHelp, initSummary } from './client/cli-text.js';
import {
  createCallerKey,
  gatewayUrl,
  healthPid,
  startDetached,
  stopDetachedGateway,
  adminShutdown,
} from './client/onboarding.js';
import { commandPrefix, quickstart } from './client/quickstart.js';
import { connectAgent } from './client/connect.js';
import { doctorReport } from './client/doctor.js';
import { isOperatorCommand, runOperatorCommand } from './client/operator.js';
import { bi, pick } from './core/locale.js';
import {
  inspectMcp,
  prepareMcp,
  selectedWorker,
  withToolConfigs,
  preparationSchema,
} from './fabric/tool-import.js';
import { Fault, faultOf, sleep, writePrivate, readBounded } from './core/util.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseCliArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      dir: { type: 'string' },
      url: { type: 'string' },
      'token-file': { type: 'string' },
      socket: { type: 'string' },
      'progress-interval-ms': { type: 'string' },
      'file-id': { type: 'string', multiple: true },
      'agent-version': { type: 'string' },
      'previous-response-id': { type: 'string' },
      'idempotency-key': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'max-bytes': { type: 'string' },
      'allowed-node': { type: 'string', multiple: true },
      cursor: { type: 'string' },
      revision: { type: 'string' },
      section: { type: 'string' },
      reason: { type: 'string' },
      offset: { type: 'string' },
      limit: { type: 'string' },
      skill: { type: 'string', multiple: true },
      'tool-binding': { type: 'string', multiple: true },
      'tool-config': { type: 'string', multiple: true },
      server: { type: 'string' },
      tool: { type: 'string' },
      name: { type: 'string' },
      capability: { type: 'string' },
      version: { type: 'string' },
      effect: { type: 'string' },
      approval: { type: 'string' },
      'export-result': { type: 'boolean' },
      optional: { type: 'boolean' },
      out: { type: 'string' },
      input: { type: 'string' },
      model: { type: 'string' },
      engine: { type: 'string' },
      id: { type: 'string' },
      models: { type: 'string' },
      approvals: { type: 'string' },
      'public-url': { type: 'string' },
      detach: { type: 'boolean' },
      write: { type: 'boolean' },
      help: { type: 'boolean' },
      agent: { type: 'string', multiple: true },
      event: { type: 'string', multiple: true },
      'include-output': { type: 'boolean' },
      approve: { type: 'boolean' },
      port: { type: 'string' },
      action: { type: 'string' },
      scenarios: { type: 'string' },
      executable: { type: 'string' },
      all: { type: 'boolean' },
      watch: { type: 'boolean' },
      json: { type: 'boolean' },
      yes: { type: 'boolean' },
      'confirm-live-cost': { type: 'boolean' },
    },
  });
  const command = positionals[0];
  const file = path.resolve(
    values.config ?? (values.dir ? path.join(values.dir, 'config.json') : '.oaa/config.json'),
  );
  const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  if (values.help || !command) {
    process.stdout.write(cliHelp());
    return;
  }
  if (command === 'mcp-relay') {
    // Started by an ACP agent from its session's mcpServers (docs/harness.md); not for people.
    process.exit(
      await runMcpRelay(values.socket, values['token-file'], values['progress-interval-ms']),
    );
  }
  if (command === 'init') {
    print(initSummary(await initialize(values.dir ?? '.oaa'), values.dir ?? '.oaa'));
    return;
  }
  if (command === 'serve') {
    const config = await loadConfig(file);
    if (values['tool-config']?.length) {
      if (!config.localWorker)
        throw new Fault(
          'worker_required',
          '--tool-config requires a localWorker in the gateway configuration.',
        );
      config.localWorker = await withToolConfigs(config.localWorker, values['tool-config']);
    }
    if (values.detach) {
      print(
        await startDetached(fileURLToPath(import.meta.url), file, config, values['tool-config']),
      );
      return;
    }
    const gateway = await createGateway(config, undefined, { configFile: path.resolve(file) });
    const address = await gateway.listen();
    print({ url: address, protocol: 'oaa/1' });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await gateway.app.close();
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    return;
  }
  if (command === 'stop') {
    const config = await loadConfig(file);
    const url = gatewayUrl(config);
    const graceful = process.platform === 'win32' ? adminShutdown(config, url) : undefined;
    print(await stopDetachedGateway(config.dataDir, url, undefined, undefined, graceful));
    return;
  }
  if (command === 'connect') {
    if (!positionals[1])
      throw new Fault('arguments', 'connect needs an agent name, e.g. connect codex.');
    const dir = path.resolve(values.dir ?? '.oaa');
    const config = await loadConfig(path.join(dir, 'config.json'));
    const url = gatewayUrl(config);
    if ((await healthPid(url)) === undefined)
      throw new Fault(
        'not_running',
        bi(
          `${url} 上没有在运行的网关。先运行 oaa quickstart。`,
          `No gateway is running at ${url}. Run oaa quickstart first.`,
        ),
        404,
      );
    const admin = config.keys.find((k) => k.scopes.includes('admin') && k.tokenFile)?.tokenFile;
    if (!admin) throw new Fault('token_required', 'No admin key with a tokenFile is configured.');
    const cliPath = fileURLToPath(import.meta.url);
    await connectAgent(await GatewayClient.fromOptions(url, admin), {
      name: positionals[1],
      keysDir: path.join(dir, 'keys'),
      prefix: commandPrefix(cliPath) + (values.dir ? ` --dir '${dir}'` : ''),
    });
    return;
  }
  if (isOperatorCommand(command)) {
    await runOperatorCommand(command, positionals.slice(1), values, {
      prefix: commandPrefix(fileURLToPath(import.meta.url)),
    });
    return;
  }
  if (command === 'quickstart') {
    await quickstart({
      dir: values.dir ?? '.oaa',
      port: values.port,
      cliPath: fileURLToPath(import.meta.url),
    });
    return;
  }
  if (command === 'doctor') {
    print(await doctorReport(file, Boolean(values.write)));
    return;
  }
  if (command === 'node' && positionals[1] === 'join') {
    const config = await withToolConfigs(await loadWorkerConfig(file), values['tool-config'] ?? []);
    const c = new AbortController();
    process.once('SIGINT', () => c.abort());
    process.once('SIGTERM', () => c.abort());
    await connectWorker(config, c.signal);
    return;
  }
  if (command === 'mcp' && ['inspect', 'prepare'].includes(positionals[1] ?? '')) {
    if (!values.server)
      throw new Fault('arguments', 'Select exactly one configured MCP server with --server.');
    const worker = await selectedWorker(file);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      if (positionals[1] === 'inspect')
        print(
          await inspectMcp(worker, values.server, {
            tool: values.tool,
            cursor: values.cursor,
            signal: controller.signal,
          }),
        );
      else {
        if (!values.tool || !values.capability || !values.out)
          throw new Fault(
            'arguments',
            'mcp prepare requires --tool, --capability and --out NEW_DIRECTORY.',
          );
        const options = preparationSchema.parse({
          server: values.server,
          tool: values.tool,
          capability: values.capability,
          out: values.out,
          name: values.name,
          version: values.version,
          effect: values.effect,
          approval: values.approval,
          exportResult: values['export-result'],
          optional: values.optional,
        });
        print(await prepareMcp(worker, options, controller.signal));
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return;
  }
  if (command === 'integration') {
    if (!values.out || !values['token-file'])
      throw new Fault('arguments', 'integration requires --out and --token-file.');
    const config = {
      mcpServers: {
        'open-agent-api': {
          command: process.execPath,
          args: [
            fileURLToPath(import.meta.url),
            'mcp',
            '--url',
            values.url ?? 'http://127.0.0.1:8787',
            '--token-file',
            path.resolve(values['token-file']),
          ],
        },
      },
    };
    const output = path.resolve(values.out);
    await writePrivate(
      path.dirname(output),
      path.basename(output),
      JSON.stringify(config, null, 2) + '\n',
      true,
    );
    print({ file: output, installed_globally: false });
    return;
  }
  if (command === 'check') {
    if (!positionals[1]) throw new Fault('arguments', 'An .oaa source file path is required.');
    const source = await readFile(path.resolve(positionals[1]), 'utf8');
    const report = diagnoseOaaLang(source);
    print({
      valid: report.valid,
      agent: report.agent?.id ?? null,
      diagnostics: report.diagnostics,
      workflow_plans: report.workflowPlans ?? {},
    });
    if (!report.valid) process.exitCode = 1;
    return;
  }
  if (command === 'fmt') {
    if (!positionals[1]) throw new Fault('arguments', 'An .oaa source file path is required.');
    const source = await readFile(path.resolve(positionals[1]), 'utf8');
    const formatted = formatOaaLang(source);
    if (oaaSourceHasComments(source)) process.stderr.write(`${pick(CLI_TEXT.fmtDropsComments)}\n`);
    if (values.out) {
      const output = path.resolve(values.out);
      await writePrivate(path.dirname(output), path.basename(output), formatted, true);
      print({ file: output, formatted: true });
    } else {
      process.stdout.write(formatted);
    }
    return;
  }
  if (command === 'decompile') {
    if (!positionals[1]) throw new Fault('arguments', 'A definition JSON path is required.');
    const raw = JSON.parse(await readFile(path.resolve(positionals[1]), 'utf8'));
    const agentDef = agentSchema.parse(raw.agent ?? raw);
    const source = decompileToOaaLang(agentDef);
    if (values.out) {
      const output = path.resolve(values.out);
      await writePrivate(path.dirname(output), path.basename(output), source, true);
      print({ file: output, agent: agentDef.id });
    } else {
      process.stdout.write(source);
    }
    return;
  }
  if (command === 'build' || command === 'publish') {
    if (!positionals[1])
      throw new Fault('arguments', 'A definition .oaa or .json path is required.');
    const bundle = await buildBundle(
      positionals[1],
      values.skill ?? [],
      values['tool-binding'] ?? [],
    );
    if (command === 'build') {
      if (!values.out) throw new Fault('arguments', 'build requires --out.');
      const out = path.resolve(values.out);
      await writePrivate(
        path.dirname(out),
        path.basename(out),
        JSON.stringify(bundle, null, 2) + '\n',
        true,
      );
      print({
        file: out,
        agent: bundle.agent.id,
        version: bundle.digest,
        files: bundle.files.map((f) => f.path),
        tools: bundle.agent.tools.map((tool) => ({
          name: tool.name,
          capability: tool.capability.id,
          placement: tool.capability.placement,
          node_id: tool.capability.nodeId,
          effect: tool.capability.effect,
          approval_required: tool.capability.requiresApproval,
          result_export: tool.capability.resultExport,
        })),
      });
      return;
    }
    const client = await GatewayClient.fromOptions(values.url, values['token-file']);
    print(await client.request('POST', '/v1/agents/publish', bundle));
    return;
  }
  const client = await GatewayClient.fromOptions(values.url, values['token-file']);
  if (command === 'key' && positionals[1] === 'create') {
    print(
      await createCallerKey(client, {
        name: values.name,
        agents: values.agent,
        out: values.out,
        approve: values.approve,
      }),
    );
    return;
  }
  if (command === 'nodes') {
    print(await client.request('GET', '/v1/nodes/registrations'));
    return;
  }
  if (
    command === 'node' &&
    ['drain', 'resume', 'revoke', 'history'].includes(positionals[1] ?? '')
  ) {
    const action = positionals[1]!,
      nodeId = positionals[2];
    if (!nodeId) throw new Fault('arguments', `node ${action} requires a node ID.`);
    const base = `/v1/nodes/${encodeURIComponent(nodeId)}`;
    print(
      action === 'history'
        ? await client.request(
            'GET',
            `${base}/history?${new URLSearchParams({ after: values.cursor ?? '0', limit: values.limit ?? '50' })}`,
          )
        : await client.request('POST', `${base}/${action}`, { reason: values.reason ?? '' }),
    );
    return;
  }
  if (command === 'agents') {
    print(
      await client.request(
        'GET',
        `/v1/catalog/agents?${new URLSearchParams({
          offset: values.offset ?? '0',
          limit: values.limit ?? '20',
          ...(values.revision ? { revision: values.revision } : {}),
        })}`,
      ),
    );
    return;
  }
  if (command === 'agent') {
    const agent = positionals[1];
    if (!agent) throw new Fault('arguments', 'agent requires a published Agent ID.');
    const query = new URLSearchParams({
      agent,
      section: values.section ?? 'overview',
      offset: values.offset ?? '0',
      limit: values.limit ?? '20',
      ...(values['agent-version'] ? { agent_version: values['agent-version'] } : {}),
    });
    if (!values.out) {
      print(await client.request('GET', `/v1/catalog/agent?${query}`));
      return;
    }
    if (values.section || values.offset || values.limit)
      throw new Fault(
        'arguments',
        '--out downloads full public metadata; do not combine it with section or paging options.',
      );
    const version =
      values['agent-version'] ??
      String((await client.request('GET', `/v1/catalog/agent?${query}`)).agent_version);
    const bytes = await client.agentMetadata(agent, version, {}, 16 * 1024 * 1024);
    const target = path.resolve(values.out);
    const file = await open(target, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    print({ path: target, bytes: bytes.length, agent, agent_version: version });
    return;
  }
  if (command === 'catalog') {
    print(
      await client.request(
        'GET',
        `/v1/catalog/changes?${new URLSearchParams({
          limit: values.limit ?? '32',
          timeout_ms: values['timeout-ms'] ?? '20000',
          ...(values.cursor ? { cursor: values.cursor } : {}),
        })}`,
      ),
    );
    return;
  }
  if (command === 'publish-bundle') {
    if (!positionals[1] || values.skill?.length || values['tool-binding']?.length)
      throw new Fault(
        'arguments',
        'publish-bundle accepts one reviewed bundle without additional skill or tool-binding inputs.',
      );
    const selected = path.resolve(positionals[1]);
    const bundle = validateBundle(
      JSON.parse(
        (
          await readBounded(path.dirname(selected), path.basename(selected), 12 * 1024 * 1024)
        ).toString('utf8'),
      ),
    );
    print(await client.request('POST', '/v1/agents/publish', bundle));
    return;
  }
  if (['get', 'wait', 'output', 'artifacts', 'cancel', 'resume'].includes(command)) {
    const run = positionals[1];
    if (!run) throw new Fault('arguments', `${command} requires a response ID.`);
    const base = `/v1/runs/${encodeURIComponent(run)}`;
    if (command === 'get') print(await client.request('GET', `${base}/state`));
    if (command === 'wait')
      print(
        await client.request(
          'GET',
          `${base}/wait?${new URLSearchParams({ timeout_ms: values['timeout-ms'] ?? '20000' })}`,
        ),
      );
    if (command === 'output')
      print(
        await client.request(
          'GET',
          `${base}/output?${new URLSearchParams({ max_bytes: values['max-bytes'] ?? '8000', ...(values.cursor ? { cursor: values.cursor } : {}) })}`,
        ),
      );
    if (command === 'artifacts')
      print(
        await client.request(
          'GET',
          `${base}/artifacts?${new URLSearchParams({ offset: values.offset ?? '0', limit: values.limit ?? '10' })}`,
        ),
      );
    if (command === 'cancel')
      print(await client.request('POST', `/v1/responses/${encodeURIComponent(run)}/cancel`, {}));
    if (command === 'resume') print(await client.request('POST', `${base}/resume`, {}));
    return;
  }
  if (command === 'upload') {
    if (!positionals[1])
      throw new Fault('arguments', 'upload requires an explicitly selected local file.');
    const selected = path.resolve(positionals[1]);
    const data = await readBounded(path.dirname(selected), path.basename(selected));
    print(
      await client.request('POST', '/v1/files', {
        filename: path.basename(selected),
        content: data.toString('base64'),
        encoding: 'base64',
        allowed_nodes: values['allowed-node'],
      }),
    );
    return;
  }
  if (command === 'download') {
    if (!positionals[1] || !values.out)
      throw new Fault(
        'arguments',
        'download requires a file ID and --out NEW_FILE. Existing files are never overwritten.',
      );
    const data = await client.download(positionals[1]);
    const target = path.resolve(values.out);
    await writePrivate(path.dirname(target), path.basename(target), data, true);
    print({ file: target, bytes: data.length });
    return;
  }
  if (command === 'preview') {
    if (!positionals[1]) throw new Fault('arguments', 'preview requires an agent ID.');
    print(
      await client.request('POST', '/v1/agents/preview', {
        agent: positionals[1],
        model: values.model ?? 'auto',
        file_ids: values['file-id'] ?? [],
        agent_version: values['agent-version'],
        previous_response_id: values['previous-response-id'],
      }),
    );
    return;
  }
  if (command === 'me' || command === 'whoami') {
    print(await client.request('GET', '/v1/me'));
    return;
  }
  if (command === 'tunnel') {
    const explicitUrl = values['public-url'] ?? positionals[1];
    if (explicitUrl) {
      print(
        await client.request('POST', '/v1/gateway/public-url', {
          public_base_url: explicitUrl === 'none' || explicitUrl === 'null' ? null : explicitUrl,
        }),
      );
      return;
    }
    let cloudflared: string | undefined;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, 'cloudflared');
      try {
        await access(candidate, constants.X_OK);
        cloudflared = candidate;
        break;
      } catch {}
    }
    if (!cloudflared) {
      throw new Fault(
        'tunnel_binary_missing',
        'Pass --public-url https://your-domain.com or install cloudflared in PATH to open an automatic HTTPS tunnel.',
      );
    }
    const child = spawn(cloudflared, ['tunnel', '--url', client.url], {
      cwd: process.cwd(),
      detached: Boolean(values.detach),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const publicUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Fault('tunnel_timeout', 'Timed out waiting for cloudflared public URL.', 504));
      }, 20_000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Fault('tunnel_exited', `cloudflared exited early with code ${code ?? 1}.`, 502));
      });
    });
    const registered = await client.request('POST', '/v1/gateway/public-url', {
      public_base_url: publicUrl,
    });
    print({ ...registered, tunnel_pid: child.pid });
    if (values.detach) {
      child.unref();
      return;
    }
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        child.kill('SIGTERM');
        resolve();
      });
      process.once('SIGTERM', () => {
        child.kill('SIGTERM');
        resolve();
      });
      child.once('exit', () => resolve());
    });
    return;
  }
  if (command === 'expose') {
    const rawTarget = values.engine ?? positionals[1];
    const isFileTarget =
      typeof rawTarget === 'string' && (rawTarget.endsWith('.oaa') || rawTarget.endsWith('.json'));
    const prebuiltBundle = isFileTarget
      ? await buildBundle(rawTarget, values.skill ?? [], values['tool-binding'] ?? [])
      : undefined;
    const engine = prebuiltBundle
      ? zNative(
          prebuiltBundle.agent.engine === 'kernel' ? values.engine : prebuiltBundle.agent.engine,
        )
      : zNative(rawTarget);
    const binary = { codex: 'codex', claude: 'claude', antigravity: 'agy', dsh: 'dsh' }[engine];
    let executable: string | undefined;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, binary);
      try {
        await access(candidate, constants.X_OK);
        executable = candidate;
        break;
      } catch {}
    }
    if (!executable)
      throw new Fault(
        'native_not_installed',
        `Install ${binary} through its official distribution first. This command does not install it.`,
      );
    const resolvedAgentId = values.id ?? prebuiltBundle?.agent.id ?? `agent/${engine}`;
    const safeDirSlug = resolvedAgentId.replace(/[^A-Za-z0-9_-]/g, '_');
    const root = path.resolve(
      values.dir ?? `.oaa/exposed/${prebuiltBundle ? safeDirSlug : engine}`,
    );
    const workerFile = path.join(root, 'worker.json');
    const models = prebuiltBundle
      ? prebuiltBundle.agent.routes.length
        ? prebuiltBundle.agent.routes.map((r) => r.model)
        : [prebuiltBundle.agent.model]
      : (values.models ?? 'default')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    if (engine === 'dsh' && models.some((m) => m !== 'default'))
      throw new Fault(
        'dsh_overlay_required',
        'Expose DSH with default, then configure explicit model overlay arguments in its worker config before publishing additional routes.',
      );
    let workerConfig: import('./config/config.js').WorkerConfig;
    let configLoaded = false;
    try {
      workerConfig = await loadWorkerConfig(workerFile);
      configLoaded = true;
      const existing = JSON.parse(await readFile(path.join(root, 'exposure.json'), 'utf8')) as {
        agent: string;
        engine: string;
        gateway: string;
      };
      if (
        existing.agent !== resolvedAgentId ||
        existing.engine !== engine ||
        existing.gateway !== client.url
      )
        throw new Fault(
          'exposure_conflict',
          'This directory belongs to a different exposure. Choose another --dir.',
        );
    } catch (e) {
      if (configLoaded)
        throw new Fault(
          'exposure_conflict',
          'The exposure metadata is missing or inconsistent. Inspect this directory or choose another --dir.',
        );
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const info = await client.request<{ principal: { owner: string } }>('GET', '/v1/overview');
      const nodeId = `${engine}-${Math.random().toString(36).slice(2, 10)}`;
      const agentId = resolvedAgentId;
      const enrolled = await client.request<{ token: string }>('POST', '/v1/nodes/enroll', {
        node_id: nodeId,
        agents: [agentId],
        capabilities: [`native/${engine}`],
      });
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writePrivate(root, 'node.token', enrolled.token, true);
      const { workerSchema } = await import('./config/config.js');
      workerConfig = workerSchema.parse({
        nodeId,
        owner: info.principal.owner,
        dataDir: path.join(root, 'state'),
        gatewayUrl: client.url,
        tokenFile: path.join(root, 'node.token'),
        native: { [engine]: { executable, enabled: true, args: [] } },
      });
      await writePrivate(root, 'worker.json', JSON.stringify(workerConfig, null, 2) + '\n', true);
      await writePrivate(
        root,
        'exposure.json',
        JSON.stringify({ agent: agentId, engine, gateway: client.url }, null, 2) + '\n',
        true,
      );
    }
    const definition = prebuiltBundle
      ? agentSchema.parse({
          ...prebuiltBundle.agent,
          id: resolvedAgentId,
          engine,
          allowedNodes: [workerConfig.nodeId],
          ...approvalsFlag(values.approvals, prebuiltBundle.agent.approvals),
        })
      : agentSchema.parse({
          id: resolvedAgentId,
          description: `Native ${engine} on ${workerConfig.nodeId}`,
          engine,
          provider: 'native',
          model: models[0],
          instructions: '',
          tools: [],
          allowGraph: false,
          allowedNodes: [workerConfig.nodeId],
          routes: models.map((model, priority) => ({
            id: model,
            provider: 'native',
            model,
            priority,
          })),
          ...approvalsFlag(values.approvals),
        });
    await client.request(
      'POST',
      '/v1/agents/publish',
      makeBundle(definition, prebuiltBundle?.files ?? []),
    );
    const online = await client.request<{ data: { nodeId: string }[] }>('GET', '/v1/nodes');
    if (online.data.some((n) => n.nodeId === workerConfig.nodeId)) {
      print({
        agent: definition.id,
        node: workerConfig.nodeId,
        url: client.url,
        status: 'already_connected',
        native_model_called: false,
      });
      return;
    }
    if (values.detach) {
      const log = openSync(path.join(root, 'worker.log'), 'a', 0o600);
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), 'node', 'join', '--config', workerFile],
        { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log, log] },
      );
      closeSync(log);
      child.unref();
      await writePrivate(root, 'worker.pid', String(child.pid));
      let connected = false;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const nodes = await client.request<{ data: { nodeId: string }[] }>('GET', '/v1/nodes');
        if (nodes.data.some((n) => n.nodeId === workerConfig.nodeId)) {
          connected = true;
          break;
        }
      }
      if (!connected) {
        child.kill('SIGTERM');
        throw new Fault(
          'node_startup_failed',
          'The exposed worker did not register. Inspect its worker.log.',
          503,
        );
      }
      print({
        agent: definition.id,
        node: workerConfig.nodeId,
        url: client.url,
        worker_config: workerFile,
        pid: child.pid,
        native_model_called: false,
      });
      return;
    }
    print({
      agent: definition.id,
      node: workerConfig.nodeId,
      url: client.url,
      worker_config: workerFile,
      native_model_called: false,
    });
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    process.once('SIGTERM', () => stop.abort());
    await connectWorker(workerConfig, stop.signal);
    return;
  }
  if (command === 'publish-native') {
    if (
      values.engine &&
      !isNativeEngine(values.engine) &&
      adapterEnginePattern.test(values.engine)
    ) {
      // Owner adapters (including ACP agents) are validated by the gateway: they must be enabled.
      print(
        await client.request('POST', '/v1/agents/publish-native', {
          id: values.id ?? `agent/${values.engine.slice('adapter/'.length)}`,
          engine: values.engine,
          models: (values.models ?? 'default').split(',').filter(Boolean),
          ...approvalsFlag(values.approvals),
        }),
      );
      return;
    }
    const engine = zNative(values.engine);
    const models = (values.models ?? 'default').split(',').filter(Boolean);
    const agent = agentSchema.parse({
      id: values.id ?? `agent/${engine}`,
      engine,
      model: models[0],
      description: `Native ${engine} agent`,
      instructions: '',
      provider: 'native',
      routes: models.map((m, i) => ({ id: m, model: m, provider: 'native', priority: i })),
      tools: [],
      allowGraph: false,
      ...approvalsFlag(values.approvals),
    });
    print(await client.request('POST', '/v1/agents/publish', makeBundle(agent)));
    return;
  }
  if (command === 'invoke') {
    if (!positionals[1] || !values.input)
      throw new Fault('arguments', 'invoke requires an agent ID and --input.');
    print(
      await client.request(
        'POST',
        '/v1/invoke',
        {
          protocol: 'oaa/1',
          agent: positionals[1],
          model: values.model ?? 'auto',
          input: values.input,
          agent_version: values['agent-version'],
          previous_response_id: values['previous-response-id'],
          file_ids: values['file-id'] ?? [],
          background: true,
        },
        { idempotencyKey: values['idempotency-key'] },
      ),
    );
    return;
  }
  if (command === 'mcp') {
    await serveMcp(client);
    return;
  }
  throw new Fault('unknown_command', `Unknown command: ${command}`);
}
/** parseArgs 的参数错误（未知选项、缺值）归为 `arguments`，而不是笼统的 execution_failed。 */
function parseCliArgs<const T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs<T>(config);
  } catch (error) {
    throw new Fault('arguments', error instanceof Error ? error.message : 'Invalid arguments.');
  }
}
/** `--approvals ask|auto`：只有 auto 写进定义，缺省与 ask 不出现这个键（摘要不变）。 */
function approvalsFlag(value: string | undefined, fallback?: 'ask' | 'auto') {
  if (value !== undefined && value !== 'ask' && value !== 'auto')
    throw new Fault('arguments', '--approvals must be ask or auto.');
  return (value ?? fallback) === 'auto' ? { approvals: 'auto' as const } : { approvals: undefined };
}
function zNative(value: string | undefined): 'codex' | 'claude' | 'antigravity' | 'dsh' {
  if (!value || !['codex', 'claude', 'antigravity', 'dsh'].includes(value))
    throw new Fault(
      'invalid_engine',
      'Choose codex, claude, antigravity, or dsh (publish-native also accepts adapter/NAME).',
    );
  return value as 'codex' | 'claude' | 'antigravity' | 'dsh';
}
/** True when this file is the program being run. npm's global `oaa` is a symlink, so compare real paths. */
function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isEntryPoint())
  main().catch((error) => {
    const fault = faultOf(error);
    process.stderr.write(cliFailure(fault));
    process.exitCode = 1;
  });
