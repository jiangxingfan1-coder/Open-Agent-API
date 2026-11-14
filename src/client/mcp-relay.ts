/**
 * `oaa mcp-relay --socket <path> --token-file <path>`：调用方工具的 stdio MCP 中继
 * （docs/harness.md「外部智能体的桥接是怎么工作的」）。
 *
 * 由 ACP 智能体按 `session/new` 的 `mcpServers` 启动。启动后连上执行机器的本机 Unix 域套接字，
 * 出示令牌、取回工具清单；`tools/list` 返回调用方工具，`tools/call` 转给执行机器并等待结果，
 * 结果作为 MCP 文本内容返回（错误时 `isError: true`）。stdout 只承载 MCP 协议，日志写 stderr；
 * 套接字断开时以非零退出。不读写其它任何东西。
 *
 * 等待调用方结果期间，对带了 `_meta.progressToken` 的 `tools/call` 每隔一段时间（默认 15 秒，
 * `--progress-interval-ms` 或环境变量 `OAA_MCP_RELAY_PROGRESS_MS` 可改）发一次
 * `notifications/progress`，供「收到进度即重置超时」的 MCP 客户端保活。没有令牌时不发。
 */
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CALLER_RELAY_NAME, lineReader } from '../engines/caller-relay.js';
import { Fault } from '../core/util.js';
import { PRODUCT_VERSION } from '../core/version.js';

const log = (line: string) => process.stderr.write(`oaa mcp-relay: ${line}\n`);
export const RELAY_PROGRESS_INTERVAL_MS = 15_000;
const progressInterval = (value?: string) => {
  const n = Number(value ?? process.env.OAA_MCP_RELAY_PROGRESS_MS);
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : RELAY_PROGRESS_INTERVAL_MS;
};

/** 运行中继，直到套接字断开（返回 2）、令牌被拒（返回 3）或 stdin 关闭（返回 0）。 */
export async function runMcpRelay(
  socketPath?: string,
  tokenFile?: string,
  progressIntervalMs?: string,
): Promise<number> {
  const interval = progressInterval(progressIntervalMs);
  if (!socketPath || !tokenFile)
    throw new Fault('invalid_request', 'mcp-relay needs --socket and --token-file.');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const socket = net.connect(socketPath);
  let seq = 0;
  const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
  let onTools!: (tools: Tool[]) => void;
  const listed = new Promise<Tool[]>((resolve) => (onTools = resolve));
  let finished!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finished = resolve));
  let ready = false;

  socket.on('error', (error) => log(`socket error: ${error.message}`));
  socket.on('close', () => {
    log(ready ? 'socket closed' : 'connection refused by the worker');
    finished(ready ? 2 : 3);
  });
  socket.on(
    'data',
    lineReader(
      (message) => {
        if (message.type === 'tools' && Array.isArray(message.tools)) {
          ready = true;
          onTools(message.tools as Tool[]);
        } else if (message.type === 'result' && typeof message.id === 'number') {
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        }
      },
      () => socket.destroy(),
    ),
  );
  socket.once('connect', () => socket.write(JSON.stringify({ type: 'hello', token }) + '\n'));

  const tools = await Promise.race([listed, done.then(() => undefined)]);
  if (!tools) return await done;

  const server = new Server(
    { name: CALLER_RELAY_NAME, version: PRODUCT_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  // Calls that arrive together leave in one write, so the worker announces them together.
  let outgoing: string[] = [];
  const forward = (line: string) => {
    if (!outgoing.length)
      setTimeout(() => {
        const batch = outgoing.join('');
        outgoing = [];
        if (!socket.destroyed) socket.write(batch);
      }, 5);
    outgoing.push(line);
  };
  const timers = new Set<NodeJS.Timeout>();
  void done.then(() => {
    for (const t of timers) clearInterval(t);
    timers.clear();
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const callId = ++seq;
    const progressToken = request.params._meta?.progressToken ?? extra._meta?.progressToken;
    let timer: NodeJS.Timeout | undefined;
    if (progressToken !== undefined) {
      let progress = 0;
      timer = setInterval(() => {
        progress += 1;
        extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress,
              message: 'Waiting for the caller to return the tool result.',
            },
          })
          .catch(() => {});
      }, interval);
      timer.unref();
      timers.add(timer);
    }
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(callId, resolve);
      forward(
        JSON.stringify({
          type: 'call',
          id: callId,
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        }) + '\n',
      );
      void done.then(() => resolve({ error: 'The relay lost its connection to the worker.' }));
    }).finally(() => {
      if (timer) {
        clearInterval(timer);
        timers.delete(timer);
      }
    });
    return typeof answer.output === 'string'
      ? { content: [{ type: 'text' as const, text: answer.output }] }
      : { content: [{ type: 'text' as const, text: String(answer.error) }], isError: true };
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => finished(0);
  process.stdin.once('end', () => finished(0));
  await server.connect(transport);
  const code = await done;
  socket.destroy();
  return code;
}
