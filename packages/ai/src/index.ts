/**
 * AI 包公开入口。应用顶层 ai() 声明向注册表提供服务、能力和迁移，供 CLI/API/worker 一致使用。
 * 声明阶段只验证冻结配置；按 Kernel 懒创建并复用运行时，不在模块加载时访问数据库或模型。
 */
import {
  RUNTIME,
  MIGRATIONS,
  declError,
  type Kernel,
  type Registry,
  type RuntimeDefinition,
} from '@yss123/cage-kernel';
import { AI_MIGRATION } from './schema.js';
import { AiRuntime } from './runtime.js';
import { DEFAULT_LIMITS, type AiOptions } from './types.js';
import { MODEL_MIGRATION, MODEL_CAPABILITY } from './models.js';
import { PERSONALITY_MIGRATION, PERSONALITY_CAPABILITY } from './personalities.js';
import { CONTEXT_MIGRATION } from './context-schema.js';
import { EXECUTION_MIGRATION } from './execution-schema.js';
export { AiRuntime } from './runtime.js';
export { chatModel, type ChatModelOptions } from './model.js';
export { responsesModel, type ResponsesModelOptions } from './responses.js';
export { managedModel, ModelManager } from './models.js';
export type {
  AiOptions,
  AiContextOptions,
  RunLimits,
  ModelProvider,
  ModelRequest,
  ModelResult,
  ModelMessage,
  ModelTool,
  ToolCall,
} from './types.js';
export type {
  PageContext,
  AiRun,
  AiEvent,
  AiInteraction,
  AiMessageInput,
  AiSession,
  AiMemory,
} from '@yss123/cage-ai-protocol';

/**
 * 可注册的 AI 服务声明，校验唯一启用和模型引用，并按内核复用运行时。
 */
export interface AiDefinition extends RuntimeDefinition {
  /**
   * 获取或创建绑定内核的 AiRuntime，生命周期由宿主管理。
   */
  service(kernel: Kernel): AiRuntime;
  /**
   * 校验扩展唯一性与审批模型引用，无效配置以 CAGE-AI-001 拒绝。
   */
  validate(registry: Registry): void;
}

/**
 * 创建供 domain 顶层导出的 AI 服务声明，CLI、API 和 worker 从同一注册表取得能力、迁移与运行时。
 * 复制并冻结模型映射、上下文和助理额度，校验模型引用、窗口、并发及超时边界；无效声明以 CAGE-AI-001 拒绝。
 * service 按 Kernel 实例懒创建并缓存运行时，validate 再核对唯一启用和审批节点的模型引用。
 * 声明阶段没有数据库或网络 IO；公开能力仍需管理员明确授予，启用声明不自动授权用户或连接真实模型。
 */
export function ai(options: AiOptions): AiDefinition {
  options = {
    ...options,
    context: options.context && Object.freeze({ ...options.context }),
    models: Object.freeze({ ...options.models }),
    assistant:
      options.assistant &&
      Object.freeze({ ...options.assistant, limits: Object.freeze({ ...options.assistant.limits }) }),
  };
  if (!Object.keys(options.models).length) throw declError('CAGE-AI-001', '至少配置一个模型');
  for (const provider of Object.values(options.models))
    if (
      provider.contextWindowTokens !== undefined &&
      (!Number.isSafeInteger(provider.contextWindowTokens) ||
        provider.contextWindowTokens < 8192 ||
        provider.contextWindowTokens > 2_000_000)
    )
      throw declError('CAGE-AI-001', 'contextWindowTokens 必须是 8192 至 2000000 之间的整数');
  const limits = { ...DEFAULT_LIMITS, ...options.assistant?.limits };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < (key === 'maxModelRetries' ? 0 : 1))
      throw declError('CAGE-AI-001', `${key} 超出允许范围`);
  for (const [key, value] of Object.entries(options.context ?? {}))
    if (!Number.isSafeInteger(value) || value <= 0) throw declError('CAGE-AI-001', `${key} 必须是正整数`);
  if ((options.context?.maxTools ?? 128) > 128) throw declError('CAGE-AI-001', 'maxTools 最多 128（包含通用工具）');
  if ((limits.maxModelRetries ?? 2) > 8) throw declError('CAGE-AI-001', 'maxModelRetries 最多 8 次');
  if (options.assistant && !options.models[options.assistant.model])
    throw declError('CAGE-AI-001', '助理引用的模型不存在');
  for (const value of [options.maxConcurrentRuns ?? 2, options.maxQueuedPerUser ?? 8, options.delegationTtlMs ?? 1])
    if (!Number.isSafeInteger(value) || value <= 0) throw declError('CAGE-AI-001', '并发、队列与委托期限必须是正整数');
  if ((options.maxConcurrentRuns ?? 2) > 32 || limits.timeoutMs > 300_000)
    throw declError('CAGE-AI-001', '并发最多 32，单轮运行超时最多 300000 毫秒');
  // 按内核实例缓存而非全局单例，避免不同应用/连接配置共享运行队列；弱引用不阻止已释放内核回收。
  const services = new WeakMap<Kernel, AiRuntime>();
  return Object.freeze({
    [RUNTIME]: true as const,
    name: 'ai',
    spec: {
      models: Object.fromEntries(Object.entries(options.models).map(([name, value]) => [name, value.spec])),
      assistant: options.assistant,
      context: options.context,
      maxConcurrentRuns: options.maxConcurrentRuns,
      maxQueuedPerUser: options.maxQueuedPerUser,
      delegationTtlMs: options.delegationTtlMs,
    },
    capabilities: [
      { capability: 'Sys.ai.use', kind: 'system' as const, description: '使用领域智能助理（业务权限仍单独校验）' },
      { capability: MODEL_CAPABILITY, kind: 'system' as const, description: '管理本租户 AI 模型连接与密钥' },
      { capability: PERSONALITY_CAPABILITY, kind: 'system' as const, description: '管理本租户助理性格、默认项及试聊' },
    ],
    [MIGRATIONS]: () => [AI_MIGRATION, MODEL_MIGRATION, PERSONALITY_MIGRATION, CONTEXT_MIGRATION, EXECUTION_MIGRATION],
    service(kernel: Kernel) {
      let service = services.get(kernel);
      if (!service) {
        service = new AiRuntime(kernel, options);
        services.set(kernel, service);
      }
      return service;
    },
    validate(registry: Registry) {
      if (registry.extensions.filter((e) => e.kind === 'RUNTIME' && e.value.name === 'ai').length !== 1)
        throw declError('CAGE-AI-001', '只能启用一个 AI 运行时');
      // 容器内的 AI 仍须经过相同模型/预算检查；不能因放入条件或并行分支而遗漏启动期校验。
      const leafSteps = (nodes: readonly any[]): any[] => nodes.flatMap(node => node.kind === 'when' ? leafSteps(node.steps)
        : node.kind === 'parallel' ? node.branches.flatMap((branch: any) => leafSteps(branch.nodes)) : [node]);
      for (const ext of registry.extensions.filter((e) => e.kind === 'ROUTE'))
        for (const node of leafSteps(ext.value.nodes)) {
          if (node.kind === 'ai' && !options.models[node.model])
            throw declError('CAGE-AI-001', `AI 审批引用的模型 ${node.model} 未配置`);
          if (node.kind === 'ai' && (node.limits?.timeoutMs ?? 1) > 300_000)
            throw declError('CAGE-AI-001', '审批 timeoutMs 最多 300000 毫秒');
        }
    },
  });
}
