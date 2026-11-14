/**
 * 调用方工具中继的执行机器侧（docs/harness.md「外部智能体的桥接是怎么工作的」）。
 *
 * 为一次 ACP 回合建立一个本机 Unix 域套接字端点，交给 ACP 智能体一个 stdio MCP 服务条目
 * （`oaa mcp-relay`，服务名固定为 `oaa-caller`）。中继进程连上套接字、出示一次性令牌后取回工具
 * 清单；它转来的每个 `tools/call` 经 `emit({ type: 'client_tool' })` 交给内核，内核的回答原路
 * 返回。不监听任何网络端口；套接字与令牌文件在 0700 的私有目录里，权限 0600。
 *
 * 线上格式：换行分隔的 JSON，单条不超过 `AGENT_IO_LIMITS.frameBytes`。
 *   中继 → 执行机器：`{type:'hello', token}`、`{type:'call', id, name, arguments}`
 *   执行机器 → 中继：`{type:'tools', tools:[{name, description, inputSchema}]}`、
 *                    `{type:'result', id, output}` 或 `{type:'result', id, error}`
 *
 * 套接字在调用仍在等待时断开（智能体关掉了 MCP 服务，或它的请求超时后重启了服务），对每个
 * 仍在等待的调用再发一次 `emit({ type: 'client_tool', data: { abandoned: true, relay_call_id } })`，
 * 内核据此把该调用以 `client_tool_abandoned` 结束，不必挂到超时。回合结束时的 `close()` 不算放弃。
 */
import net from 'node:net';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientTool } from '../core/contracts.js';
import { id } from '../core/util.js';
import { AGENT_IO_LIMITS, record, type Emit } from './shared.js';

export const CALLER_RELAY_NAME = 'oaa-caller';
/** macOS 的 Unix 套接字路径上限约 104 字节；留出余量。 */
const MAX_SOCKET_PATH = 100;
/** 单次调用的参数、单次结果（序列化后）的字节上限。 */
export const CALLER_RELAY_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = AGENT_IO_LIMITS.frameBytes;

/** ACP `session/new` 的 `mcpServers` 条目（stdio 形式）。 */
export type AcpStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};
export type CallerRelay = { server: AcpStdioMcpServer; dir: string; close: () => Promise<void> };

/** 交给中继的工具清单：MCP 要求 inputSchema 是 object 类型的 schema。 */
export function relayTools(tools: ClientTool[]) {
  return tools.map((t) => {
    const schema = record(t.parameters);
    return {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: schema.type === undefined ? { type: 'object', ...schema } : schema,
    };
  });
}

/** 换行分隔 JSON 的读取器；超过单条上限时调用 `overflow`。 */
export function lineReader(onLine: (value: Record<string, unknown>) => void, overflow: () => void) {
  let buffered = '';
  return (chunk: Buffer | string) => {
    buffered += chunk.toString();
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        overflow();
        return;
      }
      onLine(record(parsed));
    }
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) overflow();
  };
}

const cliPath = () => fileURLToPath(new URL('../cli.js', import.meta.url));

/**
 * 在 `workspace`（该运行的私有工作目录）里建立中继端点；路径过长时改用系统临时目录下的短路径。
 * 回合结束时必须调用 `close()`：关闭套接字（中继进程随之退出）并删除套接字与令牌文件。
 */
