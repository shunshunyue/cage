/**
 * 数据传输课程的便笺 CSV 面板，放到 Web modules/note 下，在已有登录页面中挂载。
 * 提交返回任务 ID 后用 useTransfer 继续查询，completed 才提供下载；失败或过期保持真实终态。
 * 只保存当前页面内的任务 ID，不提供跨刷新历史管理；应用可按业务需要持久保留或列出本人任务。
 */
import { useRef, useState } from 'react';
import { Alert, App, Button, Input, Space } from 'antd';
import { client, useCan, useTransfer } from '@yss123/cage-client';
import { note } from '@app/contracts';

/** 导入文本按 Note.create 输入处理，导出当前可见 active 便笺；权限、范围和每行规则始终由服务端执行。 */
export function NoteTransferPanel() {
  const { message } = App.useApp();
  const [csv, setCsv] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const task = useTransfer(taskId);
  const canImport = useCan('Note.create');
  const canExport = useCan('Note.export');
  const running = !!taskId && (!task.data || ['queued', 'processing', 'retrying'].includes(task.data.status));

  /** 提交一种任务，只把接受与最终完成分别显示；失败保留 CSV，不自动重发未知结果。 */
  async function start(kind: 'import' | 'export') {
    if (locked.current) return;
    locked.current = true;
    setSubmitting(true);
    setError('');
    try {
      const result = kind === 'import'
        ? await client.importCsv('Note.create', csv, { atomic: false })
        : await note.export({ status: 'active', sort: '-createdAt' });
      if (!result.ok) {
        setError(`任务未接受：${result.code}`);
        return;
      }
      setTaskId(result.data.id);
      void message.info('任务已接受，正在查询执行结果');
    } catch {
      setError('请求结果未知，请先查询本人任务再决定是否重新提交。');
    } finally {
      locked.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2>便笺 CSV</h2>
      <Input.TextArea aria-label="待导入的 CSV" value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="首行为 title，后续每行一个标题" rows={5} />
      <Space>
        {canImport && <Button disabled={running || submitting || !csv.trim()} onClick={() => void start('import')}>导入创建便笺</Button>}
        {canExport && <Button disabled={running || submitting} onClick={() => void start('export')}>导出使用中便笺</Button>}
      </Space>
      {error && <Alert type="error" title={error} />}
      {taskId && <p>任务标识：{taskId}</p>}
      {taskId && task.isPending && <p role="status">正在读取任务…</p>}
      {task.isError && <Alert type="error" title="任务状态读取失败" action={<Button onClick={() => void task.refetch()}>重试查询</Button>} />}
      {task.data && <p>服务端状态：{task.data.status}</p>}
      {task.data?.status === 'failed' && <Alert type="error" title={`任务失败：${task.data.errorCode}`} />}
      {task.data?.status === 'expired' && <Alert type="warning" title="任务结果已过期" />}
      {task.data?.status === 'completed' && <>
        {task.data.result && <p>处理 {task.data.result.rows} 行；请下载报告或独立读取业务记录核对结果。</p>}
        <a href={client.transferDownloadUrl(task.data.id)}>下载{task.data.kind === 'import' ? '逐行报告' : '导出文件'}</a>
      </>}
    </section>
  );
}
