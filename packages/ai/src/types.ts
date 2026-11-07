import type { Ctx, Kernel } from '@yss123/cage-kernel';
import type { RuntimeOntology } from '@yss123/cage-ontology';
import type { StoredRun } from './state.js';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** 本地证据定位，不发送为模型协议字段。 */
  runId?: string;
  receipt?: { runId: string; actionId: string };
  /** Responses 的不透明推理/压缩项仅用于同配置恢复，不向 UI 展示。 */
  providerItems?: { key: string; items: Record<string, unknown>[] };
}
export interface ModelTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
}
export interface ModelResult {
  text: string;
  calls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  responseId?: string;
  outputItems?: Record<string, unknown>[];
}
export interface ModelRequest {
  messages: ModelMessage[];
  tools: ModelTool[];
  maxOutputTokens: number;
  signal: AbortSignal;
  onText?: (text: string) => Promise<void>;
  /** 运行时注入的可信上下文，协议适配器不得发送给外部模型。 */
  context?: { tenantId: string; runId: string };
  /** 仅由运行时从已授权的持久会话读取；ID 不接受浏览器输入。 */
  previousResponseId?: string;
  stateKey?: string;
}
export interface ModelProvider {
  /** 可序列化且不含密钥的配置，参与 API/worker 一致性检查。 */
  readonly spec: Record<string, unknown>;
  bind?(kernel: Kernel): ModelProvider;
  /** 每步解析一次托管配置，使预算与实际请求使用同一份配置快照。 */
  resolve?(context: { tenantId: string }): Promise<ModelProvider>;
  contextWindowTokens?: number;
  continuation?: { key: string; compaction: boolean };
  generate(request: ModelRequest): Promise<ModelResult>;
}
export interface RunLimits {
  maxSteps: number;
  maxToolCalls: number;
  tokenBudget: number;
  timeoutMs: number;
  maxOutputTokens: number;
  maxModelRetries?: number;
}
export interface AiContextOptions {
  /** 所有工具 schema 的估算 Token 上限，默认模型窗口的 25%，仍受本轮剩余空间约束。 */
  maxToolTokens?: number;
  /** 协议工具数量上限，包含通用工具；不是开启发现的固定业务工具阈值。默认 128。 */
  maxTools?: number;
  /** 自动恢复的近期完整轮次预算；更早资料继续保留并可按引用分页取回。 */
  maxHistoryTokens?: number;
}
export interface AiOptions {
  models: Record<string, ModelProvider>;
  assistant?: { model: string; instructions?: string; limits?: Partial<RunLimits>; confirmWrites?: boolean };
  maxConcurrentRuns?: number;
  maxQueuedPerUser?: number;
  context?: AiContextOptions;
  /** 使用已构建清单时，启动必须校验其注册指纹。省略则从同一运行注册表构建。 */
  ontology?: RuntimeOntology;
  delegationTtlMs?: number;
}
export const DEFAULT_LIMITS: RunLimits = {
  maxSteps: 16,
  maxToolCalls: 40,
  tokenBudget: 40_000,
  timeoutMs: 120_000,
  maxOutputTokens: 4000,
  maxModelRetries: 2,
};
export interface Execution {
  kernel: Kernel;
  ctx: Ctx;
  run: StoredRun;
  signal: AbortSignal;
  ontology: RuntimeOntology;
}
export const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
