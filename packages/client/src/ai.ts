/**
 * 提供 AI HTTP 客户端、可续传事件订阅、页面上下文快照和 React 助理状态。
 * 所有请求复用 CageClient 的会话、CSRF、取消与结果契约；只依赖浏览器协议，不导入 AI 服务端运行时，界面和业务路由由应用自行组合。
 */
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
/**
 * 可读业务对象的审批历史 DTO；steps 包含人工/AI 节点、可见裁决与执行者摘要。
 * detailRestricted 为 true 时意味着详细理由受限，decision 为 null 也可能尚未裁决，不能据此推断流程不存在。步骤 index/currentStep 均对应服务端步骤位置。
 */
export interface ApprovalHistory {
  /** 全部活跃节点；currentStep 仅是最小活跃索引的兼容摘要，不能推断其他分支已完成。 */
  currentSteps?: number[];
  /** 启动时路由内容指纹；旧实例为 null，不表示支持在途迁移。 */
  definitionVersion?: string | null;
  /**
   * 审批实例 ID，用于区分同一单据的历史轮次。
   */
  id: string; /** 已声明审批流程标识。 */ process: string; /** 当前审批实例状态，保留服务端协议字符串。 */ status: string; /** 当前步骤位置，采用服务端零基索引。 */ currentStep: number; /** 实例创建 UTC 时间。 */ createdAt: string; /** 实例最近更新时间。 */ updatedAt: string;
  /**
   * 步骤摘要列表；title 是提交时节点标题，兼容旧服务端时可能缺省，不按最新路由猜测历史节点。
   * dueAt 为节点总办理截止时间（UTC），旧轮次或未设时限为空；AI decision 可能因未决或权限受限为空，详细证据可见性以 detailRestricted 为准。
   */
  steps: { index: number; title?: string; branchPath?: { parallel: string; branch: string }[]; dependsOn?: number[]; dueAt?: string | null; kind: 'human' | 'ai'; status: string; decision: { decision: 'pass' | 'return' | 'manual'; reason: string; suggestions: string[]; evidence: { source: string; detail: string }[] } | null; detailRestricted: boolean; actor: { kind: string; id: string } | null; updatedAt: string }[];
}
/**
 * 编码单个 URL 路径参数，避免会话、运行或模型 key 中的字符改变请求路径。
 */
const pathId = (id: string) => encodeURIComponent(id);
/**
 * 判断运行是否应停止当前自动跟随：排队和执行继续，等待互动及任一终态均返回控制权给界面。
 */
const paused = (run: AiRun) => !['queued', 'running'].includes(run.status);
/**
 * 将 CageResult Promise 转为成功数据或带完整 result 的异常，供异步订阅与 hooks 使用。
 * 失败不会被当作已完成操作，调用方仍可从 result 读取稳定错误码和请求诊断。
 */
const data = async <T>(value: Promise<CageResult<T, string>>): Promise<T> => { const r = await value; if (!r.ok) throw Object.assign(new Error(r.code), { result: r }); return r.data; };

/**
 * AI 协议客户端，薄封装保持 CageResult 返回值并复用宿主会话。
 * 模型/性格管理仍由服务端授权；send 只接受排队任务，watch 才持续取得事件和等待/终态，不直接决定业务展示。
 */