export async function openCallerRelay(
  workspace: string,
  tools: ClientTool[],
  emit: Emit,
): Promise<CallerRelay> {
  let dir = path.join(workspace, `.oaa-relay-${randomBytes(4).toString('hex')}`);
  if (Buffer.byteLength(path.join(dir, 'relay.sock')) > MAX_SOCKET_PATH)
    dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-r-'));
  else await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  // Windows has no Unix-domain socket files here: use a named pipe with an unguessable name. The
  // per-run token (file in the 0700 directory) is what authenticates either way.
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\oaa-relay-${randomBytes(16).toString('hex')}`
      : path.join(dir, 'relay.sock');
  const tokenPath = path.join(dir, 'token');
  const token = randomBytes(32).toString('hex');
  await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
  const listed = relayTools(tools);
  const connections = new Set<net.Socket>();
  let claimed = false;
  let closed = false;

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let authenticated = false;
    // 这个连接上仍在等待结果的调用（relay_call_id）。
    const waiting = new Set<string>();
    socket.once('close', () => {
      if (closed) return;
      for (const relayCallId of waiting)
        void emit({
          type: 'client_tool',
          data: { abandoned: true, relay_call_id: relayCallId },
        }).catch(() => {});
      waiting.clear();
    });
    const send = (value: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
    };
    const reply = (callId: unknown, answer: Record<string, unknown> | void) => {
      const a = record(answer);
      let message: Record<string, unknown> =
        typeof a.output === 'string'
          ? { type: 'result', id: callId, output: a.output }
          : {
              type: 'result',
              id: callId,
              error: typeof a.error === 'string' ? a.error : 'The caller returned no result.',
            };
      if (Buffer.byteLength(JSON.stringify(message)) > CALLER_RELAY_PAYLOAD_BYTES)
        message = { type: 'result', id: callId, error: 'The caller tool result is too large.' };
      send(message);
    };
    socket.on(
      'data',
      lineReader(
        (message) => {
          if (closed) return;
          if (!authenticated) {
            const offered = Buffer.from(typeof message.token === 'string' ? message.token : '');
            const expected = Buffer.from(token);
            // 只接受持有令牌的第一个连接。
            if (
              message.type !== 'hello' ||
              claimed ||
              offered.length !== expected.length ||
              !timingSafeEqual(offered, expected)
            ) {
              socket.destroy();
              return;
            }
            claimed = authenticated = true;
            send({ type: 'tools', tools: listed });
            return;
          }
          if (message.type !== 'call') return;
          const callId = message.id;
          const args = message.arguments ?? {};
          if (Buffer.byteLength(JSON.stringify(args)) > CALLER_RELAY_PAYLOAD_BYTES) {
            reply(callId, { error: 'The tool arguments are too large.' });
            return;
          }
          const relayCallId = id('relay');
          waiting.add(relayCallId);
          emit({
            type: 'client_tool',
            data: { name: String(message.name ?? ''), arguments: args, relay_call_id: relayCallId },
          })
            .then(
              (answer) => reply(callId, answer),
              () => reply(callId, { error: 'The caller tool call ended without a result.' }),
            )
            .finally(() => waiting.delete(relayCallId));
        },
        () => socket.destroy(),
      ),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    server: {
      name: CALLER_RELAY_NAME,
      command: process.execPath,
      args: [cliPath(), 'mcp-relay', '--socket', socketPath, '--token-file', tokenPath],
      env: [],
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** rawInput 里可能写着工具或服务标识的字段。 */
const RAW_IDENTIFIERS = [
  'server',
  'serverName',
  'server_name',
  'mcpServer',
  'mcp_server',
  'tool',
  'toolName',
  'tool_name',
  'name',
];

/**
 * 桥接回合里，ACP `session/request_permission` 的 `toolCall` 是否针对中继提供的调用方工具；
 * 是则返回该工具名，否则 null（照旧走 owner 审批）。判断是保守的，必须同时满足：
 * (a) 标题或 rawInput 的工具标识里出现中继服务名 `oaa-caller`（大小写不敏感）；
 * (b) 标题按「非字母数字下划线连字符」分词后，有一个词等于某个调用方工具名，或以 `_<工具名>` 结尾
 *     （覆盖 `mcp_oaa-caller_<name>` 的写法）。不按 `kind` 判断；`toolNames` 为空（非桥接回合）时恒为 null。
 */
export function callerToolPermission(
  toolCall: unknown,
  toolNames: readonly string[],
): string | null {
  if (!toolNames.length) return null;
  const call = record(toolCall);
  if (typeof call.title !== 'string') return null;
  // A call the agent itself classifies as running a command or changing files is never a caller
  // tool, whatever its title says.
  if (typeof call.kind === 'string' && NATIVE_KINDS.has(call.kind)) return null;
  const title = call.title.slice(0, 1024);
  const raw = record(call.rawInput);
  const identifiers = [title, ...RAW_IDENTIFIERS.map((key) => raw[key])].filter(
    (value): value is string => typeof value === 'string',
  );
  const relay = CALLER_RELAY_NAME.toLowerCase();
  if (!identifiers.some((value) => value.toLowerCase().includes(relay))) return null;
  const words = title.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
  const named = (word: string, name: string) =>
    word === name || (word.endsWith(`_${name}`) && word.toLowerCase().includes(relay));
  return (
    toolNames.find(
      (name) =>
        words.some((word) => named(word, name)) &&
        // Every other word must be filler, so a shell command or file edit whose title merely
        // mentions the relay and a tool name (e.g. `echo oaa-caller x; cat ~/.ssh/id_rsa`) still
        // goes to owner approval.
        words.every((word) => named(word, name) || TITLE_FILLER.has(word.toLowerCase())),
    ) ?? null
  );
}
/** Words a relay tool-call title may contain besides the tool name. */
/** ACP tool kinds that act on the host; a caller tool is always reported as another kind. */
const NATIVE_KINDS = new Set(['execute', 'edit', 'delete', 'move']);
const TITLE_FILLER = new Set([
  'run',
  'call',
  'calling',
  'use',
  'using',
  'tool',
  'mcp',
  'server',
  CALLER_RELAY_NAME,
]);
