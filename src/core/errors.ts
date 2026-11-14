/**
 * 错误目录：网关、执行节点与客户端会产生的全部稳定错误码（`error.code`）。
 *
 * - 含义以 docs/protocol.md「Error codes (`error.code`)」一章为准（中文版在 docs/zh-CN/protocol.md）；新增错误码时先在这里登记，再补两份文档的表格。
 * - `status` 是该码最常用的 HTTP 状态；同一个码在不同场景用不同状态时，`statuses` 列出全部。
 *   `null` 表示它不作为 HTTP 响应出现（只是运行的错误码，或只在 worker / 客户端本地产生）。
 * - `retryable`：调用方原样重试有可能成功（限流、超时、容量、节点暂时不可用、网关关闭中）。
 * - `zh` 写给使用者看，一句话说明发生了什么；`next` 是可执行的下一步建议。
 *   英文对应的 `en` / `nextEn` 在 errors-en.ts（每码一行），加载时并入条目。
 *
 * - 三个调度标记（只在为 true 时出现在条目上）由文件末尾三个「每码一行」的集合登记，映射时并入条目；
 *   集合里的码必须已在 ROWS 里登记，否则模块加载即报错，避免拼错的码悄悄失效：
 *   - `routeRetryable`：第一轮模型调用失败时可以换一条线路重试（kernel `runModelTurn`）。
 *   - `fallbackExempt`：不触发换用备选智能体（kernel `fallBackToNextAgent`）。
 *   - `uncertainWhenStarted`：外部执行已经开始后出现这个错误时，结果按未知处理（fabric/network）。
 *   - `callerLimit`：只作运行错误码（status null）且原因是这次调用自身的上限 / 额度（轮次、token 预算、
 *     输出截断）；兼容入口的错误体按 422 一类归类。其余 status null 的 run 码是服务一侧的原因，按 500 一类。
 *
 * `Fault` 的构造方式不变：抛出时仍然自己写 `status`，test/error-catalog.test.ts 负责核对两边一致。
 * 只终结运行、不决定 HTTP 状态的码用 `RunErrorFault(code, message)` 抛出（不写状态），目录里 `status` 为 `null`。
 */
import { ERROR_EN } from './errors-en.js';
import type { Locale } from './locale.js';
import { sha, type Fault } from './util.js';

export const ERROR_CATEGORIES = {
  request: '请求、鉴权与限额',
  agent: '智能体、模型与目录',
  publish: '发布与能力包',
  run: '运行生命周期',
  approval: '审批与步骤',
  file: '文件与记忆',
  tool: '工具、图与 MCP',
  provider: '模型提供方',
  engine: '原生智能体与适配器（含 ACP）',
  node: '本机后端与节点',
  client: '仅 CLI / 客户端本地',
  platform: '开发者平台',
} as const;
export type ErrorCategory = keyof typeof ERROR_CATEGORIES;

export interface ErrorEntry {
  readonly code: string;
  readonly status: number | null;
  readonly statuses?: readonly number[];
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly zh: string;
  readonly next?: string;
  readonly en: string;
  readonly nextEn?: string;
  readonly routeRetryable?: true;
  readonly fallbackExempt?: true;
  readonly uncertainWhenStarted?: true;
  readonly callerLimit?: true;
}

const R = true; // retryable
const _ = false;
type Row = [string, number | null | number[], ErrorCategory, boolean, string, string?];

