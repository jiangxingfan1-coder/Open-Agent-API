/**
 * 命令行 `oaa` 的帮助与提示文案，中英双语，跟随进程默认语言（core/locale.ts `processLocale`）。
 * 命令、参数与 JSON 输出的字段名不翻译；只翻译给人看的说明。
 */
import path from 'node:path';
import { errorEntry, faultMessage } from '../core/errors.js';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import type { Fault } from '../core/util.js';

type Group = { title: [string, string]; lines: string[] };

const GROUPS: Group[] = [
  {
    title: ['本机网关', 'Local gateway'],
    lines: [
      'oaa quickstart [--dir .oaa] [--port 8787]',
      'oaa connect codex|claude|agy|ACP_PRESET [--dir .oaa]',
      'oaa init [--dir .oaa]',
      'oaa serve [--config .oaa/config.json] [--detach]',
      'oaa stop [--config .oaa/config.json]',
      'oaa doctor [--config .oaa/config.json] [--write]',
    ],
  },
  {
    title: ['编写与发布智能体', 'Build and publish agents'],
    lines: [
      'oaa build definition.oaa|definition.json [--skill /selected/skill] --out bundle.json',
      'oaa build definition.oaa|definition.json --tool-binding prepared/binding.json --out bundle.json',
      'oaa check definition.oaa',
      'oaa fmt definition.oaa [--out formatted.oaa]',
      'oaa decompile definition.json [--out definition.oaa]',
      'oaa publish definition.oaa|definition.json [--skill /selected/skill] --url URL --token-file FILE',
      'oaa publish-bundle REVIEWED_BUNDLE.json --url URL --token-file FILE',
      'oaa publish-native --id agent/codex --engine codex|adapter/NAME --models default [--approvals ask|auto] --url URL --token-file FILE',
      'oaa expose codex|definition.oaa [--models default] [--approvals ask|auto] [--detach] --url URL --token-file FILE',
      'oaa tunnel [--public-url https://agents.example.com] [--detach] --url URL --token-file FILE',
    ],
  },
  {
    title: ['调用与查看结果', 'Call agents and read results'],
    lines: [
      'oaa key create --name NAME [--agent AGENT]... [--approve] [--out FILE] --url URL --token-file ADMIN_TOKEN',
      'oaa me --url URL --token-file FILE',
      'oaa preview AGENT [--model auto] [--agent-version DIGEST] [--file-id ID] --url URL --token-file FILE',
      'oaa invoke AGENT --input TASK [--model auto] [--agent-version DIGEST] [--file-id ID] --url URL --token-file FILE',
      'oaa get RESPONSE_ID',
      'oaa catalog [--cursor CURSOR] [--limit 32] [--timeout-ms 20000]',
      'oaa agents [--offset 0] [--limit 20] [--revision REVISION]',
      'oaa agent AGENT [--section overview|routes|tools|skills] [--agent-version DIGEST]',
      'oaa agent AGENT [--agent-version DIGEST] --out NEW_METADATA_FILE',
      'oaa wait RESPONSE_ID [--timeout-ms 20000]',
      'oaa output RESPONSE_ID [--cursor CURSOR] [--max-bytes 8000]',
      'oaa artifacts RESPONSE_ID [--offset 0] [--limit 10]',
      'oaa cancel RESPONSE_ID',
      'oaa resume RESPONSE_ID',
      'oaa upload SELECTED_FILE [--allowed-node NODE]',
      'oaa download FILE_ID --out NEW_FILE',
    ],
  },
  {
    title: ['执行节点', 'Worker nodes'],
    lines: [
      'oaa node join --config worker.json [--tool-config prepared/worker-tool.json]',
      'oaa nodes',
      'oaa node drain|resume|revoke NODE_ID [--reason REASON]',
      'oaa node history NODE_ID [--cursor EVENT_ID] [--limit 50]',
    ],
  },
  {
    title: ['MCP 与集成', 'MCP and integrations'],
    lines: [
      'oaa mcp inspect --config worker.json --server NAME [--tool NAME] [--cursor CURSOR]',
      'oaa mcp prepare --config worker.json --server NAME --tool NAME --capability private/name --out NEW_DIRECTORY',
      'oaa mcp --url URL --token-file FILE',
      'oaa integration --out /project/mcp.json --url URL --token-file FILE',
    ],
  },
];