export class AiClient {
  /**
   * 绑定一个 CageClient 实例，以隔离不同服务地址或登录会话的网络和取消状态。
   */
  constructor(readonly client: CageClient) {}
  /**
   * 读取本租户已声明模型配置摘要；响应不包含 API Key，服务端要求模型管理能力。
   */
  models(options?: RequestOptions) { return this.client.get<AiModelConfig[]>('/api/ai/admin/models', undefined, options); }
  /**
   * 按 key 和输入版本保存模型配置，服务端加密凭据并审计；版本冲突通过 CageResult 返回，不自动覆盖。
   */
  saveModel(key: string, input: AiModelConfigInput, options?: RequestOptions) { return this.client.post<AiModelConfig, 'CONFLICT'>(`/api/ai/admin/models/${pathId(key)}`, input, options); }
  /**
   * 测试已保存模型的基础连通性，返回稳定代码和延迟；成功不保证业务推理、工具调用或接续能力。
   */
  testModel(key: string, options?: RequestOptions) { return this.client.post<AiModelProbe>(`/api/ai/admin/models/${pathId(key)}/test`, {}, options); }
  /**
   * 读取普通助理用户可选择的启用性格摘要及默认项，不读取管理用完整提示词配置。
   */
  personalities(options?: RequestOptions) { return this.client.get<AiPersonalityCatalog>('/api/ai/personalities', undefined, options); }
  /**
   * 读取性格管理目录与默认设置，包含完整配置和版本，服务端要求独立管理能力。
   */
  personalitySettings(options?: RequestOptions) { return this.client.get<AiPersonalityAdmin>('/api/ai/admin/personalities', undefined, options); }
  /**
   * 按 key 保存性格配置，输入版本用于冲突检测；不会改写已提交运行的性格快照。
   */
  savePersonality(key: string, input: AiPersonalityInput, options?: RequestOptions) { return this.client.post<AiPersonality, 'CONFLICT'>(`/api/ai/admin/personalities/${pathId(key)}`, input, options); }
  /**
   * 以设置版本保存租户默认性格；目标启用检查和并发保护由服务端执行。
   */
  savePersonalitySettings(input: AiPersonalitySettings, options?: RequestOptions) { return this.client.post<AiPersonalitySettings, 'CONFLICT'>('/api/ai/admin/assistant-settings', input, options); }
  /**
   * 用未保存的性格草稿请求一次 JSON 试聊，默认请求超时 25 秒，可由 options 覆盖。
   * 试聊无业务工具或会话历史，不创建正式助理运行。
   */
  previewPersonality(input: AiPersonalityPreviewInput, options?: RequestOptions) { return this.client.post<AiPersonalityPreview>('/api/ai/admin/personality-preview', input, { timeoutMs: 25_000, ...options }); }
  /**
   * 按会话选择版本切换指定 key 或默认项，服务端验证本人归属；返回新版本，只影响后续消息。
   */
  selectPersonality(sessionId: string, input: { key: string | null; version: number }, options?: RequestOptions) { return this.client.post<AiSession, 'CONFLICT' | 'NOT_FOUND'>(`/api/ai/sessions/${pathId(sessionId)}/personality`, input, options); }
  /**
   * 列出本人近期助理会话；不是租户管理员的跨用户检索入口。
   */
  sessions(options?: RequestOptions) { return this.client.get<AiSession[]>('/api/ai/sessions', undefined, options); }
  /**
   * 创建本人助理会话；兼容字符串标题，也接受标题与性格选择对象，省略时使用服务端默认值。
   */
  createSession(input?: string | AiSessionInput, options?: RequestOptions) { return this.client.post<AiSession>('/api/ai/sessions', typeof input === 'string' ? { title: input } : input ?? {}, options); }
  /**
   * 读取本人会话的近期运行快照，服务端重新核对授权与注册表指纹。
   */
  runs(sessionId: string, options?: RequestOptions) { return this.client.get<AiRun[]>(`/api/ai/sessions/${pathId(sessionId)}/runs`, undefined, options); }
  /**
   * 提交消息和已捕获页面快照，返回已排队 AiRun。
   * 底层 POST 携带幂等键，调用方跨请求重试可显式复用同一键；接受提交不代表模型或业务写已完成。
   */
  send(sessionId: string, input: AiMessageInput, options?: RequestOptions) { return this.client.post<AiRun, 'CONFLICT' | 'NOT_FOUND'>(`/api/ai/sessions/${pathId(sessionId)}/messages`, input, options); }
  /**
   * 读取运行状态和待处理互动；状态取自服务端，不通过客户端文本推断成功。
   */
  run(id: string, options?: RequestOptions) { return this.client.get<AiRun>(`/api/ai/runs/${pathId(id)}`, undefined, options); }
  /**
   * 请求服务端取消运行；成功后阻止后续执行，不撤销先前已提交的业务命令。
   */
  cancel(id: string, options?: RequestOptions) { return this.client.post<AiRun, 'NOT_FOUND'>(`/api/ai/runs/${pathId(id)}/cancel`, {}, options); }
  /**
   * 回复确认、补充输入或页面更新互动，返回重新排队或当前运行快照；服务端验证互动类型、期限及页面版本。
   */
  respond(id: string, interactionId: string, response: AiInteractionResponse, options?: RequestOptions) { return this.client.post<AiRun, 'CONFLICT' | 'NOT_FOUND'>(`/api/ai/runs/${pathId(id)}/interactions/${pathId(interactionId)}`, response, options); }
  /**
   * 读取 after 序号之后的一页事件；默认从 0 开始，服务端至多返回 200 条，需继续分页才表示追平。
   */
  events(id: string, after = 0, options?: RequestOptions) { return this.client.get<AiEvent[]>(`/api/ai/runs/${pathId(id)}/events`, { after }, options); }
  /**
   * 读取本人已保存偏好，不把这些内容解释为授权或业务事实。
   */
  memories(options?: RequestOptions) { return this.client.get<AiMemory[]>('/api/ai/memory', undefined, options); }
  /**
   * 删除本人偏好；归属检查由服务端执行，成功结果仅表示删除请求完成。
   */
  deleteMemory(id: string, options?: RequestOptions) { return this.client.delete<{ ok: true }>(`/api/ai/memory/${pathId(id)}`, options); }