/** 每行：[code, status 或 statuses, category, retryable, zh, next?]，按 docs/protocol.md 的小节排列。 */
// prettier-ignore
const ROWS: Row[] = [
  // request
  ['unauthorized', 401, 'request', _, '缺少或无效/已吊销的 API 密钥', '检查 Authorization 头里的 API 密钥'],
  ['key_expired', 401, 'request', _, 'API 密钥已过期', '向 owner 申请新的 API 密钥'],
  ['scope_denied', 403, 'request', _, '密钥缺少所需 scope，或无权访问该智能体/资源'],
  ['quota_exceeds_own', 403, 'request', _, '新密钥的额度不能高于你自己密钥的额度', '为新密钥设置不高于自己的各项额度'],
  ['invalid_host', 403, 'request', _, 'Host 不在允许列表中'],
  ['origin_denied', 403, 'request', _, '跨源请求的 Origin 未被允许'],
  ['admin_host_denied', 403, 'request', _, '配置了控制台域名后，在非控制台域名上使用了 admin 密钥'],
  ['isolation_required', 403, 'request', _, '智能体或其委派对象所需权限超出该密钥允许的执行等级'],
  ['sandbox_unavailable', 503, 'request', _, '需要 OS 沙箱的脚本没有可用节点，或 worker 沙箱未通过自检'],
  ['authorization_changed', 403, 'request', _, '长连接期间密钥授权发生变化，需用当前授权重连'],
  ['rate_limited', 429, 'request', R, '超出该密钥每分钟请求数（默认 600）', '稍后重试，或请 owner 调高该密钥的每分钟请求数'],
  ['concurrency_limit', 429, 'request', R, 'owner 的活跃请求过多', '等待已有请求完成后重试'],
  ['subject_concurrency_limit', 429, 'request', R, '同一调用方的未完成请求数已达上限', '等待已有请求完成后重试'],
  ['key_concurrency_limit', 429, 'request', R, '达到该密钥的并发运行上限', '等待已有运行完成后重试'],
  ['run_quota_exceeded', 429, 'request', _, '该密钥的运行次数配额已用完', '请 owner 调高或重置该密钥的配额'],
  ['token_quota_exceeded', 429, 'request', _, '该密钥的 token 配额已用完', '请 owner 调高或重置该密钥的配额'],
  ['storage_quota_exceeded', 413, 'request', _, '该调用方存储的文件已达上限', '请 owner 调高 maxStoredBytesPerSubject'],
  ['too_many_streams', 429, 'request', R, '该密钥（或 owner）同时打开的事件流已达上限', '关闭不用的事件流后重连'],
  ['invalid_request', [400, 404], 'request', _, '请求字段无效或缺失（Gemini 路径格式错误时为 404）'],
  ['client_tools_unsupported', 400, 'request', _, '请求带了调用方工具，但选择了拒绝模式（reject）', '去掉 tools，或改用 X-OAA-Client-Tools: managed'],
  ['client_tools_bridge_unsupported', 400, 'request', _, '请求了桥接模式（bridge），但这个智能体不支持，或没有执行机器声明支持桥接', '改用 X-OAA-Client-Tools: managed，让智能体用自己的工具完成；ACP 智能体可升级执行机器'],
  ['client_tool_conflict', 400, 'request', _, '调用方工具与已发布的工具、工作流、委托或另一个调用方工具重名', '给调用方工具换个名字'],
  ['client_tools_too_many', 400, 'request', _, '已发布工具加调用方工具超过 100 个', '减少本次请求声明的工具'],
  ['output_schema_unsupported', 400, 'request', _, '请求的输出 schema 里有网关无法如实校验的内容（异步、文档外引用、未实现的 format、危险的正则、嵌套过深）', '改写 schema：只引用文档内部、用标准 format、正则写简单些'],
  ['invalid_client_tool', 400, 'request', _, '调用方工具的名字或参数 schema 不合法', '名字用字母、数字、_ 或 -（至多 64 个），参数用合法的 JSON Schema'],
  ['invalid_json', 400, 'request', _, '请求体不是合法 JSON，或声明了 JSON 却为空'],
  ['payload_too_large', 413, 'request', _, '请求体或数据超过大小上限'],
  ['unsupported_media_type', 415, 'request', _, '不支持的 Content-Type'],
  ['unsupported_parameter', 400, 'request', _, '严格端点不支持这个参数', '改用 /v1/compat/* 端点，或去掉这个参数'],
  ['unsupported_content', 400, 'request', _, '内容块类型不被支持（例如音频），或这个智能体不接受图片', '看 error.param 指的内容段；不接受图片的智能体请去掉图片或换一个接受图片的智能体（GET /v1/models 的 image_input）'],
  ['image_invalid', [400, 500], 'request', _, '图片无法使用：不是合法的 base64、不是 PNG / JPEG / GIF / WebP，或声明的类型与实际内容不符', '发送 PNG、JPEG、GIF 或 WebP，media_type 与实际格式一致；图片 URL 必须是 https'],
  ['image_too_large', 413, 'request', _, '单张图片或这次请求的图片总量超过上限', '压缩或缩小图片；owner 可调 images.maxImageBytes / images.maxTotalBytes'],
  ['too_many_images', 400, 'request', _, '这次请求的图片张数超过上限', '分几次发送；owner 可调 images.maxImagesPerRequest'],
  ['image_fetch_failed', 400, 'request', _, '网关代取图片 URL 失败（重定向、非图片、超时、私网地址等）', '改用内联 base64，或先 POST /v1/files 上传再按文件 ID 引用'],
  ['protocol_undetected', 400, 'request', _, '通用入口无法判定请求属于哪种协议', '改用专用端点，或用 X-OAA-Protocol 头指明'],
  ['invalid_url', 400, 'request', _, 'URL 无法解析'],
  ['invalid_multipart', [400, 406], 'request', _, 'multipart 请求体畸形或不是 multipart'],
  ['route_not_found', 404, 'request', _, '没有匹配该方法与路径的路由'],
  ['not_found', 404, 'request', _, '静态资源不存在'],
  ['invalid_cursor', 400, 'request', _, '事件或输出游标无效'],
  ['invalid_idempotency_key', 400, 'request', _, 'Idempotency-Key 格式无效'],
  ['idempotency_conflict', 409, 'request', _, '同一 Idempotency-Key 用于了不同输入'],
  ['wait_timeout', 408, 'request', R, '等待截止时间已到（任务可能仍在运行）', '用运行 ID 继续查询或等待结果'],
  ['wait_cancelled', 499, 'request', _, '等待被取消'],
  ['shutting_down', 503, 'request', R, '网关正在关闭', '等网关重启后重试'],
  ['gateway_already_running', 409, 'request', _, '另一个网关进程占用了同一数据目录（启动时）'],
  ['schema_too_new', 409, 'request', _, '数据目录来自更新版本的网关（启动时）'],
  // agent
  ['agent_not_found', 404, 'agent', _, '智能体或指定版本不存在'],
  ['agent_version_required', 400, 'agent', _, '后续详情分页需要带上返回的 agent_version'],
  ['ambiguous_model', 400, 'agent', _, '多条路由使用同一模型名，请指定路由 ID'],
  ['model_not_supported', 400, 'agent', _, '所选模型不受该智能体/后端支持（未发送任务）'],
  ['model_switch_requires_new_session', 409, 'agent', _, '续接会话保持原模型路由，切换模型需新会话'],
  ['model_unavailable', 503, 'agent', R, '智能体当前没有可用的执行者（引擎未装或未启用、缺环境变量，或线路不可用）', '按错误说明里点名的引擎或环境变量处理，运行 oaa doctor 检查本机；会话固定的线路不可用时新建会话'],
  ['version_conflict', 409, 'agent', _, '续接会话必须保持原智能体版本'],
  ['catalog_capacity', 429, 'agent', R, '目录视图或订阅过多', '关闭不用的目录视图或订阅后重试'],
  ['catalog_changed', 409, 'agent', _, '授权的发布列表已变化，需从 offset 0 重新开始', '从 offset 0 重新分页'],
  ['catalog_closed', 409, 'agent', _, '目录订阅已关闭'],
  ['invalid_catalog_cursor', 400, 'agent', _, '目录游标无效'],
  ['invalid_catalog_limit', 400, 'agent', _, '目录分页大小须为 1-32'],
  ['metadata_item_too_large', 413, 'agent', _, '单项元数据过大，请使用版本固定的元数据资源'],
  ['resource_too_large', 413, 'agent', _, 'MCP 资源超过 4 MiB 上限'],
  ['invalid_agent_uri', 400, 'agent', _, 'MCP 智能体资源 URI 无效'],
  ['invalid_file_id', 400, 'agent', _, 'MCP 文件 URI 无效'],
  // publish
  ['invalid_engine', 400, 'publish', _, '引擎名无效（原生名或 adapter/<名称>）'],
  ['backend_not_enabled', 409, 'publish', _, '适配器未在任何在线节点上启用，不能发布'],
  ['bundle_integrity', 400, 'publish', _, '能力包内容摘要不匹配'],
  ['bundle_owner_conflict', 409, 'publish', _, '该能力包摘要属于其他 owner'],
  ['bundle_too_large', [400, 413], 'publish', _, '能力包超过大小上限'],
  ['invalid_manifest', 400, 'publish', _, '能力包清单无效'],
  ['invalid_skill', 400, 'publish', _, 'SKILL.md 缺少 YAML frontmatter 等'],
  ['missing_script', 400, 'publish', _, '引用的脚本不在能力包中'],
  ['missing_skill', 400, 'publish', _, '引用的技能不在能力包中'],
  ['metadata_too_deep', 400, 'publish', _, '能力元数据嵌套过深'],
  ['secret_in_bundle', 400, 'publish', _, '公开元数据中疑似含有凭据，拒绝发布'],
  ['unsafe_bundle', 400, 'publish', _, '能力包路径被禁止或重复'],
  ['oaa_syntax_error', 400, 'publish', _, 'OAA-Lang 源码语法错误或超过编译上限'],
  ['oaa_roundtrip_error', 400, 'publish', _, '格式化后的编译契约与原源码不一致，拒绝输出可能改变执行行为的源码'],
  ['oaa_validation_error', 400, 'publish', _, 'OAA-Lang 语法正确，但声明的值不符合智能体契约', '按报错给出的行列号修改对应的声明'],
  ['invalid_schema', 400, 'publish', _, 'JSON Schema 无效或引用了不可用的外部 schema'],
  ['schema_dialect_unsupported', 400, 'publish', _, '不支持异步 JSON Schema'],
  // run
  ['run_not_found', 404, 'run', _, '运行（response）不存在'],
  ['session_busy', 409, 'run', R, '该会话已有进行中的任务', '等当前任务结束后再续接'],
  ['invalid_continuation', 409, 'run', _, '续接需要同一智能体的已完成响应'],
  ['invalid_run_transition', 500, 'run', _, '运行状态转移不合法，写入被拒绝（内部错误）'],
  ['not_resumable', 409, 'run', _, '只有 interrupted 状态的运行可以恢复', '只对 interrupted 状态的运行调用恢复'],
  ['reconciliation_required', 409, 'run', _, '恢复前需先核对不确定的副作用', '先核对不确定的步骤，再恢复运行'],
  ['run_not_attached', 409, 'run', _, '运行不在本网关进程中执行，无法在此取消', '稍后读取运行状态；仍无变化时联系 owner'],
  ['run_key_inactive', 409, 'run', _, '运行所属的密钥已过期、被吊销或已删除，不能恢复', '用仍然有效的密钥重新提交'],
  ['invalid_reconciliation', 409, 'run', _, '没有匹配的待核对步骤'],
  ['effect_outcome_unknown', 409, 'run', _, '有副作用的操作结果未确认（运行记为 interrupted）'],
  ['gateway_restarted', null, 'run', _, '网关重启导致执行中断（运行错误码）'],
  ['run_timeout', null, 'run', _, '运行超过截止时间（运行错误码，状态 incomplete）'],
  ['cancelled', 409, 'run', _, '任务已取消'],
  ['turn_limit', null, 'run', _, '达到智能体轮次上限（运行错误码，状态 incomplete）'],
  ['token_budget', null, 'run', _, '达到观测到的 token 预算（运行错误码，状态 incomplete）'],
  ['max_output_tokens', null, 'run', _, '模型输出被截断（运行错误码，状态 incomplete）'],
  ['context_limit', 409, 'run', _, '上下文超过 2 MB（2,000,000 字节），请新建会话', '新建会话'],
  ['output_contract', 422, 'run', _, '最终答案不符合声明的输出 schema'],
  ['structured_output_invalid', 422, 'run', _, '请求要求了结构化输出，但智能体的答案（含修复轮）仍不是合乎要求的 JSON', '放宽 schema、在提示里说明结构，或调高 structuredOutput.maxRepairs'],
  ['output_too_large', [413, 502], 'run', _, '智能体输出超过上限'],
  ['files_too_large', 413, 'run', _, '输入文件总量超过 8 MiB'],
  ['workspace_too_large', 413, 'run', _, '工作区传输超过上限'],
  ['delegation_depth_exceeded', 409, 'run', _, '子智能体委派深度超过上限'],
  ['subagent_failed', 502, 'run', _, '子智能体以 failed 结束且没有给出具体错误码'],
  ['subagent_cancelled', 502, 'run', _, '子智能体以 cancelled 结束且没有给出具体错误码'],
  ['subagent_interrupted', 502, 'run', _, '子智能体以 interrupted 结束且没有给出具体错误码'],
  ['subagent_incomplete', 502, 'run', _, '子智能体以 incomplete 结束且没有给出具体错误码'],
  ['delegate_timeout', 504, 'run', _, '委托的子智能体在委托超时内没有结束（子运行已被取消）'],
  ['parent_interrupted', null, 'run', _, '父运行已不活跃，排队中的子运行不再执行（运行错误码，状态 cancelled）'],
  ['capability_unavailable', 503, 'run', R, '所需执行能力当前不可用', '稍后重试，或检查节点是否在线'],
  ['node_draining', 503, 'run', R, '原本可用的节点正在排空', '稍后重试，任务会调度到其他节点'],
  ['action_required', 422, 'run', _, '兼容端点：任务在等审批，运行已创建', '按运行 ID 处理审批后读取结果，不要重发请求'],
  ['requires_action', 409, 'run', _, '兼容端点：运行处于 requires_action'],
  ['incomplete', 422, 'run', _, '兼容端点：运行未完整完成'],
  ['persistence_failed', 500, 'run', _, '输出无法持久化，执行已停止'],
  ['step_checkpoint_failed', 500, 'run', _, '工具结果无法提交，执行已停止'],
  ['invalid_output_event', 500, 'run', _, '输出事件状态转换无效（内部不变量被破坏）'],
  ['execution_failed', [500, 502], 'run', _, '未分类的执行失败'],
  // approval
  ['approval_expired', 409, 'approval', _, '审批已过期'],
  ['client_tool_timeout', 409, 'approval', _, '调用方没有在期限内回传工具结果，运行已结束', '重新发起请求'],
  ['client_tool_abandoned', 409, 'approval', _, '外部智能体在调用方回传结果之前放弃了这次调用；只有这一步失败，运行继续'],
  ['action_kind_mismatch', 409, 'approval', _, '这个待办等调用方回传工具结果，不能人工批准或拒绝', '由调用方带着工具结果再次请求'],
  ['approval_not_found', 404, 'approval', _, '审批不存在'],
  ['stale_approval', 409, 'approval', _, '审批已不再待处理'],
  ['permission_denied', 403, 'approval', _, '操作被 owner 拒绝，运行以失败结束'],
  ['tool_denied', 403, 'approval', _, '该工具/图执行被禁用'],
  ['step_not_found', 404, 'approval', _, '执行步骤不存在'],
  ['step_scope_mismatch', 403, 'approval', _, '步骤属于其他运行'],
  ['invalid_step_artifact', 403, 'approval', _, '步骤产物不属于该运行'],
  ['invalid_step_checkpoint', 409, 'approval', _, '步骤检查点与运行不匹配'],
  // file
  ['file_not_found', 404, 'file', _, '文件不存在'],
  ['file_too_large', 413, 'file', _, '文件超过 8 MiB'],
  ['file_required', 400, 'file', _, 'multipart 上传缺少文件部分'],
  ['file_integrity', [400, 500], 'file', _, '文件内容摘要不匹配'],
  ['invalid_file', [400, 413], 'file', _, '文件字段、引用或大小无效'],
  ['invalid_file_field', 400, 'file', _, '仅支持 purpose=user_data 或 assistants'],
  ['invalid_path', 400, 'file', _, '路径必须是不含穿越的相对路径'],
  ['data_placement_denied', 403, 'file', _, '输入文件不允许发送到该节点'],
  ['memory_too_large', 413, 'file', _, '记忆条目超过 256 KB'],
  ['artifact_integrity', 502, 'file', _, '原生产物摘要不匹配'],
  ['artifacts_too_large', 413, 'file', _, '原生产物导出超过上限'],
  ['unsafe_artifact', 403, 'file', _, '产物中含符号链接，拒绝自动导出'],
  // tool
  ['invalid_tool_arguments', 400, 'tool', _, '工具参数不符合 schema'],
  ['tool_not_published', 403, 'tool', _, '工具未在该能力包中发布'],
  ['result_export_denied', 403, 'tool', _, '该能力不允许结果离开执行者'],
  ['capability_bound_elsewhere', 403, 'tool', _, '能力绑定在其他主机'],
  ['capability_mismatch', 403, 'tool', _, '节点工具元数据与发布的绑定不一致'],
  ['manifest_mismatch', 403, 'tool', _, '执行内容与已发布的智能体不一致'],
  ['script_disabled', 403, 'tool', _, '该 worker 不允许此脚本运行时'],
  ['skill_not_published', 404, 'tool', _, '文件不在能力包中'],
  ['invalid_tool_calls', 502, 'tool', _, '模型返回了重复或无效的工具调用 ID'],
  ['invalid_tool_result', 502, 'tool', _, 'worker 返回了无效的工具结果'],
  ['tool_arguments_too_large', 502, 'tool', _, '模型给出的工具参数超过上限'],
  ['invalid_graph', 400, 'tool', _, '执行图无效'],
  ['invalid_graph_output', 400, 'tool', _, '图的返回投影引用了不存在的步骤或作用域外的变量'],
  ['workflow_output_contract', 422, 'tool', _, '工作流返回值不符合发布的输出契约；不会启动下一轮模型，也不会回滚已确认的工具操作'],
  ['invalid_concurrency', 400, 'tool', _, '图或叶子执行池的并发上限必须为正整数'],
  ['invalid_expression', 400, 'tool', _, '图表达式无效或超过上限'],
  ['invalid_reference', 400, 'tool', _, '图引用（JSON pointer）无效'],
  ['expression_budget_exceeded', 400, 'tool', _, '表达式结果超过预算'],
  ['foreach_limit_exceeded', 400, 'tool', _, 'foreach 数量超过 max_items'],
  ['unsafe_graph_fallback', 400, 'tool', _, 'fallback 不能掩盖非幂等写操作'],
  ['unsafe_graph_retry', 400, 'tool', _, '不可安全重试的写操作工具上声明了 retry 或 timeout_ms'],
  ['step_timeout', 504, 'tool', _, '执行图中某个步骤的一次尝试超过了声明的 timeout_ms'],
  ['mcp_unconfigured', [503, 400], 'tool', _, '所选 MCP 服务器未在该 worker 上配置'],
  ['mcp_connection_failed', 503, 'tool', _, 'MCP 服务器初始化失败'],
  ['mcp_connection_retired', 503, 'tool', R, 'MCP 连接在执行前已更换，请重试', '直接重试'],
  ['mcp_credentials_unavailable', 503, 'tool', _, '声明的 MCP 凭据环境变量不可用'],
  ['mcp_executable_unavailable', 503, 'tool', _, 'MCP 可执行文件不可用'],
  ['mcp_tool_not_found', 404, 'tool', _, 'MCP 服务器未列出该工具'],
  ['mcp_tool_changed', 409, 'tool', _, 'MCP 工具元数据已变化，需准备新的能力版本'],
  ['mcp_tool_failed', 502, 'tool', _, 'MCP 工具返回 isError=true'],
  ['mcp_ambiguous_tool', 502, 'tool', _, 'MCP 服务器返回了重复的工具名'],
  ['mcp_catalog_limit', [400, 502], 'tool', _, 'MCP 工具发现超过分页上限'],
  ['mcp_invalid_catalog', 502, 'tool', _, 'MCP 工具分页没有推进'],
  // provider
  ['provider_unavailable', 503, 'provider', _, '该节点未配置模型提供方'],
  ['model_not_configured', 503, 'provider', _, '未设置提供方 API 密钥环境变量', '在节点上设置提供方 API 密钥环境变量'],
  ['upstream_rate_limited', [429, 502], 'provider', R, '上游模型限流', '稍后重试'],
  ['upstream_failed', [429, 502], 'provider', _, '上游模型响应失败'],
  ['upstream_incomplete', 502, 'provider', _, '上游以非正常原因结束'],
  ['upstream_truncated', 502, 'provider', _, '上游未给出终止响应就结束'],
  ['upstream_output_limit', 502, 'provider', _, '上游响应超过大小上限（累计 8 MiB 或单个 SSE 事件 2 MiB）'],
  ['upstream_timeout', 504, 'provider', R, 'Anthropic/Gemini 请求超过配置的提供方截止时间，不等同于用户取消', '稍后重试，或调大提供方截止时间'],
  ['invalid_model_result', 502, 'provider', _, 'worker 返回了无效的模型结果'],
  ['invalid_provider_key', 400, 'provider', _, 'X-OAA-Provider-Key 格式无效，或这个头出现了多次'],
  ['byok_not_supported', 400, 'provider', _, '当前智能体、节点或运行不支持调用方自带的提供方密钥'],
  ['provider_key_required', 400, 'provider', _, 'sandbox 级密钥调用沙箱内的原生智能体时必须自带提供方密钥'],
  ['byok_key_required', 409, 'provider', _, '运行使用调用方密钥，但网关已不再持有该密钥', '带上 X-OAA-Provider-Key 重新续跑'],
  ['invalid_provider_state', 502, 'provider', _, '提供方原生轮次状态缺失、畸形或校验失败', '开始新会话'],
  ['provider_state_mismatch', 409, 'provider', _, '续接时提供方协议、端点、模型、工具或对话前缀发生了变化', '恢复原始配置或新建会话'],
  ['provider_state_too_large', 413, 'provider', _, '提供方单轮原生状态超过 2 MiB 上限'],
  ['provider_state_unsupported', [502, 503], 'provider', _, '节点、驱动或网关不支持保留该提供方的原生轮次状态'],
  // engine
  ['native_disabled', 503, 'engine', _, '该原生引擎未在 worker 上启用'],
  ['native_incomplete', 502, 'engine', _, '原生智能体或适配器未完整完成，或提前退出没有给出结果'],
  ['native_truncated', 502, 'engine', _, '原生智能体结束时没有结果'],
  ['image_delivery_failed', 502, 'engine', _, '把图片交给外部智能体这一步失败（工作目录里找不到图片文件）', '重试；仍失败就去掉图片或改作附件发送'],
  ['native_closed', 502, 'engine', _, '原生智能体进程已关闭'],
  ['native_protocol_error', 502, 'engine', _, '原生/ACP 协议错误，或智能体拒绝了请求'],
  ['native_model_mismatch', 409, 'engine', _, '智能体未确认所选模型（未发送任务）'],
  ['native_resume_unsupported', 409, 'engine', _, '智能体无法续接上一轮会话'],
  ['adapter_disabled', 503, 'engine', _, '适配器未启用'],
  ['adapter_not_configured', 503, 'engine', _, '适配器所需令牌环境变量未设置'],
  ['adapter_unavailable', 503, 'engine', _, '适配器进程无法启动'],
  ['adapter_auth_required', 503, 'engine', _, '外部智能体（ACP 智能体、内置的 Claude Code 等）要求先在其自身 CLI 中登录；A2A 端点返回 401/403', '先在该智能体自己的 CLI 中登录'],
  ['adapter_timeout', 504, 'engine', R, 'ACP 握手阶段超时', '稍后重试'],
  ['adapter_failed', 502, 'engine', _, 'HTTP 或 A2A 适配器返回了错误状态或 JSON-RPC 错误'],
  ['adapter_incomplete', 502, 'engine', _, '适配器报告任务未完成（如 A2A 任务失败或被拒绝）'],
  ['adapter_output_limit', 502, 'engine', _, '适配器输出超过 2 MiB（A2A 响应/流超过 8 MiB）'],
  ['approval_failed', 500, 'engine', _, '审批桥内部错误'],
  ['event_failed', 500, 'engine', _, '事件写入失败'],
  ['process_failed', 502, 'engine', _, '受管子进程非零退出'],
  ['invalid_protocol', 502, 'engine', _, 'worker 或子进程输出了无效的协议数据'],
  // node
  ['backend_not_configured', 404, 'node', _, '本地 worker 配置中没有该后端'],
  ['backend_unavailable', 409, 'node', _, '后端可执行文件缺失或不可执行，未启用'],
  ['backend_conflict', 409, 'node', _, '一键启用时，本机配置里已有同名但不同类型的适配器，不会覆盖'],
  ['worker_required', [409, 400], 'node', _, '配置文件中没有本机执行机器（localWorker）'],
  ['check_unsupported', 400, 'node', _, '握手检查只适用于 ACP 与 A2A 适配器'],
  ['local_node_policy', 409, 'node', _, '远程凭据控制不能改变本地 worker'],
  ['node_not_found', 404, 'node', _, '节点注册不存在'],
  ['node_exists', 409, 'node', _, '该节点 ID 已注册'],
  ['node_owner_conflict', 409, 'node', _, '节点身份被其他 owner 占用'],
  ['node_revoked', 409, 'node', _, '节点已吊销（不可逆）'],
  ['node_policy_integrity', 500, 'node', _, '节点策略记录不一致'],
  ['node_already_connected', 409, 'node', _, '同一身份的节点已连接'],
  ['node_identity_reserved', 409, 'node', _, '该本地节点 ID 被远程生命周期策略保留'],
  ['node_credentials_conflict', 409, 'node', _, '节点凭据身份不唯一（启动时）'],
  ['node_scope_denied', 403, 'node', _, '节点通告超出其授权'],
  ['node_disconnected', 503, 'node', R, 'worker 连接已关闭', '稍后重试'],
  ['node_backpressure', 503, 'node', R, 'worker 连接超过缓冲上限', '稍后重试'],
  ['queue_full', 429, 'node', R, '节点队列已满', '稍后重试'],
  ['work_timeout', 504, 'node', R, 'worker 超过执行截止时间', '稍后重试，或调大执行截止时间'],
  ['worker_failed', 502, 'node', _, '远程 worker 执行失败（未带具体码时）'],
  ['worker_capacity_exceeded', 503, 'node', R, '远程 worker 已满载，拒绝新任务', '稍后重试'],
  ['invalid_context', 403, 'node', _, 'worker 归属或会话不匹配'],
  ['bundle_not_loaded', 409, 'node', _, '所需能力包尚未安装到 worker'],
  ['insecure_endpoint', 400, 'node', _, '远程端点必须使用 TLS 且不得包含凭据'],
  ['invalid_credential', 500, 'node', _, '服务或节点令牌少于 24 个字符（配置错误）'],
  ['key_not_found', 404, 'node', _, '该 owner 下找不到 API 密钥'],
  ['node_authentication_denied', null, 'node', _, 'worker 侧：网关拒绝节点凭据，停止重连'],
  ['node_connection_failed', null, 'node', _, 'worker 侧：连接网关失败'],
  ['invalid_config', 400, 'node', _, 'worker 侧：配置无效（如缺少 gatewayUrl）'],
  // client
  ['arguments', 400, 'client', _, '命令行参数无效或缺失'],
  ['unknown_command', 400, 'client', _, '未知的命令'],
  ['dsh_overlay_required', 400, 'client', _, 'DSH 需先以默认方式暴露，再在 worker 配置中设置模型覆盖参数'],
  ['exposure_conflict', 400, 'client', _, '该目录属于另一个暴露配置'],
  ['native_not_installed', 400, 'client', _, '所需的原生智能体可执行文件未安装'],
  ['node_startup_failed', 503, 'client', _, '暴露的 worker 没有完成注册'],
  ['startup_failed', 500, 'client', _, '服务启动失败'],
  ['startup_timeout', 500, 'client', _, '未观察到服务就绪'],
  ['tunnel_binary_missing', 400, 'client', _, '未提供公网地址，且 PATH 中没有 cloudflared'],
  ['tunnel_exited', 502, 'client', _, 'cloudflared 提前退出'],
  ['tunnel_timeout', 504, 'client', _, '等待 cloudflared 公网地址超时'],
  ['output_exists', 400, 'client', _, '工具准备的输出目录已存在'],
  ['tool_conflict', 400, 'client', _, '所选工具配置与已有引用或能力重复'],
  ['host_binding', 400, 'client', _, '所选工具属于另一个 worker 节点'],
  ['mcp_descriptor_too_large', 400, 'client', _, '所选工具的元数据超过 200 KiB'],
  ['mcp_task_mode_unsupported', 400, 'client', _, '该工具需要 MCP 任务增强执行，当前 worker 未实现'],
  ['gateway_error', null, 'client', _, '网关返回了错误响应，且没有给出错误码'],
  ['gateway_response_too_large', 502, 'client', _, '网关响应超过客户端读取上限'],
  ['gateway_timeout', 504, 'client', R, '网关请求在确认前结束，已接受的任务可能仍在运行', '用同一个 Idempotency-Key 重新提交'],
  ['invalid_gateway_path', 400, 'client', _, '请求路径离开了配置的网关源'],
  ['invalid_gateway_response', 502, 'client', _, '网关返回了无效的 JSON'],
  ['request_cancelled', 499, 'client', _, '调用方取消了网关请求'],
  ['token_required', 400, 'client', _, '未提供 API 密钥文件', '加 --token-file：管理命令用 oaa init 生成的 .oaa/admin.token，调用用 oaa key create 生成的密钥文件'],
  ['gateway_unreachable', 503, 'client', R, '连不上网关', '先启动网关（oaa serve --detach，源码目录里是 npm run oaa -- serve --detach），或用 --url 指向正在运行的网关'],
  ['port_in_use', 409, 'client', _, 'quickstart 要用的端口已被其它程序或另一个网关占用', '用 oaa quickstart --port <端口> 换一个端口'],
  ['sample_agent_missing', 500, 'client', _, '找不到随附的离线示例智能体 examples/sample-agent.mjs', '重新安装，或在源码目录里运行'],
  ['agent_conflict', 409, 'client', _, '同名智能体已发布为另一个引擎，connect 不覆盖'],
  ['not_running', 404, 'client', _, '没有找到由 oaa serve --detach 启动、仍在运行的网关'],
  ['approval_ambiguous', 400, 'client', _, '这个运行有多个待审批项，没有指定要处理哪一项', '用 --action 审批项编号指定一项，或用 --all 处理全部；oaa approvals 列出它们'],
  ['approval_declined', 400, 'client', _, '你在确认时选择了不批准，没有批准任何项'],
  // platform
  ['registration_closed', 403, 'platform', _, '这个站点不开放自助注册', '联系站点运营者开通账号'],
  ['invite_required', 403, 'platform', _, '注册需要邀请码', '向站点运营者索取邀请码'],
  ['invalid_code', 400, 'platform', _, '兑换码、邀请码或重置码无效、已用完、已过期或已被本账号用过'],
  ['email_taken', 409, 'platform', _, '邮箱已注册', '直接登录，或换一个邮箱'],
  ['invalid_credentials', 401, 'platform', _, '邮箱或密码不正确'],
  ['session_invalid', 401, 'platform', _, '门户会话无效或已过期', '重新登录'],
  ['account_disabled', 403, 'platform', _, '账号已停用', '联系站点运营者'],
  ['account_not_found', 404, 'platform', _, '账号不存在'],
  ['insufficient_balance', 402, 'platform', _, '余额不足', '兑换点数后再提交'],
  ['key_limit_reached', 409, 'platform', _, '账号的密钥数量已到上限', '先吊销不用的密钥'],
  ['listing_not_found', 404, 'platform', _, '该智能体没有上架记录'],
  ['usage_pricing_unsupported', 400, 'platform', _, '这个智能体不上报 token 用量，不能按用量定价', '改为按次定价（per_1k_tokens 设为 0）'],
  ['code_not_found', 404, 'platform', _, '兑换码不存在'],
  ['reference_conflict', 409, 'platform', _, '这个外部单号已经用于另一笔金额不同的入账', '换一个单号，或核对金额'],
  ['platform_managed_by_config', 409, 'platform', _, '配置文件里已有 platform 段，开发者平台由配置文件管理，控制台里不能修改', '改配置文件里的 platform 段后重启；或删掉该段，改在控制台里启用'],
  // webhooks
  ['webhook_not_found', 404, 'request', _, '没有这个编号的事件回调端点', '用 oaa webhook list 查看已有的端点编号'],
  ['webhook_url_invalid', 400, 'request', _, '回调地址无效：只允许 http/https、不能带用户名密码；非本机回环地址必须用 https', '改用 https 地址；确实要用明文 http 时显式设置 allow_insecure_http'],
  ['webhook_target_denied', 400, 'request', _, 'public 安全档位下，回调地址不能指向私网、本机回环、链路本地或云元数据地址', '换成公网地址；确实要回调内网时为该端点显式设置 allow_private_network'],
  ['webhook_limit_reached', 409, 'request', _, '事件回调端点数已达上限（每个 owner 20 个）', '先删除不再使用的端点'],
  ['webhook_delivery_not_found', 404, 'request', _, '这个端点下没有这个编号的投递记录'],
  ['webhook_delivery_pending', 409, 'request', _, '这条投递还在队列里，不能重发', '等它投递成功或最终失败后再重发'],
];

