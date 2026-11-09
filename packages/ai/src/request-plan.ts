/**
 * 将运行快照、模型配置、授权工具和上下文预算组装为单次模型请求计划。
 * 由运行时在发起外部请求前调用，发现工具也复用同一容量规则；这里只规划，不发网络请求、不修改运行记录，持久化由租约事务完成。
 */
import { cageError } from '@yss123/cage-kernel';
import { modelBudget, checkModelBudget, type ModelBudget } from './budget.js';
import { SYSTEM_PROMPT, ONTOLOGY_PROMPT, DISCOVERY_PROMPT } from './context.js';
import { personalityPrompt } from './personalities.js';
import { packPrompt, toolTokens } from './prompt.js';
import { remoteHistory, type RemoteHistory, type ToolPlan } from './state.js';
import { authorizedToolKeys, candidateToolKeys } from './tool-catalog.js';
import { toolsFor, type Tool } from './tools.js';
import type { AiContextOptions, Execution, ModelMessage, ModelProvider } from './types.js';

/**
 * 可被运行时原子记录的单次模型请求计划。
 * 所有字段来自同一 provider 和预算快照，避免请求参数、预留用量及后续工具加载使用不同配置。
 */
export interface ModelPlan {
  /**
   * 最终模型消息，可能包含明确的上下文展开引用。
   */
  messages: ModelMessage[];
  /**
   * 本轮完整可执行工具对象；发送协议时只提取公开 schema。
   */
  tools: Tool[];
  /**
   * 实际装载的业务命令/查询本体 key，不包括基础工具。
   */
  keys: string[];
  /**
   * 本轮全量/发现模式及可复用的工具预算。
   */
  selection: ToolPlan;
  /**
   * 已核对配置键和历史游标的远端状态；null 表示本地重建。
   */
  remote: RemoteHistory | null;
  /**
   * 本轮输入加已知远端历史的 Token 估算值。
   */
  estimatedInput: number;
  /**
   * 不超过模型输出配置及本轮剩余累计预算的输出 Token 上限。
   */
  outputLimit: number;
  /**
   * 本次请求是否省略或缩小资料，需要向模型明示。
   */
  reduced: boolean;
  /**
   * 本次请求共用的窗口、累计消耗及工具容量快照。
   */
  budget: ModelBudget;
}

/**
 * 按运行模式组合系统指令。
 * 审批仅加入节点策略与审核工具约束，不使用助理性格；助理加入本体发现、业务指令与表达资料，工具是否已全量加载决定发现提示。
 */
function instructions(execution: Execution, discovery: boolean): string {
  const { run } = execution;
  if (run.mode === 'approval')
    return `${SYSTEM_PROMPT}\n仅使用本审批节点的审核策略、已声明查询和 review_decide；资料不足应继续取证或转人工。\n${run.instructions}`;
  const toolGuide = discovery
    ? DISCOVERY_PROMPT
    : '本轮已装载当前主体可调用的全部业务命令和查询。需要系统规则仍应查询本体；不能编造未提供的工具。';
  return [
    SYSTEM_PROMPT,
    ONTOLOGY_PROMPT,
    toolGuide,
    run.instructions,
    run.personality ? personalityPrompt(run.personality) : '',
  ].join('\n');
}

/**
 * 按候选先后顺序去重并装入完整工具定义，分别约束数量与 Token。
 * 基础工具本身放不下立即失败；单个候选过大则跳过继续尝试后续候选，不裁剪工具参数 schema。返回真正装载的 key 和工具列表。
 */
function fitCandidates(
  base: Tool[],
  business: Map<string, Tool>,
  candidates: string[],
  selection: ToolPlan,
): { keys: string[]; tools: Tool[] } {
  const tools = [...base],
    keys: string[] = [];
  if (tools.length > selection.maxTools || toolTokens(tools) > selection.tokenBudget)
    throw new Error('AI_CONTEXT_TOO_LARGE');
  for (const key of new Set(candidates)) {
    const tool = business.get(key);
    if (!tool) continue;
    if (tools.length === selection.maxTools) break;
    if (toolTokens([...tools, tool]) > selection.tokenBudget) continue;
    tools.push(tool);
    keys.push(key);
  }
  return { keys, tools };
}

/** 只装配请求，不执行模型或更改状态。一次规划共享模型配置和预算快照。 */
/**
 * 核验轮数、尝试次数及累计 Token 预算，再选择全量工具或助理发现模式。
 * 有效远端接续先扣除已知历史成本，不能因为启用压缩就假定窗口变小；接续装不下时从本地历史重新规划。
 * 审批不能降级为工具发现；当容量不足实际来自累计预算而非模型窗口时，映射为 AI_BUDGET_EXCEEDED，便于区分配置与本次运行耗尽。
 */