  /** SSE 断线按事件序号续传；等待用户或完成时返回。UI 自行决定文本、卡片、按钮的呈现。 */
  /**
   * 订阅运行直到等待用户或终态，并在会话退出、切换或重配置时取消。
   * loaded 刷新不会中断跟随；finally 解除会话监听，事件展示由 onEvent 调用方负责。
   */
  async watch(id: string, onEvent: (event: AiEvent) => void, options: RequestOptions & { after?: number } = {}): Promise<AiRun> {
    const controller = new AbortController();
    const stop = this.client.subscribe((_session, reason) => { if (reason !== 'loaded') controller.abort(); });
    try { return await this.watchRun(id, onEvent, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }); }
    finally { stop(); }
  }
  /**
   * 从最后成功交付的事件序号读取 SSE，校验运行 ID/整数序号并去重；每个未解析缓冲最多 1000000 字符。
   * 连接结束后读取运行状态，等待/终态仍补取事件至空页再返回；网络/超时最多连续恢复 5 次，指数退避不超过 3 秒。
   * 每次流读取都取消并释放 reader；外部取消中断退避与请求，权限错误等非网络失败直接抛出。
   */
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

/**
 * 应用提供的页面意图、对象定位和草稿内容，不包含实例 ID、递增版本或采集时间；这些由 AiPageContext 统一生成。
 */
export type PageContextInput = Omit<PageContext, 'pageInstanceId' | 'revision' | 'capturedAt'>;
/** 每个页面实例持有自己的上下文，发送时复制；不会用后来的标签页覆盖已发送消息。 */
/**
 * 每个页面实例独立的上下文容器，保存输入副本并追踪内容变化。
 * 发送时再复制为带实例 ID/版本/时间的快照，防止其他标签页或后续编辑覆盖已发消息；服务端仍重新读取真正业务事实。
 */
export class AiPageContext {
  /**
   * 页面内容变更计数，从 0 开始，与领域对象 version 分开。
   */
  private revision = 0;
  /**
   * 内部保存的页面输入副本，避免外部直接修改影响已知版本。
   */
  private value: PageContextInput;
  /**
   * 此页面容器唯一 UUID，服务端用它拒绝其他页面实例的更新快照。
   */
  readonly pageInstanceId = globalThis.crypto.randomUUID();
  /**
   * 复制页面初始输入，不共享调用方可变对象；实例 ID 在对象创建时生成。
   */
  constructor(value: PageContextInput) { this.value = structuredClone(value); }
  /**
   * 用 JSON 表示比较页面输入，发生变化时复制新值并递增 revision。
   * 仅追踪协议可序列化内容，版本说明页面变化，不代表数据库业务版本。
   */
  update(value: PageContextInput): void {
    if (JSON.stringify(value) !== JSON.stringify(this.value)) { this.value = structuredClone(value); this.revision++; }
  }
  /**
   * 复制当前页面输入并附加实例 ID、当前 revision 和 UTC 采集时间，再用协议 schema 校验后返回。
   * 快照属于此次发送，后续 update 不会改变它。
   */
  snapshot(): PageContext { return pageContextSchema.parse({ ...structuredClone(this.value), pageInstanceId: this.pageInstanceId, revision: this.revision, capturedAt: new Date().toISOString() }); }
}
/**
 * 在 React 组件生命周期内保持同一个页面上下文实例，并在每次渲染时更新内容。
 * 应用应让不同实际页面实例分别持有此 hook，不能把全局单例用于所有标签页。
 */
