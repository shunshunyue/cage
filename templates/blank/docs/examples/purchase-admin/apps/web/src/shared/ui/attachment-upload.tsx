// 文件上传与业务保存分开：这里只产出已完成的 ID，最终关联仍由调用方的领域命令提交。
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client, useFileUpload, type FileUploadTask, type UploadSession } from '@app/contracts';
import './attachment-upload.css';

interface Props {
  command: string;
  field: string;
  targetId?: string;
  policy: { maxBytes: number; maxCount?: number; accept: readonly string[] };
  value: string[];
  onChange: (ids: string[]) => void;
  onBusyChange: (busy: boolean) => void;
}
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

export function FileLink({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['file-info', id], queryFn: async () => {
    const result = await client.fileInfo(id);
    if (!result.ok) throw new Error(result.code);
    return result.data;
  } });
  if (query.isPending) return <span className="muted">正在读取附件…</span>;
  if (query.isError) return <span role="status">附件不可访问</span>;
  return <a href={client.fileDownloadUrl(id)}>{query.data.filename} <small className="muted">{size(query.data.bytes)}</small></a>;
}

export function AttachmentUpload(props: Props) {
  const { command, field, targetId, policy, value, onChange, onBusyChange } = props;
  const current = useRef(props); current.current = props;
  const [tasks, setTasks] = useState<{ key: number; file: File; task: FileUploadTask }[]>([]);
  const [error, setError] = useState('');
  const sequence = useRef(0), tasksRef = useRef(tasks); tasksRef.current = tasks;
  const [active, setActive] = useState<Record<number, boolean>>({});
  const pending = useQuery({ queryKey: ['file-uploads', command, field, targetId], queryFn: async () => {
    const result = await client.uploadSessions({ command, field, targetId });
    if (!result.ok) throw new Error(result.code);
    return result.data;
  } });
  useEffect(() => { onBusyChange(Object.values(active).some(Boolean)); }, [active, onBusyChange]);
  useEffect(() => () => { for (const entry of tasksRef.current) entry.task.dispose(); }, []);

  function add(files: FileList | null, session?: UploadSession) {
    if (!files?.length) return;
    setError('');
    const maximum = policy.maxCount ?? 1;
    const working = tasks.filter(entry => !['completed', 'cancelled'].includes(entry.task.getSnapshot().status)).length;
    if (value.length + working + files.length > maximum) { setError(`最多选择 ${maximum} 个附件，请先取消多余任务。`); return; }
    for (const file of Array.from(files)) {
      if (file.size < 1 || file.size > policy.maxBytes || !policy.accept.includes(file.type || 'application/octet-stream')) {
        setError(`“${file.name}”的大小或类型不符合要求。`); continue;
      }
      const task = client.upload(file, { command, field, targetId }, { uploadId: session?.id });
      const key = ++sequence.current;
      setActive(previous => ({ ...previous, [key]: true }));
      setTasks(previous => [...previous, { key, file, task }]);
    }
  }
  function useCompleted(id: string) {
    const { value, onChange, policy } = current.current;
    if (value.includes(id)) return;
    if (value.length >= (policy.maxCount ?? 1)) { setError('附件数量已达到上限，请移除后重试。'); return; }
    onChange([...value, id]);
  }
  const taskIds = new Set(tasks.map(entry => entry.task.getSnapshot().id));
  const recoverable = (pending.data ?? []).filter(session => !value.includes(session.id) && !taskIds.has(session.id));
  return <div className="attachment-upload">
    <div className="attachment-heading"><strong>附件</strong><span className="muted">{value.length} / {policy.maxCount ?? 1}</span></div>
    <label className="attachment-picker">
      <span>＋ 选择文件</span>
      <input type="file" multiple={(policy.maxCount ?? 1) > 1} accept={policy.accept.join(',')} disabled={value.length >= (policy.maxCount ?? 1)}
        onChange={event => { add(event.target.files); event.target.value = ''; }} />
      <small>支持暂停与续传 · 单文件最大 {size(policy.maxBytes)}</small>
    </label>
    <p className="muted attachment-hint">上传完成后，保存记录才会正式关联；未完成的上传可以稍后恢复。</p>
    {error && <p role="alert" className="attachment-error">{error}</p>}
    {value.map(id => <div className="attachment-row" key={id}><FileLink id={id} /><button type="button" onClick={() => onChange(value.filter(item => item !== id))}>移除</button></div>)}
    {tasks.map(entry => value.includes(entry.task.getSnapshot().id ?? '') ? null : <UploadRow key={entry.key} file={entry.file} task={entry.task}
      onDone={id => { setActive(previous => ({ ...previous, [entry.key]: false })); useCompleted(id); }} onBusy={busy => setActive(previous => previous[entry.key] === busy ? previous : ({ ...previous, [entry.key]: busy }))} />)}
    {recoverable.length > 0 && <div className="attachment-recovery"><strong>可恢复的上传</strong><p className="muted">继续上传时，请重新选择原文件；已完成部分会先核对内容。</p>
      {recoverable.map(session => <div className="attachment-row" key={session.id}><span>{session.filename} <small className="muted">{size(session.bytes)}</small></span><div className="actions">
        {session.status === 'ready' ? <button type="button" onClick={() => useCompleted(session.id)}>使用附件</button> : <label className="attachment-resume">选择原文件续传<input type="file" onChange={event => { add(event.target.files, session); event.target.value = ''; }} /></label>}
        <button type="button" onClick={async () => { const result = await client.cancelUpload(session.id); if (result.ok) void pending.refetch(); else setError('取消失败，请重试。'); }}>取消</button>
      </div></div>)}
    </div>}
    {pending.isError && <p role="status" className="muted">暂时无法查询可恢复任务。<button type="button" onClick={() => void pending.refetch()}>重试</button></p>}
  </div>;
}

