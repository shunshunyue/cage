/**
 * AI 后端统一类型与运行配置。模型适配器、请求规划和运行时共用这些定义；浏览器使用 ai-protocol。
 * 请求数据不授予权限，可信身份来自内核；模型返回的调用还必须经过参数、授权与事务校验。
 */
import type { Ctx, Kernel } from '@yss123/cage-kernel';
import type { RuntimeOntology } from '@yss123/cage-ontology';
import type { StoredRun } from './state.js';

/**
 * 模型提议的工具调用，先持久化计划再验证执行；模型 ID 只在同一步内识别调用。
 */
export interface ToolCall {
  /**
   * 模型调用标识，与步数组成持久动作去重键。
   */
  id: string;
  /**
   * 必须匹配已提供工具的协议名称。
   */
  name: string;
  /**
   * 尚待对应 schema 校验的模型参数。
   */
  arguments: Record<string, unknown>;
}
/**
 * 持久消息的通用表示；运行引用与原生协议项保留在服务端，适配器只发送协议允许字段。
 */
export interface ModelMessage {
  /**
   * 系统、用户、助理或工具角色；工具数据不能提升为系统指令。
   */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * 文字或 JSON 回执；仅有工具调用时可以为空。
   */
  content: string;
  /**
   * 助理提出的调用组，省略表示普通文字。
   */
  toolCalls?: ToolCall[];
  /**
   * 回执对应的调用 ID，需与前面的调用配对。
   */
  toolCallId?: string;
  /** 本地证据定位，不发送为模型协议字段。 */
  runId?: string;
  /**
   * 可按权限回查原始结果的运行/动作引用。
   */
  receipt?: { runId: string; actionId: string };
  /** Responses 的不透明推理/压缩项仅用于同配置恢复，不向 UI 展示。 */
  providerItems?: { key: string; items: Record<string, unknown>[] };
}
/**
 * 模型可见工具定义；这里只含描述和完整 schema，执行函数由服务端持有。
 */
export interface ModelTool {
  /**
   * 稳定协议工具名，不是任意可执行代码标识。
   */
  name: string;
  /**
   * 工具用途与边界的公开说明。
   */
  description: string;
  /**
   * 完整 JSON Schema，不能为预算截掉部分字段。
   */
  input: Record<string, unknown>;
}
/**
 * 适配器验证后的单次结果；usage 缺失时按预留额度估算，calls 尚不表示业务已经执行。
 */
export interface ModelResult {
  /**
   * 最终文字，供流式显示校准。
   */
  text: string;
  /**
   * 待执行调用列表；空列表在审批模式不能替代裁决。
   */
  calls: ToolCall[];
  /**
   * 上游报告的输入/输出 Token；省略时保守估算。
   */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * 已由适配器检查的停止原因。
   */
  finishReason?: string;
  /**
   * Responses 完成响应 ID，只在同配置下接续。
   */
  responseId?: string;
  /**
   * Responses 原生输出，可能含不透明推理项，仅后端恢复使用。
   */
  outputItems?: Record<string, unknown>[];
}
/**
 * 一次有界模型请求，输入、工具及输出预算已规划；取消信号同时传入网络和流式回调。
 */
export interface ModelRequest {
  /**
   * 当前有界消息窗口，裁剪不删除原始记录。
   */
  messages: ModelMessage[];
  /**
   * 本步可用的完整工具定义，执行时仍复核授权。
   */
  tools: ModelTool[];
  /**
   * 本次输出额度，包含供应商计入的推理 Token。
   */
  maxOutputTokens: number;
  /**
   * 租约、停止或超时触发的取消信号。
   */
  signal: AbortSignal;
  /**
   * 增量文字回调，异步完成支持背压。
   */
  onText?: (text: string) => Promise<void>;
  /** 运行时注入的可信上下文，协议适配器不得发送给外部模型。 */
  context?: { tenantId: string; runId: string };
  /** 仅由运行时从已授权的持久会话读取；ID 不接受浏览器输入。 */
  previousResponseId?: string;
  /**
   * 模型配置指纹，不匹配时不能复用原生历史项。
   */
  stateKey?: string;
}
/**
 * 模型适配接口；spec 不含密钥，托管模型通过 bind/resolve 获取当前租户配置后执行 generate。
 */
