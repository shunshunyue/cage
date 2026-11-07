import { runStatusSchema, type AiEvent, type AiRun } from '@yss123/cage-ai-protocol';

export interface AiProgress {
  stage: 'idle' | 'queued' | 'context' | 'model' | 'tool' | 'waiting' | 'done';
  step: number;
  tool: string | null;
  toolName: string | null;
  toolState: 'running' | 'completed' | 'failed' | null;
}
export interface AiStreamState { run: AiRun | null; text: string; sequence: number; progress: AiProgress }
export function streamState(run: AiRun | null = null): AiStreamState {
  const stage = !run ? 'idle' : run.status === 'queued' ? 'queued' : run.status === 'running' ?
    run.phase === 'context' ? 'context' : run.phase === 'actions' ? 'tool' : 'model' : run.status.startsWith('waiting_') ? 'waiting' : 'done';
  return { run, text: run?.answer ?? '', sequence: 0,
    progress: { stage, step: run?.steps ?? 0, tool: null, toolName: null, toolState: null } };
}

/** 文本单独累积，不从有限长度的调试事件列表重建，长回复和断线续传都不会丢开头。 */
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
