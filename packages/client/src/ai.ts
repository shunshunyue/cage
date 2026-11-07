import { useCallback, useEffect, useRef, useState } from 'react';
import { pageContextSchema, type PageContext, type AiSession, type AiRun, type AiEvent, type AiMemory, type AiMessageInput, type AiInteractionResponse, type AiModelConfig, type AiModelConfigInput, type AiModelProbe } from '@yss123/cage-ai-protocol';
import type { CageClient, CageResult, RequestOptions } from './index.js';
import { applyStreamEvent, streamState } from './ai-stream.js';
import type { AiPersonality, AiPersonalityAdmin, AiPersonalityCatalog, AiPersonalityInput, AiPersonalitySettings,
  AiPersonalityPreviewInput, AiPersonalityPreview, AiSessionInput } from '@yss123/cage-ai-protocol';
export type { AiPersonality, AiPersonalityFields, AiPersonalityAdmin, AiPersonalityCatalog, AiPersonalityInput, AiPersonalitySettings,
  AiPersonalitySummary, AiPersonalityPreviewInput, AiPersonalityPreview, AiPersonalityPreviewEvent, AiSessionInput } from '@yss123/cage-ai-protocol';
export type { AiProgress } from './ai-stream.js';
export type { PageContext, AiSession, AiRun, AiEvent, AiMemory, AiInteraction, AiMessageInput, AiInteractionResponse } from '@yss123/cage-ai-protocol';
export type { AiModelConfig, AiModelConfigInput, AiModelProbe } from '@yss123/cage-ai-protocol';
export interface ApprovalHistory {
  id: string; process: string; status: string; currentStep: number; createdAt: string; updatedAt: string;
  steps: { index: number; kind: 'human' | 'ai'; status: string; decision: { decision: 'pass' | 'return' | 'manual'; reason: string; suggestions: string[]; evidence: { source: string; detail: string }[] } | null; detailRestricted: boolean; actor: { kind: string; id: string } | null; updatedAt: string }[];
}
const pathId = (id: string) => encodeURIComponent(id);
const paused = (run: AiRun) => !['queued', 'running'].includes(run.status);
const data = async <T>(value: Promise<CageResult<T, string>>): Promise<T> => { const r = await value; if (!r.ok) throw Object.assign(new Error(r.code), { result: r }); return r.data; };

