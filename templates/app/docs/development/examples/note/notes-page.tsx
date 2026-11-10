/**
 * 入门课的便笺列表与创建页面，通过生成契约读写服务端记录，不维护本地业务仓储。
 * 由 app 路由在已登录且具备 Note.read 的页面内挂载；服务端仍执行全部权限与范围判断。
 * 表单状态只保留未提交标题，失败不清空；创建成功后重新查询列表，详情使用独立 URL。
 */
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { note, useNoteList } from '@app/contracts';
import { useCan } from '@yss123/cage-client';

/** 显示当前主体可见的第一页便笺并提供创建入口；分页扩展应按路由规范放入 URL 参数。 */
export function NotesPage() {
  const query = useNoteList();
  const canCreate = useCan('Note.create');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);

  /**
   * 提交一次创建，立即锁住重复点击；业务失败保留输入，成功后从安全接口重新读取。
   * 此锁只限制当前页面的并发点击，不承诺跨刷新重试去重；业务需恢复同次请求时另保存幂等键。
   */
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await note.create({ title });
      if (!result.ok) {
        setError(`创建失败：${result.code}`);
        return;
      }
      setTitle('');
      await query.refetch();
    } catch {
      setError('请求未完成，请重新读取列表确认结果后再决定是否重试。');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <section>
      <h1>部门便笺</h1>
      {canCreate && (
        <form onSubmit={create}>
          <label>
            标题
            <input
              value={title}
              maxLength={120}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button disabled={saving || !title.trim()}>{saving ? '正在保存…' : '创建'}</button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {query.isPending && <p role="status">正在加载…</p>}
      {query.isError && (
        <p role="alert">
          读取失败，请检查会话和读取权限。<button onClick={() => void query.refetch()}>重试</button>
        </p>
      )}
      {query.data && (
        <>
          <p>
            共 {query.data.total} 条，当前显示 {query.data.items.length} 条。
          </p>
          <ul>
            {query.data.items.map((record) => (
              <li key={record.id}>
                <Link to={`/notes/${encodeURIComponent(record.id)}`}>{record.title}</Link>（{record.status}）
              </li>
            ))}
          </ul>
          {query.data.items.length === 0 && <p>当前可见范围内没有便笺。</p>}
        </>
      )}
    </section>
  );
}
