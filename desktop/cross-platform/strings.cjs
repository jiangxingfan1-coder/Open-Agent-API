'use strict';

const en = {
  // Application & Tray menu
  about: 'About Open Agent API',
  settings: 'Settings…',
  reloadConsole: 'Reload Console',
  restartGateway: 'Restart Gateway',
  stop: 'Stop gateway and quit',
  quit: 'Quit Open Agent API',
  hide: 'Hide Open Agent API',
  hideOthers: 'Hide Others',
  showAll: 'Show All',
  editMenu: 'Edit',
  viewMenu: 'View',
  windowMenu: 'Window',
  commandPalette: 'Command Palette',
  toggleSidebar: 'Toggle Sidebar',
  fullScreen: 'Toggle Full Screen',
  minimize: 'Minimize',
  zoom: 'Zoom',
  showConsole: 'Show Console',
  closeWindow: 'Close Window',
  openConsole: 'Open Console',
  openQuickPanel: 'Quick Approvals & Status',
  openInBrowser: 'Open in Default Browser',
  copyAdminKey: 'Copy Admin Key',
  copyBaseUrl: 'Copy Base URL',
  openDataFolder: 'Open Data Folder',
  launchAtLogin: 'Launch at Login',
  launchAtLoginIsolated: 'Launch at Login (disabled in isolated run)',

  // Tray & Quick Panel status
  statusTooltip: 'Open Agent API · Agent console',
  statusBadgeOne: 'Open Agent API · {count} request awaiting approval',
  statusBadgeMany: 'Open Agent API · {count} requests awaiting approval',
  gatewayOnline: 'Gateway online · {address}',
  gatewayOffline: 'Gateway offline',
  gatewayAttached: 'Attached to existing gateway · {address}',
  panelTitle: 'Quick Approvals',
  panelSubtitle: 'Local gateway status & owner decisions',
  metricRunning: 'Running tasks',
  metricPending: 'Awaiting approval',
  pendingHeading: 'Pending owner approvals',
  pendingEmptyTitle: 'All clear',
  pendingEmptyBody: 'No actions are waiting for owner approval right now.',
  approve: 'Approve',
  deny: 'Deny',
  approving: 'Approving…',
  denying: 'Denying…',
  viewInConsole: 'Inspect',
  decisionApproved: 'Approved action {id}',
  decisionDenied: 'Denied action {id}',
  decisionFailed: 'Action failed: {error}',
  actionKindNative: 'Native permission',
  actionKindTool: 'Tool approval',
  expiresIn: 'Expires in {minutes}m',
  expired: 'Expired',
  refresh: 'Refresh',

  // Notifications & Dialog buttons
  buttonOK: 'OK',
  buttonConfirm: 'Confirm',
  buttonCancel: 'Cancel',
  notifyTitleOne: 'Approval requested',
  notifyTitleMany: '{count} requests awaiting approval',
  notifyBodyOne: '{agent} is waiting for owner approval.',
  notifyBodyMany: '{agents} are waiting for owner approval.',
  notificationTestBody:
    'Approval notifications are on: this is how you will be alerted when a request is waiting for your approval.',
  foreign:
    'This gateway was already running from another process. Restart it from its owning application.',
  aboutBody:
    'Agent console · publish once, call anywhere.\n\nListening on: {url}\nData folder: {dir}',

  // Splash & Window
  splashTagline: 'Publish once · call anywhere',
  splashStarting: 'Starting the gateway…',
  splashStartingAt: 'Starting the gateway · {address}',
  splashRestarting: 'Restarting the gateway…',
  splashFailed: 'The gateway did not start (port {port}). See the log: {log}',
  windowTitleIsolated: '{title} (isolated run)',

  // Startup & Launch problems
  problemPortOtherTitle: 'Port {port} is already in use',
  problemPortOtherBody:
    'Another program (possibly another Open Agent API instance) is using 127.0.0.1:{port}, and Open Agent API did not connect to it.\n\nQuit that program, or change "port" in the configuration file to another number, then choose "Restart Gateway" from the menu.\nConfiguration file: {config}\n(For an isolated run, change the OAA_DESKTOP_PORT environment variable instead.)',
  problemPortGatewayTitle: 'Another Open Agent API gateway is already on port {port}',
  problemPortGatewayBody:
    'The gateway on 127.0.0.1:{port} was not started from this data folder. It may be another Open Agent API instance (for example one started from the command line, or another copy of the app). To avoid connecting to someone else\'s data, the app did not use it.\n\nQuit that instance first, or change "port" in the configuration file to another number, then choose "Restart Gateway" from the menu.\nConfiguration file: {config}\n(For an isolated run, change the OAA_DESKTOP_PORT environment variable instead.)',
  problemConfigPortTitle: 'The configured port is not valid',
  problemConfigPortBody:
    '"port" in the configuration file ({value}) is not an integer between 1 and 65535. Set it to a free port, then choose "Restart Gateway" from the menu.\nConfiguration file: {config}',
  problemConfigTitle: 'Could not read the gateway configuration',
  problemConfigBody:
    'Could not read or create config.json in {dir} (the folder is not writable, or the file is not valid JSON). Check the folder and the file.',
  problemNotStartedTitle: 'The gateway did not start',
  problemHomeTitle: 'Invalid data folder for the isolated run',
  problemHomeBody:
    'OAA_DESKTOP_HOME (or --home / --oaa-data-dir) must be an absolute path, which may start with ~. The value is: {value}',
  problemEnvPortTitle: 'Invalid port for the isolated run',
  problemEnvPortBody:
    'OAA_DESKTOP_PORT (or --port) must be an integer between 1 and 65535. The value is: {value}',
  problemNeedsHomeTitle: 'No data folder for the isolated run',
  problemNeedsHomeBody:
    'OAA_DESKTOP_PORT (or --port) only works together with OAA_DESKTOP_HOME (or --home / --oaa-data-dir): the port is written into the config.json of the isolated data folder and never into the default data folder.',

  // First-run notice
  firstRunTitle: 'First launch: set up for you',
  firstRunSample:
    '• Published the offline sample agent {agent}: it calls no model and uses no network, so you can try it right away.',
  firstRunAntigravity:
    '• Published the example agent {agent}: it runs on the Antigravity installed on this machine.',
  firstRunEngines: '• Enabled the agent engines found on this machine: {engines}.',
  firstRunNoEngines:
    '• No local agent engine such as Codex or Claude Code was found, so none was enabled.',
  firstRunFooter:
    'Enabling only makes an engine available: it runs only after you publish an agent that uses it and call that agent with a key.\nTo turn an engine off, open the "Execution machines" page of the console and switch it off.',
  firstRunOpenMachines: 'Show Execution Machines',
  listSeparator: ', ',
};