export class AiClient {
  constructor(readonly client: CageClient) {}
  models(options?: RequestOptions) { return this.client.get<AiModelConfig[]>('/api/ai/admin/models', undefined, options); }
  saveModel(key: string, input: AiModelConfigInput, options?: RequestOptions) { return this.client.post<AiModelConfig, 'CONFLICT'>(`/api/ai/admin/models/${pathId(key)}`, input, options); }
  testModel(key: string, options?: RequestOptions) { return this.client.post<AiModelProbe>(`/api/ai/admin/models/${pathId(key)}/test`, {}, options); }
  personalities(options?: RequestOptions) { return this.client.get<AiPersonalityCatalog>('/api/ai/personalities', undefined, options); }
  personalitySettings(options?: RequestOptions) { return this.client.get<AiPersonalityAdmin>('/api/ai/admin/personalities', undefined, options); }
  savePersonality(key: string, input: AiPersonalityInput, options?: RequestOptions) { return this.client.post<AiPersonality, 'CONFLICT'>(`/api/ai/admin/personalities/${pathId(key)}`, input, options); }
  savePersonalitySettings(input: AiPersonalitySettings, options?: RequestOptions) { return this.client.post<AiPersonalitySettings, 'CONFLICT'>('/api/ai/admin/assistant-settings', input, options); }
  previewPersonality(input: AiPersonalityPreviewInput, options?: RequestOptions) { return this.client.post<AiPersonalityPreview>('/api/ai/admin/personality-preview', input, { timeoutMs: 25_000, ...options }); }
  selectPersonality(sessionId: string, input: { key: string | null; version: number }, options?: RequestOptions) { return this.client.post<AiSession, 'CONFLICT' | 'NOT_FOUND'>(`/api/ai/sessions/${pathId(sessionId)}/personality`, input, options); }
  sessions(options?: RequestOptions) { return this.client.get<AiSession[]>('/api/ai/sessions', undefined, options); }
  createSession(input?: string | AiSessionInput, options?: RequestOptions) { return this.client.post<AiSession>('/api/ai/sessions', typeof input === 'string' ? { title: input } : input ?? {}, options); }
  runs(sessionId: string, options?: RequestOptions) { return this.client.get<AiRun[]>(`/api/ai/sessions/${pathId(sessionId)}/runs`, undefined, options); }
  send(sessionId: string, input: AiMessageInput, options?: RequestOptions) { return this.client.post<AiRun, 'CONFLICT' | 'NOT_FOUND'>(`/api/ai/sessions/${pathId(sessionId)}/messages`, input, options); }
  run(id: string, options?: RequestOptions) { return this.client.get<AiRun>(`/api/ai/runs/${pathId(id)}`, undefined, options); }
  cancel(id: string, options?: RequestOptions) { return this.client.post<AiRun, 'NOT_FOUND'>(`/api/ai/runs/${pathId(id)}/cancel`, {}, options); }
  respond(id: string, interactionId: string, response: AiInteractionResponse, options?: RequestOptions) { return this.client.post<AiRun, 'CONFLICT' | 'NOT_FOUND'>(`/api/ai/runs/${pathId(id)}/interactions/${pathId(interactionId)}`, response, options); }
  events(id: string, after = 0, options?: RequestOptions) { return this.client.get<AiEvent[]>(`/api/ai/runs/${pathId(id)}/events`, { after }, options); }
  memories(options?: RequestOptions) { return this.client.get<AiMemory[]>('/api/ai/memory', undefined, options); }
  deleteMemory(id: string, options?: RequestOptions) { return this.client.delete<{ ok: true }>(`/api/ai/memory/${pathId(id)}`, options); }