/** 第一轮模型调用失败时可以换一条线路重试的码。 */
const ROUTE_RETRYABLE = new Set([
  'upstream_rate_limited',
  'upstream_failed',
  'upstream_truncated',
  'node_disconnected',
  'work_timeout',
]);
/** 换一个智能体也解决不了、或者本来就是调用方限制的失败：不触发换用备选智能体。 */
const FALLBACK_EXEMPT = new Set([
  'turn_limit',
  'token_budget',
  'max_output_tokens',
  'scope_denied',
  'isolation_required',
  'permission_denied',
  'output_too_large',
  'persistence_failed',
  'effect_outcome_unknown',
]);
/** 外部执行（原生智能体、写/未知副作用的工具）已经开始后出现时，结果按未知处理的码。 */
const UNCERTAIN_WHEN_STARTED = new Set([
  'node_disconnected',
  'work_timeout',
  'cancelled',
  'execution_failed',
]);
/** 只作运行错误码、原因是这次调用自身的上限或额度的码（见文件头 `callerLimit`）。 */
const CALLER_LIMIT = new Set(['turn_limit', 'token_budget', 'max_output_tokens']);
for (const set of [ROUTE_RETRYABLE, FALLBACK_EXEMPT, UNCERTAIN_WHEN_STARTED, CALLER_LIMIT])
  for (const code of set)
    if (!ROWS.some((row) => row[0] === code))
      throw new Error(`Error flag lists an unregistered code: ${code}`);
