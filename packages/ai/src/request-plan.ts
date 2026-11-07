import { cageError } from '@yss123/cage-kernel';
import { modelBudget, checkModelBudget, type ModelBudget } from './budget.js';
import { SYSTEM_PROMPT, ONTOLOGY_PROMPT, DISCOVERY_PROMPT } from './context.js';
import { personalityPrompt } from './personalities.js';
import { packPrompt, toolTokens } from './prompt.js';
import { remoteHistory, type RemoteHistory, type ToolPlan } from './state.js';
import { authorizedToolKeys, candidateToolKeys } from './tool-catalog.js';
import { toolsFor, type Tool } from './tools.js';
import type { AiContextOptions, Execution, ModelMessage, ModelProvider } from './types.js';

export interface ModelPlan {
  messages: ModelMessage[];
  tools: Tool[];
  keys: string[];
  selection: ToolPlan;
  remote: RemoteHistory | null;
  estimatedInput: number;
  outputLimit: number;
  reduced: boolean;
  budget: ModelBudget;
}

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