export function useAiPageContext(value: PageContextInput): AiPageContext {
  const page = useRef<AiPageContext | null>(null);
  if (!page.current) page.current = new AiPageContext(value);
  page.current.update(value);
  return page.current;
}

/** 只提供状态和动作，不生成或接管业务页面。可以用 React 组件、设计系统或编程 AI 自行构建 UI。 */
/**
 * 组合会话、运行、流式文本、进度、互动和性格选择状态，返回操作函数供应用 UI 使用。
 * 发送前同步捕获页面快照，首次发送才建会话；同一时刻只允许一个运行操作或性格切换，选择版本冲突交由界面处理。
 * 事件调试列表只保留最近 1000 条，全文独立累积；会话切换与卸载取消本地请求并清空相关状态，取消动作先通知服务端再中止跟随。
 * 该 hook 不生成页面、不自动批准写入，也不管理跨页面的全量聊天存档。
 */
export function useAssistant(ai: AiClient, page?: AiPageContext) {
  const [session, setSession] = useState<AiSession | null>(null), [live, setLive] = useState(() => streamState());
  const run = live.run;
  const [events, setEvents] = useState<AiEvent[]>([]), [error, setError] = useState<Error | null>(null), [busy, setBusy] = useState(false);
  const current = useRef<AbortController | null>(null), sessionRef = useRef<AiSession | null>(null);
  const cursor = useRef({ runId: '', sequence: 0 });
  const [catalog, setCatalog] = useState<AiPersonalityCatalog | null>(null), [personalityKey, setPersonalityKey] = useState<string | null>(null);
  const [personalityBusy, setPersonalityBusy] = useState(false), [personalityError, setPersonalityError] = useState<Error | null>(null);
  const selection = useRef<string | null>(null), selectionRequest = useRef<AbortController | null>(null), catalogRequest = useRef<AbortController | null>(null);
  // 后一次刷新取消前一次，防止迟到目录覆盖当前选择；退出/卸载也中止这一独立请求，不占正式运行的控制器。
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
  // 同运行沿用已交付游标，不同运行从 0 开始；事件列表裁剪只用于调试，正文由 reducer 独立累积并最终校准。
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
  // 串行化发送/回复与性格选择；finally 仅清理自己仍持有的控制器，避免旧请求覆盖会话切换后的新状态。
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
    /** 选择启用性格；已有会话按选择版本提交，尚未建会话则仅保存下一次创建意图，null 表示跟随租户默认项。 */
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
    /** 同步冻结本次页面快照，再创建必要会话、提交消息并跟随运行；后续页面编辑不会覆盖已提交快照。 */
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
    /** 回复当前运行互动并继续跟随；不存在当前运行直接失败，服务端仍校验互动归属、版本和期限。 */
    respond: (interactionId: string, response: AiInteractionResponse) => perform(async controller => {
      if (!run) throw new Error('没有待回复的任务');
      return follow(await data(ai.respond(run.id, interactionId, response, { signal: controller.signal })), controller);
    }),
    /** 有运行时先完成服务器取消再停止本地订阅；尚未取得运行时只取消本地请求，不假定服务器任务一定不存在。 */
    cancel: async () => {
      if (!run) { current.current?.abort(); return; }
      const result = await data(ai.cancel(run.id)); current.current?.abort();
      setLive(previous => ({ ...previous, run: result, progress: { ...previous.progress, stage: 'done' } })); return result;
    },
  };
}
