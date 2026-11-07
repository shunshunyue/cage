// 组件只消费框架 SDK；页面显式传入语义上下文，业务事实与写权限由服务端核验。
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client, AiPageContext, useAssistant, type PageContextInput, type AiRun } from '@yss123/cage-client';
import { AssistantMarkdown } from './assistant-markdown';
import './assistant-panel.css';

const captions: Record<string, string> = {
  queued: '等待处理', running: '正在核对页面与业务规则', waiting_confirmation: '等待你确认操作',
  waiting_input: '需要补充信息', succeeded: '本轮已完成', failed: '本轮执行失败', expired: '本轮已超时', cancelled: '已停止',
};
const toolLabels: Record<string, string> = {
  ontology_search: '查询业务规则', data_get: '读取单据', data_list: '查询业务数据', data_related: '查询关联记录',
  data_query: '汇总业务数据', approval_history: '查询审批进度', approval_tasks: '查询审批待办',
  approval_decide: '处理审批', request_input: '补充必要信息', request_page_context: '更新页面内容', memory_remember: '保存偏好',
};
function AssistantMark() {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M7 6h18a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H14l-7 4v-4a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="m16 10 1.5 4.5L22 16l-4.5 1.5L16 22l-1.5-4.5L10 16l4.5-1.5L16 10Z" fill="currentColor" /></svg>;
}
export function AssistantPanel({ context, suggestions, pageKey, fieldLabels = {}, commandLabels = {} }: {
  context: PageContextInput; suggestions: string[]; pageKey: string; fieldLabels?: Record<string, string>; commandLabels?: Record<string, string>;
}) {
  // 会话属于工作台，页面身份属于一次导航；新的页面不能覆盖已经发送的快照。
  const pageRef = useRef<{ key: string; value: AiPageContext } | null>(null);
  if (pageRef.current?.key !== pageKey) pageRef.current = { key: pageKey, value: new AiPageContext(context) };
  pageRef.current.value.update(context);
  const page = pageRef.current.value, assistant = useAssistant(client.ai, page), cache = useQueryClient();
  const [open, setOpen] = useState(false), [unread, setUnread] = useState(false);
  const launcher = useRef<HTMLButtonElement | null>(null), composer = useRef<HTMLTextAreaElement | null>(null), closeButton = useRef<HTMLButtonElement | null>(null);
  const sentPage = useRef({ instanceId: '', title: '', fieldLabels, commandLabels });
  const [input, setInput] = useState(''), [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string; page?: string; name?: string }[]>([]);
  const [failure, setFailure] = useState('');
  const scrollArea = useRef<HTMLDivElement | null>(null), followOutput = useRef(true);
  const [showLatest, setShowLatest] = useState(false), [elapsed, setElapsed] = useState(0);
  const interaction = assistant.run?.interactions[0];
  const streaming = assistant.streamingText;
  const progress = assistant.progress;
  const labelTool = (tool: string, name?: string | null) => sentPage.current.commandLabels[name ?? ''] ?? toolLabels[tool] ?? (tool.startsWith('query_') ? '查询业务数据' : '执行业务操作');
  const activity = useMemo(() => {
    const calls = new Map<string, { tool: string; name?: string; status: 'running' | 'completed' | 'failed' }>();
    for (const event of assistant.events) {
      const data = event.data as { callId: string; tool: string; name?: string; ok?: boolean; step?: number };
      const key = `${data.step ?? 0}:${data.callId}`;
      if (event.type === 'tool.started') calls.set(key, { tool: data.tool, name: data.name, status: 'running' });
      if (event.type === 'tool.completed') calls.set(key, { ...calls.get(key), tool: data.tool, status: data.ok === false ? 'failed' : 'completed' });
    }
    return [...calls.entries()].slice(-4);
  }, [assistant.events]);
  const workingLabel = !assistant.run ? '正在发送…' : interaction ? captions[assistant.run.status] ?? '等待你回复' :
    progress.stage === 'queued' ? '已收到，等待执行' : progress.stage === 'context' ? '正在核对页面与访问权限' :
    progress.stage === 'tool' && progress.tool ? progress.toolState === 'running' ? `正在${labelTool(progress.tool, progress.toolName)}` : '操作已完成，正在整理结果' :
    streaming ? '正在生成回复' : '正在分析当前需求';
  useEffect(() => {
    if (!assistant.busy) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [assistant.busy]);
  useEffect(() => {
    if (open && followOutput.current && scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [messages, streaming, assistant.busy, activity, open]);
  useEffect(() => {
    if (open) { setUnread(false); void assistant.refreshPersonalities(); (composer.current?.disabled ? closeButton.current : composer.current)?.focus({ preventScroll: true }); }
  }, [open]);
  useEffect(() => { if (!open && (streaming || interaction)) setUnread(true); }, [streaming, interaction, open]);
  function close() { setOpen(false); launcher.current?.focus({ preventScroll: true }); }
  const preview = (interaction?.data ?? {}) as Record<string, any>;
  const fields = (preview.input ?? (preview.key ? { key: preview.key, value: preview.value } : { outcome: preview.outcome, comment: preview.comment })) as Record<string, unknown>;
  const append = (role: 'user' | 'assistant', text: string, page?: string, name?: string) => setMessages(old => [...old, { role, text, page, name }]);
  async function execute(action: () => Promise<AiRun | undefined>) {
    setFailure('');
    try {
      const result = await action();
      if (result?.answer) append('assistant', result.answer, undefined, result.personality?.label);
      if (result && ['failed', 'expired'].includes(result.status)) setFailure(`执行未完成（${result.error ?? result.status}），可以重试或交由人工处理。`);
      // 命令成功后由服务端重新读取记录，页面不会用模型文本假装更新了业务对象。
      await cache.invalidateQueries();
    } catch (error) {
      if (!(error instanceof Error && (error.message === 'CANCELLED' || error.name === 'AbortError'))) setFailure(error instanceof Error ? error.message : '请求失败，请重试');
    }
  }
  function send(message: string) {
    if (!message.trim() || assistant.busy || assistant.personalityBusy || interaction) return;
    if (streaming && ['cancelled', 'failed', 'expired'].includes(assistant.run?.status ?? '')) append('assistant', streaming, undefined, assistant.run?.personality?.label);
    sentPage.current = { instanceId: page.pageInstanceId, title: context.page.title, fieldLabels, commandLabels };
    followOutput.current = true; setShowLatest(false); append('user', message, context.page.title); setInput('');
    void execute(() => assistant.send(message));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (assistant.busy || assistant.personalityBusy) return;
    if (interaction?.kind === 'input') {
      const answer = input.trim(); if (!answer) return;
      append('user', answer); setInput('');
      void execute(() => assistant.respond(interaction.id, { answer }));
    } else send(input);
  }
  return <div className="assistant-dock">
    <section id="workspace-assistant" className="assistant-panel" role="dialog" aria-modal="false" aria-labelledby="assistant-title" hidden={!open} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    }}>
    <div className="assistant-heading">
      <span className="assistant-emblem">{assistant.personality ? <span className="assistant-personality-avatar" aria-hidden="true">{assistant.personality.avatar}</span> : <AssistantMark />}</span>
      <div><span className="assistant-wordmark">CAGE / ASSISTANT</span><h2 id="assistant-title">{assistant.personality?.label ?? '业务助理'}<span>AI</span></h2></div>
      <button ref={closeButton} className="assistant-close" onClick={close} aria-label="收起助理" title="收起 · Esc"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
    </div>
    <div className="assistant-personality"><label htmlFor="assistant-personality-select">相处方式</label><select id="assistant-personality-select" aria-label="助理性格" value={assistant.personalityKey ?? ''}
      disabled={assistant.busy || assistant.personalityBusy || !assistant.personalities.length} onChange={event => {
        void assistant.setPersonality(event.target.value || null).catch(() => {});
      }}><option value="">跟随默认{assistant.personalities.find(p => p.key === assistant.defaultPersonalityKey) ? ` · ${assistant.personalities.find(p => p.key === assistant.defaultPersonalityKey)!.label}` : ''}</option>
      {assistant.personalityKey && !assistant.personalities.some(p => p.key === assistant.personalityKey) && <option value={assistant.personalityKey}>已停用，请重新选择</option>}
      {assistant.personalities.map(p => <option key={p.key} value={p.key}>{p.avatar} {p.label}</option>)}
    </select><small>{assistant.personalityBusy ? '切换中…' : '下条消息生效'}</small></div>
    {assistant.personalityError && <p className="assistant-personality-error" role="alert">性格配置暂不可用。<button onClick={() => void assistant.refreshPersonalities()}>重新读取</button></p>}
    <div className="assistant-context"><span className="assistant-context-dot" /><span>当前页面</span><strong>{context.page.title}</strong>{context.draft && <small>含未保存内容</small>}</div>
    <div className="assistant-messages" ref={scrollArea} role="log" aria-live="polite" aria-atomic="false" onScroll={e => {
      const area = e.currentTarget;
      followOutput.current = area.scrollHeight - area.scrollTop - area.clientHeight < 64;
      setShowLatest(!followOutput.current);
    }}>
      {!messages.length && <div className="assistant-empty"><span className="assistant-greeting">就在这里，帮你多走一步。</span><h3>有什么可以<br />一起处理的？</h3><p>查数据、看进度，或梳理一项操作。<br />我会结合你正在浏览的页面来回答。</p>
        <div className="assistant-suggestions">{suggestions.map((text, index) => <button key={text} disabled={assistant.busy || assistant.personalityBusy || !!interaction} onClick={() => send(text)}><span className="assistant-suggestion-no">0{index + 1}</span><span>{text}</span><span aria-hidden="true">↗</span></button>)}</div>
      </div>}
      {messages.map((message, index) => <div key={index} className={`assistant-message ${message.role === 'user' ? 'assistant-user' : 'assistant'}`}><small>{message.role === 'user' ? '你' : message.name ?? '业务助理'}{message.page && <span className="assistant-message-page">{message.page}</span>}</small>{message.role === 'assistant' ? <AssistantMarkdown>{message.text}</AssistantMarkdown> : <p className="assistant-user-text">{message.text}</p>}</div>)}
      {!!activity.length && <ol className="assistant-activity" aria-label="本轮执行过程">{activity.map(([id, action]) => <li key={id} data-status={action.status}>
        <span className="assistant-activity-dot" aria-hidden="true">{action.status === 'completed' ? '✓' : action.status === 'failed' ? '!' : '·'}</span>
        <span>{labelTool(action.tool, action.name)}</span><small>{action.status === 'completed' ? '已完成' : action.status === 'failed' ? '未完成' : interaction ? '待确认' : '进行中'}</small>
      </li>)}</ol>}
      {(assistant.busy || (streaming && ['cancelled', 'failed', 'expired'].includes(assistant.run?.status ?? ''))) && <div className="assistant-message assistant" aria-busy={assistant.busy}>
        <small>{assistant.run?.personality?.label ?? '业务助理'}{assistant.busy && <span className="assistant-live-dot" aria-label="正在回复" />}</small>
        {streaming ? <AssistantMarkdown>{streaming}</AssistantMarkdown> : <p className="assistant-pending">{workingLabel}</p>}
      </div>}
    {interaction && <div className="assistant-confirm">
      <strong>{interaction.kind === 'confirmation' ? sentPage.current.commandLabels[String(preview.command)] ?? '确认这次操作' : interaction.prompt}</strong>
      {interaction.kind === 'confirmation' && <>
        {preview.subject?.id && <p className="muted">目标单据：{String(preview.subject.id).slice(0, 8).toUpperCase()} · 当前版本 {preview.subject.version}</p>}
        <dl>{Object.entries(fields).filter(([key, value]) => key !== 'id' && value !== undefined).map(([key, value]) => <div key={key}><dt>{sentPage.current.fieldLabels[key] ?? key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
        <div className="actions"><button className="primary" disabled={assistant.busy || assistant.personalityBusy} onClick={() => void execute(() => assistant.respond(interaction.id, { approved: true }))}>确认执行</button><button disabled={assistant.busy || assistant.personalityBusy} onClick={() => void execute(() => assistant.respond(interaction.id, { approved: false }))}>不执行</button></div>
      </>}
      {interaction.kind === 'page_context' && (sentPage.current.instanceId === page.pageInstanceId
        ? <button disabled={assistant.busy || assistant.personalityBusy} onClick={() => void execute(() => assistant.respond(interaction.id, { pageContext: page.snapshot() }))}>提供当前页面内容</button>
        : <p>本轮来自「{sentPage.current.title}」。页面已切换，请停止本轮后，结合新页面重新提问。</p>)}
    </div>}
    {failure && <p className="error" role="alert">{failure}</p>}
    </div>
    {showLatest && <button className="assistant-latest" onClick={() => {
      followOutput.current = true; setShowLatest(false); if (scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
    }}>回到最新回复 ↓</button>}
    {(assistant.busy || assistant.run) && <div className="assistant-status-row"><p className="assistant-status" role="status"><span>{assistant.busy ? workingLabel : captions[assistant.run!.status]}</span>
      {assistant.busy && <span aria-hidden="true">{elapsed}s</span>}{!!assistant.run?.toolCalls && <span>完成 {assistant.run.toolCalls} 项操作</span>}
    </p>{(assistant.busy || interaction) && <button className="assistant-stop" onClick={() => void execute(() => assistant.cancel())}>停止本轮</button>}</div>}
    <form className="assistant-compose" onSubmit={submit}><label htmlFor="assistant-message-input" className="assistant-input-label">{interaction?.kind === 'input' ? '补充信息' : '向助理提问'}</label><div className="assistant-input-box"><textarea ref={composer} id="assistant-message-input" value={input} onChange={e => setInput(e.target.value)} rows={2} placeholder="说说你想处理的事…" maxLength={16000} disabled={assistant.busy || (!!interaction && interaction.kind !== 'input')} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
    }} /><button className="assistant-send" aria-label="发送消息" title="发送 · Enter" disabled={assistant.busy || assistant.personalityBusy || !input.trim() || (!!interaction && interaction.kind !== 'input')}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div><div className="assistant-compose-note"><span>结合当前页面 · 操作前确认</span><span>Shift + Enter 换行</span></div></form>
    </section>
    <button ref={launcher} className={`assistant-launcher${open ? ' is-open' : ''}`} aria-label={open ? '收起业务助理' : '打开业务助理'} aria-expanded={open} aria-controls="workspace-assistant" onClick={() => open ? close() : setOpen(true)}>
      <span className="assistant-launcher-mark"><AssistantMark /></span><span><strong>业务助理</strong><small>{assistant.busy ? '正在处理你的问题' : interaction ? '有一项操作待确认' : unread ? '有新的回复' : '随时为你解答'}</small></span><span className="assistant-launcher-indicator" data-active={assistant.busy || unread || !!interaction} />
    </button>
  </div>;
}