/** `oaa` / `oaa --help` 的输出。 */
export function cliHelp(locale: Locale = processLocale()): string {
  const i = locale === 'zh' ? 0 : 1;
  const intro = [
    'Open Agent API',
    [
      '把智能体发布成可用 OpenAI / Claude / Gemini 官方 SDK 调用的 API。',
      'Publish agents as an API callable with the official OpenAI / Claude / Gemini SDKs.',
    ][i]!,
    [
      '最快上手：oaa quickstart（初始化、启动网关、发布离线示例智能体、生成密钥并完成第一次调用）；oaa doctor 检查本机环境。',
      'Fastest start: oaa quickstart (initializes, starts the gateway, publishes the offline sample agent, creates a key and makes the first call); oaa doctor checks this machine.',
    ][i]!,
    [
      '输出语言跟随系统区域；设置环境变量 OAA_LOCALE=zh 或 en 可以固定。',
      'Output language follows the system locale; set OAA_LOCALE=zh or en to pin it.',
    ][i]!,
  ];
  const groups = GROUPS.map((g) => `${g.title[i]}\n${g.lines.map((l) => `  ${l}`).join('\n')}`);
  return `${intro.join('\n')}\n\n${groups.join('\n\n')}\n`;
}

export const CLI_TEXT = {
  doctorWriteNeedsWorker: bi(
    'doctor --write 需要已初始化且包含 localWorker 的配置；请先运行 oaa init。',
    'doctor --write needs an initialized configuration with localWorker; run oaa init first.',
  ),
  doctorWriteNote: bi(
    '新增的 ACP 适配器均为停用；在控制台或 POST /v1/local/backends/adapter%2F<id> 显式启用后才会运行。',
    'Newly added ACP adapters are disabled; they run only after you enable them in the console or with POST /v1/local/backends/adapter%2F<id>.',
  ),
  fmtDropsComments: bi(
    '警告：源码里的注释不会保留在格式化结果中。',
    'Warning: comments in the source are not kept in the formatted output.',
  ),
};

/** `oaa init` 的输出：配置文件、管理员密钥文件的位置和下一步（不打印密钥本身）。 */
export function initSummary(configFile: string, dir: string, locale: Locale = processLocale()) {
  const admin = path.join(path.dirname(configFile), 'admin.token');
  const dirFlag = path.resolve(dir) === path.resolve('.oaa') ? '' : ` --dir ${dir}`;
  return {
    config: configFile,
    admin_token_file: admin,
    note: pick(
      bi(
        '管理员密钥只写在 admin_token_file 里（权限 0600），没有打印；它能管理整个网关，不要分享。',
        'The admin key is only in admin_token_file (mode 0600) and is not printed; it controls the whole gateway, so keep it private.',
      ),
      locale,
    ),
    next: pick(
      bi(
        `运行 oaa quickstart${dirFlag}：启动网关、发布离线示例智能体、生成调用方密钥并完成第一次调用。`,
        `Run oaa quickstart${dirFlag}: it starts the gateway, publishes the offline sample agent, creates a caller key and makes the first call.`,
      ),
      locale,
    ),
  };
}

/** 命令行失败时写到 stderr 的文字：`码: 说明`，目录里有下一步建议时另起一行。 */
export function cliFailure(fault: Fault, locale: Locale = processLocale()): string {
  const entry = errorEntry(fault.code);
  const next = locale === 'zh' ? entry?.next : entry?.nextEn;
  const hint = next ? `\n${pick(bi('下一步：', 'Next: '), locale)}${next}` : '';
  return `${fault.code}: ${faultMessage(fault, locale)}${hint}\n`;
}