export function planModelRequest(
  execution: Execution,
  provider: ModelProvider,
  options: AiContextOptions = {},
): ModelPlan {
  const { run } = execution;
  const budget = modelBudget(provider, run.limits, run.tokens, options);
  checkModelBudget(run.limits, run.steps, run.model_attempts, budget);
  const key = provider.continuation?.key;
  const remote = run.continuation_disabled_key === key ? null : remoteHistory(run.model_state, key, run.history.length);
  const allKeys = run.mode === 'assistant' ? authorizedToolKeys(execution) : [];
  const full = toolsFor(execution, { keys: allKeys, discovery: false });

  // 单次装配可尝试远端接续或本地历史；两条路径共用已解析 provider 和预算，失败才切换，避免参数快照漂移。
  function assemble(state: RemoteHistory | null): ModelPlan {
    // 没有实际压缩结果的用量不能凭开关假定缩小。接续超预算时使用本地完整交互重新装配。
    const chainTokens = state?.contextTokens ?? 0;
    const inputLimit = budget.inputLimit - chainTokens;
    if (run.mode === 'approval' && full.length > budget.maxTools) throw new Error('AI_CONTEXT_TOO_LARGE');
    const pack = (tools: Tool[], discovery: boolean) =>
      packPrompt({
        instructions: instructions(execution, discovery),
        context: run.context,
        tools,
        history: state ? run.history.slice(state.historyLength) : run.history,
        historyOmitted: !state && run.history_omitted,
        continuation: !!state,
        stateKey: key,
        maxInputTokens: inputLimit,
      });
    let keys = allKeys,
      tools = full;
    const baseAll = full.filter((tool) => !tool.key);
    const baselineAll = pack(baseAll, false);
    const allAvailable = inputLimit - (baselineAll.estimatedInput - toolTokens(baseAll));
    const defaultAllowance = Math.max(budget.toolTokens, toolTokens(baseAll));
    let selection: ToolPlan = {
      mode: 'all',
      tokenBudget: Math.min(options.maxToolTokens ?? defaultAllowance, allAvailable),
      maxTools: budget.maxTools,
    };
    let packed: ReturnType<typeof packPrompt> | undefined;
    if (run.mode === 'approval' || (full.length <= budget.maxTools && toolTokens(full) <= selection.tokenBudget)) {
      try {
        packed = pack(full, false);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'AI_CONTEXT_TOO_LARGE') throw error;
      }
    }
    if (!packed) {
      if (run.mode === 'approval') throw new Error('AI_CONTEXT_TOO_LARGE');
      const base = toolsFor(execution, { keys: [], discovery: true });
      const baseline = pack(base, true);
      const available = inputLimit - (baseline.estimatedInput - toolTokens(base));
      selection = {
        mode: 'discovery',
        tokenBudget: Math.min(options.maxToolTokens ?? Math.max(budget.toolTokens, toolTokens(base)), available),
        maxTools: budget.maxTools,
      };
      const business = new Map(full.filter((tool) => tool.key).map((tool) => [tool.key!, tool]));
      ({ keys, tools } = fitCandidates(base, business, candidateToolKeys(execution), selection));
      packed = pack(tools, true);
    }
    const estimatedInput = packed.estimatedInput + chainTokens;
    return {
      ...packed,
      tools,
      keys,
      selection,
      remote: state,
      estimatedInput,
      budget,
      outputLimit: Math.min(budget.outputLimit, budget.remaining - estimatedInput),
    };
  }

  try {
    if (remote) {
      try {
        return assemble(remote);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'AI_CONTEXT_TOO_LARGE') throw error;
      }
    }
    return assemble(null);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'AI_CONTEXT_TOO_LARGE' &&
      budget.inputLimit < budget.windowInputLimit
    )
      throw new Error('AI_BUDGET_EXCEEDED');
    throw error;
  }
}

/** 搜索加载与显式加载共用同一容量规则；返回值与 tool_keys 在动作回执事务中一起保存。 */
/**
 * 依据上轮已持久化的 tool_plan 装载搜索或显式请求的工具。
 * 显式加载要求所有完整定义都装下，否则拒绝并提示减少数量；搜索加载允许预算内部分命中。返回的 keys 由调用方与动作回执同事务保存，不在此更改运行状态。
 */
export function discoveredToolKeys(execution: Execution, requested: string[], explicit: boolean): string[] {
  const selection = execution.run.tool_plan;
  if (!selection) throw cageError('CONFLICT', '工具预算尚未装配，请重新发起任务');
  const full = toolsFor(execution, { keys: requested, discovery: false });
  const business = new Map(full.filter((tool) => tool.key).map((tool) => [tool.key!, tool]));
  const base = toolsFor(execution, { keys: [], discovery: true });
  const { keys } = fitCandidates(base, business, requested, selection);
  if (explicit && keys.length !== requested.length)
    throw cageError('INVALID_INPUT', '工具完整定义超出本轮上下文预算，请减少加载数量或配置更大的窗口');
  return keys;
}