function UploadRow({ file, task, onDone, onBusy }: { file: File; task: FileUploadTask; onDone: (id: string) => void; onBusy: (busy: boolean) => void }) {
  const state = useFileUpload(task);
  const callbacks = useRef({ onDone, onBusy }); callbacks.current = { onDone, onBusy };
  const busy = ['initializing', 'verifying', 'uploading', 'completing'].includes(state.status);
  const start = () => { void task.start().then(session => callbacks.current.onDone(session.id)).catch(() => {}); };
  useEffect(() => { start(); }, [task]);
  useEffect(() => { callbacks.current.onBusy(busy); }, [busy]);
  const labels = { idle: '等待上传', initializing: '准备上传', verifying: '核对已上传内容', uploading: '上传中', paused: '已暂停', completing: '校验与合并中', completed: '上传完成', failed: '上传失败，可重试', cancelled: '已取消' };
  if (state.status === 'cancelled') return null;
  return <div className="attachment-task"><div className="attachment-row"><span>{file.name}</span><div className="actions">
    {busy && state.status !== 'completing' && <button type="button" onClick={() => task.pause()}>暂停</button>}
    {['paused', 'failed', 'completed'].includes(state.status) && <button type="button" onClick={state.status === 'completed' && state.id ? () => onDone(state.id!) : start}>{state.status === 'completed' ? '使用附件' : '继续'}</button>}
    <button type="button" onClick={() => { void task.cancel().catch(() => {}); }}>取消</button>
  </div></div>
    <progress aria-label={`${file.name} 上传进度`} max={state.totalBytes} value={state.confirmedBytes} />
    <div className="attachment-progress" role="status"><span>{labels[state.status]}</span><span>{size(state.confirmedBytes)} / {size(state.totalBytes)}{state.bytesPerSecond > 0 ? ` · ${size(state.bytesPerSecond)}/s` : ''}</span></div>
    {state.error && <p className="attachment-error">{({ NETWORK: '网络中断，已上传内容会保留。', TIMEOUT: '请求超时，可继续重试。', FORBIDDEN: '权限不足，请联系管理员。', UNAUTHENTICATED: '登录已失效，请重新登录。', NOT_FOUND: '上传会话或业务记录不可访问。', INVALID_INPUT: '文件不符合要求，请重新选择。', CONFLICT: '上传状态有变化，请稍后重试。', RATE_LIMITED: '上传配额或请求次数已达上限，请稍后重试。' } as Record<string, string>)[state.error] ?? state.error}</p>}
  </div>;
}