  /** SSE 断线按事件序号续传；等待用户或完成时返回。UI 自行决定文本、卡片、按钮的呈现。 */
  async watch(id: string, onEvent: (event: AiEvent) => void, options: RequestOptions & { after?: number } = {}): Promise<AiRun> {
    const controller = new AbortController();
    const stop = this.client.subscribe((_session, reason) => { if (reason !== 'loaded') controller.abort(); });
    try { return await this.watchRun(id, onEvent, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }); }
    finally { stop(); }
  }
  private async watchRun(id: string, onEvent: (event: AiEvent) => void, options: RequestOptions & { after?: number }): Promise<AiRun> {
    let cursor = options.after ?? 0, failures = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        const result = await this.client.stream(`/api/ai/runs/${pathId(id)}/events`, { after: cursor }, async body => {
          const reader = body.getReader(), decoder = new TextDecoder();
          let buffer = '';
          try {
            for (;;) {
              const chunk = await reader.read(); if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              if (buffer.length > 1_000_000) throw new Error('AI event is too large');
              let boundary: RegExpExecArray | null;
              while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
                const value = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (!value) continue;
                const event = JSON.parse(value) as AiEvent;
                options.signal?.throwIfAborted();
                if (event.runId !== id || !Number.isSafeInteger(event.sequence)) throw new Error('Invalid AI event');
                if (event.sequence > cursor) { onEvent(event); cursor = event.sequence; }
              }
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }, options);
        if (!result.ok) throw Object.assign(new Error(result.code), { result });
        const run = await data(this.run(id, options));
        if (paused(run)) {
          // 最后一个事件可能在断线瞬间提交；拉空分页后再交付终态。
          for (;;) {
            const remaining = await data(this.events(id, cursor, options));
            for (const event of remaining) { if (event.sequence > cursor) { onEvent(event); cursor = event.sequence; } }
            if (remaining.length < 200) break;
          }
          return run;
        }
        failures = 0;
      } catch (error: any) {
        // 网络中断也可能发生在读取终态或补取事件时，恢复仍从最后交付的序号继续。
        if (!['NETWORK', 'TIMEOUT'].includes(error.result?.code) || ++failures > 5) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        options.signal?.throwIfAborted();
        const abort = () => { clearTimeout(timer); reject(new Error('CANCELLED')); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, Math.min(3000, 250 * 2 ** failures));
        options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

export type PageContextInput = Omit<PageContext, 'pageInstanceId' | 'revision' | 'capturedAt'>;
/** 每个页面实例持有自己的上下文，发送时复制；不会用后来的标签页覆盖已发送消息。 */
export class AiPageContext {
  private revision = 0;
  private value: PageContextInput;
  readonly pageInstanceId = globalThis.crypto.randomUUID();
  constructor(value: PageContextInput) { this.value = structuredClone(value); }
  update(value: PageContextInput): void {
    if (JSON.stringify(value) !== JSON.stringify(this.value)) { this.value = structuredClone(value); this.revision++; }
  }
  snapshot(): PageContext { return pageContextSchema.parse({ ...structuredClone(this.value), pageInstanceId: this.pageInstanceId, revision: this.revision, capturedAt: new Date().toISOString() }); }
}
export function useAiPageContext(value: PageContextInput): AiPageContext {
  const page = useRef<AiPageContext | null>(null);
  if (!page.current) page.current = new AiPageContext(value);
  page.current.update(value);
  return page.current;
}

/** 只提供状态和动作，不生成或接管业务页面。可以用 React 组件、设计系统或编程 AI 自行构建 UI。 */
export function useAssistant(ai: AiClient, page?: AiPageContext) {
  const [session, setSession] = useState<AiSession | null>(null), [live, setLive] = useState(() => streamState());
  const run = live.run;
  const [events, setEvents] = useState<AiEvent[]>([]), [error, setError] = useState<Error | null>(null), [busy, setBusy] = useState(false);
  const current = useRef<AbortController | null>(null), sessionRef = useRef<AiSession | null>(null);
  const cursor = useRef({ runId: '', sequence: 0 });
  const [catalog, setCatalog] = useState<AiPersonalityCatalog | null>(null), [personalityKey, setPersonalityKey] = useState<string | null>(null);
  const [personalityBusy, setPersonalityBusy] = useState(false), [personalityError, setPersonalityError] = useState<Error | null>(null);
  const selection = useRef<string | null>(null), selectionRequest = useRef<AbortController | null>(null), catalogRequest = useRef<AbortController | null>(null);
  const refreshPersonalities = useCallback(async () => {
    catalogRequest.current?.abort(); const controller = new AbortController(); catalogRequest.current = controller;
    try {
      const result = await data(ai.personalities({ signal: controller.signal }));
      if (!controller.signal.aborted) { setCatalog(result); setPersonalityError(null); }
    } catch (error) { if (!controller.signal.aborted) setPersonalityError(error as Error); }
    finally { if (catalogRequest.current === controller) catalogRequest.current = null; }
  }, [ai]);
  useEffect(() => {
    void refreshPersonalities();
    const unsubscribe = ai.client.subscribe((_snapshot, reason) => {
      if (reason === 'loaded') { void refreshPersonalities(); return; }
      current.current?.abort(); current.current = null; sessionRef.current = null;
      catalogRequest.current?.abort(); selectionRequest.current?.abort(); selectionRequest.current = null;
      selection.current = null; setPersonalityKey(null); setCatalog(null); setPersonalityBusy(false); setPersonalityError(null);
      cursor.current = { runId: '', sequence: 0 };
      setSession(null); setLive(streamState()); setEvents([]); setError(null); setBusy(false);
    });
    return () => { current.current?.abort(); catalogRequest.current?.abort(); selectionRequest.current?.abort(); unsubscribe(); };
  }, [ai, refreshPersonalities]);
  const follow = async (pending: AiRun, controller: AbortController) => {
    if (cursor.current.runId !== pending.id) cursor.current = { runId: pending.id, sequence: 0 };
    setLive(previous => previous.run?.id === pending.id ? { ...previous, run: pending, progress: { ...previous.progress, stage: streamState(pending).progress.stage } } : streamState(pending));
    const result = await ai.watch(pending.id, event => {
      if (controller.signal.aborted) return;
      cursor.current.sequence = event.sequence;
      setLive(previous => applyStreamEvent(previous, event));
      setEvents(previous => [...previous, event].slice(-1000));
    }, { signal: controller.signal, after: cursor.current.sequence });
    if (!controller.signal.aborted) setLive(previous => ({ ...previous, run: result, text: result.answer ?? previous.text,
      progress: { ...previous.progress, stage: streamState(result).progress.stage } }));
    return result;
  };
  const perform = async (work: (controller: AbortController) => Promise<AiRun>) => {
    if (current.current || selectionRequest.current) throw new Error('已有操作正在进行');
    const controller = new AbortController(); current.current = controller; setBusy(true); setError(null);
    try { return await work(controller); }
    catch (e) { if (!controller.signal.aborted) setError(e as Error); throw e; }
    finally { if (current.current === controller) { current.current = null; setBusy(false); } }
  };
  return { session, run, events, error, busy, streamingText: live.text, progress: live.progress,
    personalities: catalog?.items ?? [], personalityKey, personalityBusy, personalityError, refreshPersonalities,
    defaultPersonalityKey: catalog?.defaultKey,
    personality: catalog?.items.find(p => p.key === (personalityKey ?? catalog.defaultKey)) ?? null,
    setPersonality: async (key: string | null) => {
      if (current.current || selectionRequest.current) throw new Error('请等待当前操作完成');
      if (key !== null && !catalog?.items.some(p => p.key === key)) throw new Error('该性格不可用，请刷新后重试');
      const controller = new AbortController(); selectionRequest.current = controller; setPersonalityBusy(true); setPersonalityError(null);
      try {
        if (sessionRef.current) {
          const saved = await data(ai.selectPersonality(sessionRef.current.id, { key, version: sessionRef.current.personalityVersion }, { signal: controller.signal }));
          if (controller.signal.aborted) return;
          sessionRef.current = saved; setSession(saved);
        }
        selection.current = key; setPersonalityKey(key);
      } catch (error) { if (!controller.signal.aborted) setPersonalityError(error as Error); throw error; }
      finally { if (selectionRequest.current === controller) { selectionRequest.current = null; setPersonalityBusy(false); } }
    },
    send: (message: string) => {
      const pageContext = page?.snapshot();
      return perform(async controller => {
        setLive(streamState()); setEvents([]); cursor.current = { runId: '', sequence: 0 };
        if (!sessionRef.current) {
          const created = await data(ai.createSession({ personalityKey: selection.current }, { signal: controller.signal }));
          if (controller.signal.aborted) throw new Error('CANCELLED');
          sessionRef.current = created; setSession(created);
        }
        return follow(await data(ai.send(sessionRef.current.id, { message, pageContext }, { signal: controller.signal })), controller);
      });
    },
    respond: (interactionId: string, response: AiInteractionResponse) => perform(async controller => {
      if (!run) throw new Error('没有待回复的任务');
      return follow(await data(ai.respond(run.id, interactionId, response, { signal: controller.signal })), controller);
    }),
    cancel: async () => {
      if (!run) { current.current?.abort(); return; }
      const result = await data(ai.cancel(run.id)); current.current?.abort();
      setLive(previous => ({ ...previous, run: result, progress: { ...previous.progress, stage: 'done' } })); return result;
    },
  };
}