for (const code of Object.keys(ERROR_EN))
  if (!ROWS.some((row) => row[0] === code))
    throw new Error(`errors-en.ts lists an unregistered code: ${code}`);

export const ERROR_CATALOG: readonly ErrorEntry[] = Object.freeze(
  ROWS.map(([code, status, category, retryable, zh, next]): ErrorEntry => ({
    code,
    ...(Array.isArray(status) ? { status: status[0]!, statuses: status } : { status }),
    category,
    retryable,
    zh,
    ...(next ? { next } : {}),
    en: ERROR_EN[code]?.[0] ?? '',
    ...(ERROR_EN[code]?.[1] ? { nextEn: ERROR_EN[code][1] } : {}),
    ...(ROUTE_RETRYABLE.has(code) ? { routeRetryable: true as const } : {}),
    ...(FALLBACK_EXEMPT.has(code) ? { fallbackExempt: true as const } : {}),
    ...(UNCERTAIN_WHEN_STARTED.has(code) ? { uncertainWhenStarted: true as const } : {}),
    ...(CALLER_LIMIT.has(code) ? { callerLimit: true as const } : {}),
  })),
);
const byCode = new Map(ERROR_CATALOG.map((entry) => [entry.code, entry]));

/**
 * 兼容入口错误体选类别（Claude `error.type`、Gemini `status`）用的状态语义，不改 HTTP 状态：
 * status null 的 run 码按 `callerLimit` 分成 422（调用自身的上限）与 500（服务一侧的原因）。
 */