export interface ModelProvider {
  /** 可序列化且不含密钥的配置，参与 API/worker 一致性检查。 */
  readonly spec: Record<string, unknown>;
  /**
   * 按内核绑定服务依赖，声明阶段不访问数据库。
   */
  bind?(kernel: Kernel): ModelProvider;
  /** 每步解析一次托管配置，使预算与实际请求使用同一份配置快照。 */
  resolve?(context: { tenantId: string }): Promise<ModelProvider>;
  /**
   * 真实模型窗口 Token 容量，省略使用框架默认值。
   */
  contextWindowTokens?: number;
  /**
   * 接续指纹和压缩开关；开启不证明远端已经压缩。
   */
  continuation?: { key: string; compaction: boolean };
  /**
   * 执行一次模型请求；协议或网络失败抛给运行时分类。
   */
  generate(request: ModelRequest): Promise<ModelResult>;
}
/**
 * 整轮执行的硬额度，分别限制有效步数、尝试次数、工具数、Token 和执行毫秒数。
 */
export interface RunLimits {
  /**
   * 有效模型步数上限。
   */
  maxSteps: number;
  /**
   * 本轮工具调用累计上限。
   */
  maxToolCalls: number;
  /**
   * 本轮累计输入与输出 Token 额度。
   */
  tokenBudget: number;
  /**
   * 执行阶段总超时，单位毫秒，等待交互恢复后重新建立截止时间。
   */
  timeoutMs: number;
  /**
   * 单次最大输出 Token，仍受剩余额度限制。
   */
  maxOutputTokens: number;
  /**
   * 额外调用尝试上限，不表示所有错误自动重试。
   */
  maxModelRetries?: number;
}
/**
 * 工具与历史的可选输入上限，仍受窗口、输出预留和整轮剩余额度共同限制。
 */
export interface AiContextOptions {
  /** 所有工具 schema 的估算 Token 上限，默认模型窗口的 25%，仍受本轮剩余空间约束。 */
  maxToolTokens?: number;
  /** 协议工具数量上限，包含通用工具；不是开启发现的固定业务工具阈值。默认 128。 */
  maxTools?: number;
  /** 自动恢复的近期完整轮次预算；更早资料继续保留并可按引用分页取回。 */
  maxHistoryTokens?: number;
}
/**
 * 应用顶层 ai() 配置；模型别名、助理策略和并发设置由应用声明，权限仍由内核决定。
 */
export interface AiOptions {
  /**
   * 模型别名到适配器的映射，审批与助理按别名引用。
   */
  models: Record<string, ModelProvider>;
  /**
   * 可选助理：model 为别名，instructions 为策略，limits 覆盖额度，confirmWrites 控制普通写确认。
   */
  assistant?: { model: string; instructions?: string; limits?: Partial<RunLimits>; confirmWrites?: boolean };
  /**
   * 单个运行时实例并发数，不是全局集群配额。
   */
  maxConcurrentRuns?: number;
  /**
   * 同租户同用户未终结运行上限，提交时在配额锁内检查。
   */
  maxQueuedPerUser?: number;
  /**
   * 工具与历史预算策略，不增加数据或工具权限。
   */
  context?: AiContextOptions;
  /** 使用已构建清单时，启动必须校验其注册指纹。省略则从同一运行注册表构建。 */
  ontology?: RuntimeOntology;
  /**
   * 委托有效期，单位毫秒；等待用户同样受限制。
   */
  delegationTtlMs?: number;
}
/**
 * 未覆盖项使用的默认单轮额度，提交时复制到运行记录，不追改已排队任务。
 */
export const DEFAULT_LIMITS: RunLimits = {
  maxSteps: 16,
  maxToolCalls: 40,
  tokenBudget: 40_000,
  timeoutMs: 120_000,
  maxOutputTokens: 4000,
  maxModelRetries: 2,
};
/**
 * 每一步的可信执行快照；动作前重新读取权限，持久变更还需有效租约。
 */
export interface Execution {
  /**
   * 安全读取、命令与事务所依赖的内核。
   */
  kernel: Kernel;
  /**
   * 当前主体、租户、能力与范围。
   */
  ctx: Ctx;
  /**
   * 当前持久运行快照，写入前仍需核对租约。
   */
  run: StoredRun;
  /**
   * 取消与执行截止信号。
   */
  signal: AbortSignal;
  /**
   * 与注册指纹对应的服务端本体。
   */
  ontology: RuntimeOntology;
}
/**
 * 运行终态集合，用于队列、历史与前端判断；等待用户的状态仍未终结。
 */
export const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
