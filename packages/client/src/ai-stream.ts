/**
 * 把服务端 AI 顺序事件归并为前端运行、文本和进度状态。
 * useAssistant 使用纯状态转换更新界面；本模块不发网络请求、不持久化历史，完整文本独立于有界调试事件列表保存，重连通过 sequence 去重。
 */
import { runStatusSchema, type AiEvent, type AiRun } from '@yss123/cage-ai-protocol';

/**
 * 业务界面可直接展示的运行进度摘要。
 * stage 描述当前阶段而非百分比，tool 字段只代表最近工具，不是全部历史或业务事务完成证明。
 */
export interface AiProgress {
  /**
   * 当前展示阶段：空闲、排队、上下文、模型、工具、等待或结束。
   */
  stage: 'idle' | 'queued' | 'context' | 'model' | 'tool' | 'waiting' | 'done';
  /**
   * 当前模型步骤编号，用于防止旧步骤文本混入新输出。
   */
  step: number;
  /**
   * 最近执行工具的协议名称，尚无工具时为 null。
   */
  tool: string | null;
  /**
   * 可选业务可读名称，例如命令能力名；基础工具可能没有名称。
   */
  toolName: string | null;
  /**
   * 最近工具正在执行、已完成或失败；无工具时为 null。
   */
  toolState: 'running' | 'completed' | 'failed' | null;
}
/**
 * 一个运行的前端流状态；文本、最后序号和进度独立保存，使事件展示列表裁剪不丢失长回复。
 */
export interface AiStreamState { /** 当前服务端运行快照；null 表示未开始本轮。 */ run: AiRun | null; /** 当前模型步骤累积文字或最终答案，不从调试事件列表重建。 */ text: string; /** 已归并的最大事件序号，用于重复/乱序过滤。 */ sequence: number; /** 当前阶段和工具的界面摘要。 */ progress: AiProgress }
/**
 * 从可选运行快照初始化展示状态，无运行时为空闲。
 * 用状态/阶段推导进度并以最终 answer 初始化文本；sequence 从 0 开始，外部续传游标由订阅方管理。
 */
export function streamState(run: AiRun | null = null): AiStreamState {
  const stage = !run ? 'idle' : run.status === 'queued' ? 'queued' : run.status === 'running' ?
    run.phase === 'context' ? 'context' : run.phase === 'actions' ? 'tool' : 'model' : run.status.startsWith('waiting_') ? 'waiting' : 'done';
  return { run, text: run?.answer ?? '', sequence: 0,
    progress: { stage, step: run?.steps ?? 0, tool: null, toolName: null, toolState: null } };
}

/** 文本单独累积，不从有限长度的调试事件列表重建，长回复和断线续传都不会丢开头。 */
/**
 * 只处理当前运行且序号严格更新的事件，返回新状态而不修改输入对象。
 * 模型新步骤清空上一段文本，旧步骤增量忽略；message.completed 用完整最终文本校准，工具与互动事件更新进度及待处理卡片。
 * 事件列表可以仅保留近期调试信息，文本在此独立累积；未知事件仍推进序号，不能根据未识别事件臆测业务结果。
 */
export function applyStreamEvent(state: AiStreamState, event: AiEvent): AiStreamState {
  if (!state.run || event.runId !== state.run.id || event.sequence <= state.sequence) return state;
  const data = (event.data ?? {}) as Record<string, any>;
  let run = { ...state.run, updatedAt: event.createdAt }, text = state.text, progress = { ...state.progress };
  switch (event.type) {
    case 'run.status': {
      const parsed = runStatusSchema.safeParse(data.status);
      if (parsed.success) {
        run.status = parsed.data;
        if (run.status !== 'running') progress.stage = run.status === 'queued' ? 'queued' : run.status.startsWith('waiting_') ? 'waiting' : 'done';
        else if (progress.stage === 'queued') progress.stage = run.phase === 'context' ? 'context' : 'model';
      }
      break;
    }
    case 'context.updated': run.phase = 'model'; progress.stage = 'context'; break;
    case 'model.started':
      run.phase = 'model'; run.steps = data.step; text = '';
      progress = { stage: 'model', step: data.step, tool: null, toolName: null, toolState: null };
      break;
    case 'message.delta': {
      const step = typeof data.step === 'number' ? data.step : progress.step;
      if (step < progress.step || typeof data.text !== 'string') break;
      text = (step > progress.step ? '' : text) + data.text;
      run.steps = Math.max(run.steps, step);
      progress = { stage: 'model', step, tool: null, toolName: null, toolState: null };
      break;
    }
    case 'message.completed':
      if (typeof data.text === 'string') { text = data.text; run.answer = text; }
      run.phase = 'done'; progress.stage = 'done'; break;
    case 'tool.started':
      run.phase = 'actions';
      progress = { ...progress, stage: 'tool', tool: data.tool, toolName: data.name ?? null, toolState: 'running' };
      break;
    case 'tool.completed':
      run.toolCalls = typeof data.toolCalls === 'number' ? data.toolCalls : run.toolCalls + 1;
      progress = { ...progress, stage: 'tool', tool: data.tool, toolState: data.ok === false ? 'failed' : 'completed' };
      break;
    case 'interaction.required':
      progress.stage = 'waiting';
      if (typeof data.expiresAt === 'string') run.interactions = [{ id: data.id, kind: data.kind, prompt: data.prompt, data: data.data, expiresAt: data.expiresAt }];
      break;
  }
  return { run, text, progress, sequence: event.sequence };
}