export function errorClassStatus(code: string, status: number): number {
  const entry = byCode.get(code);
  if (!entry || entry.status !== null || entry.category !== 'run') return status;
  return entry.callerLimit ? 422 : 500;
}

/** 原始消息里对排错有用的 ASCII 片段（字段名、路径、ID、数字），英文回退时附在目录句子后面。 */
const asciiDetail = (message: string): string =>
  (message.match(/[\x21-\x7e]+(?: [\x21-\x7e]+)*/g) ?? [])
    .map((part) => part.replace(/^[^\w/<]+|[^\w>)\]]+$/g, ''))
    .filter((part) => /[a-z0-9]/i.test(part))
    .join(', ')
    .slice(0, 300);

/**
 * 按语言选错误说明：双语抛出点取对应一边；中文照旧返回原消息；英文下原消息含汉字时
 * 回退为错误目录的英文句子，并附上原消息里的 ASCII 细节。其余（本来就是英文的消息）原样返回。
 */
export function faultMessage(fault: Fault, locale: Locale): string {
  if (fault.text) return fault.text[locale];
  if (locale === 'zh' || !/\p{Script=Han}/u.test(fault.message)) return fault.message;
  const base = byCode.get(fault.code)?.en || 'The request failed.';
  const detail = asciiDetail(fault.message);
  return detail ? `${base} (${detail})` : base;
}

/** 按错误码查目录条目；未登记的码返回 undefined。 */
export function errorEntry(code: string): ErrorEntry | undefined {
  return byCode.get(code);
}

/** 第一轮模型调用失败时，这个码是否允许换一条线路重试。 */
export function isRouteRetryable(code: string): boolean {
  return byCode.get(code)?.routeRetryable === true;
}
/** 这个码是否不触发换用备选智能体。 */
export function isFallbackExempt(code: string): boolean {
  return byCode.get(code)?.fallbackExempt === true;
}
/** 外部执行已经开始后出现这个码时，结果是否按未知处理。 */
export function isUncertainWhenStarted(code: string): boolean {
  return byCode.get(code)?.uncertainWhenStarted === true;
}
/** 目录内容的版本：内容的 sha256 前 16 位，供 GET /v1/errors 的 ETag 使用。 */
export const ERROR_CATALOG_REVISION = sha(
  JSON.stringify({ categories: ERROR_CATEGORIES, data: ERROR_CATALOG }),
).slice(0, 16);