const zh = {
  // Application & Tray menu
  about: '关于 Open Agent API',
  settings: '设置…',
  reloadConsole: '重新载入控制台',
  restartGateway: '重启后台服务',
  stop: '停止网关并退出',
  quit: '退出 Open Agent API',
  hide: '隐藏 Open Agent API',
  hideOthers: '隐藏其他',
  showAll: '全部显示',
  editMenu: '编辑',
  viewMenu: '显示',
  windowMenu: '窗口',
  commandPalette: '命令面板',
  toggleSidebar: '切换侧栏',
  fullScreen: '切换全屏幕',
  minimize: '最小化',
  zoom: '缩放',
  showConsole: '显示控制台',
  closeWindow: '关闭窗口',
  openConsole: '打开控制台',
  openQuickPanel: '快捷审批与状态面板',
  openInBrowser: '在默认浏览器中打开',
  copyAdminKey: '复制管理员密钥',
  copyBaseUrl: '拷贝服务地址（Base URL）',
  openDataFolder: '打开数据目录',
  launchAtLogin: '开机自动启动',
  launchAtLoginIsolated: '开机自动启动（隔离运行模式下禁用）',

  // Tray & Quick Panel status
  statusTooltip: 'Open Agent API · 智能体控制台',
  statusBadgeOne: 'Open Agent API · {count} 个请求等待审批',
  statusBadgeMany: 'Open Agent API · {count} 个请求等待审批',
  gatewayOnline: '网关在线 · {address}',
  gatewayOffline: '网关离线',
  gatewayAttached: '已接管现有网关 · {address}',
  panelTitle: '快捷审批面板',
  panelSubtitle: '本地网关状态与人工确认',
  metricRunning: '运行中任务',
  metricPending: '待人工审批',
  pendingHeading: '待确认操作',
  pendingEmptyTitle: '一切就绪',
  pendingEmptyBody: '当前没有等待人工确认的审批操作。',
  approve: '批准',
  deny: '拒绝',
  approving: '正在批准…',
  denying: '正在拒绝…',
  viewInConsole: '查看详情',
  decisionApproved: '已批准操作 {id}',
  decisionDenied: '已拒绝操作 {id}',
  decisionFailed: '操作失败：{error}',
  actionKindNative: '原生权限审批',
  actionKindTool: '工具执行审批',
  expiresIn: '{minutes} 分钟后过期',
  expired: '已过期',
  refresh: '刷新',

  // Notifications & Dialog buttons
  buttonOK: '好',
  buttonConfirm: '确认',
  buttonCancel: '取消',
  notifyTitleOne: '有请求等待你审批',
  notifyTitleMany: '{count} 个请求等待审批',
  notifyBodyOne: '智能体 {agent} 正在等待人工审批。',
  notifyBodyMany: '智能体 {agents} 正在等待人工审批。',
  notificationTestBody: '审批通知已开启：有请求等待你审批时，会这样提醒你。',
  foreign: '网关已由其他程序启动，请从拥有它的程序中重启。',
  aboutBody: '智能体控制台 · 一次发布，随处调用。\n\n监听地址：{url}\n数据目录：{dir}',

  // Splash & Window
  splashTagline: '一次发布 · 随处调用',
  splashStarting: '正在启动后台服务…',
  splashStartingAt: '正在启动后台服务 · {address}',
  splashRestarting: '正在重启后台服务…',
  splashFailed: '后台服务没能启动（端口 {port}）。请查看日志：{log}',
  windowTitleIsolated: '{title}（隔离运行）',

  // Startup & Launch problems
  problemPortOtherTitle: '端口 {port} 已被占用',
  problemPortOtherBody:
    '有别的程序（也可能是另一个 Open Agent API 实例）在使用 127.0.0.1:{port}，Open Agent API 没有连接它。\n\n请退出占用该端口的程序，或把配置文件里的 "port" 改成别的数字，然后在菜单里选「重启后台服务」。\n配置文件：{config}\n（隔离运行时请改用环境变量 OAA_DESKTOP_PORT。）',
  problemPortGatewayTitle: '端口 {port} 上已有另一个 Open Agent API 网关',
  problemPortGatewayBody:
    '127.0.0.1:{port} 上的网关不是由这份数据目录启动的，可能是另一个 Open Agent API 实例（例如用命令行启动的，或另一份应用）。为了不连到别人的数据，本应用没有使用它。\n\n请先退出那个实例，或把配置文件里的 "port" 改成别的数字，然后在菜单里选「重启后台服务」。\n配置文件：{config}\n（隔离运行时请改用环境变量 OAA_DESKTOP_PORT。）',
  problemConfigPortTitle: '配置里的端口无效',
  problemConfigPortBody:
    '配置文件里的 "port"（{value}）不是 1-65535 之间的整数。请改成一个空闲的端口，再在菜单里选「重启后台服务」。\n配置文件：{config}',
  problemConfigTitle: '没能读取网关配置',
  problemConfigBody:
    '没能读取或创建 {dir} 里的 config.json（文件夹不可写，或文件不是有效的 JSON）。请检查这个文件夹和文件。',
  problemNotStartedTitle: '后台服务没能启动',
  problemHomeTitle: '隔离运行的数据目录无效',
  problemHomeBody:
    'OAA_DESKTOP_HOME（或 --home / --oaa-data-dir）必须是绝对路径，可以用 ~ 开头。现在的值是：{value}',
  problemEnvPortTitle: '隔离运行的端口无效',
  problemEnvPortBody: 'OAA_DESKTOP_PORT（或 --port）必须是 1-65535 之间的整数。现在的值是：{value}',
  problemNeedsHomeTitle: '缺少隔离运行的数据目录',
  problemNeedsHomeBody:
    'OAA_DESKTOP_PORT（或 --port）只能和 OAA_DESKTOP_HOME（或 --home / --oaa-data-dir）一起使用：端口会写进隔离数据目录的 config.json，不会改动默认数据目录。',

  // First-run notice
  firstRunTitle: '首次启动：已为你做好这些准备',
  firstRunSample: '• 发布了离线示例智能体 {agent}：它不调用任何模型，也不联网，可以直接试用。',
  firstRunAntigravity: '• 发布了示例智能体 {agent}：由本机的 Antigravity 执行。',
  firstRunEngines: '• 启用了本机检测到的智能体引擎：{engines}。',
  firstRunNoEngines: '• 没有在本机检测到 Codex、Claude Code 等智能体引擎，所以没有启用任何引擎。',
  firstRunFooter:
    '启用只是让引擎「可用」：只有你发布了使用它的智能体、并且用密钥调用时，它才会运行。\n想停用某个引擎，请打开控制台的「执行机器」页，关掉对应的开关。',
  firstRunOpenMachines: '查看「执行机器」页',
  listSeparator: '、',
};

function resolveLocale(preferred) {
  if (Array.isArray(preferred)) {
    if (preferred.length === 0) return 'zh';
    return String(preferred[0] ?? '')
      .toLowerCase()
      .startsWith('zh')
      ? 'zh'
      : 'en';
  }
  if (typeof preferred === 'string' && preferred.trim()) {
    return preferred.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  return 'zh';
}

function formatText(lang, key, params = {}) {
  const bucket = lang === 'zh' ? zh : en;
  const template = bucket[key] ?? en[key] ?? String(key);
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

function placeholders(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/\{(\w+)\}/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

module.exports = {
  en,
  zh,
  resolveLocale,
  formatText,
  placeholders,
};
