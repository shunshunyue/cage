/**
 * 入门课详情页，从 URL 的 id 独立读取便笺并通过契约修改或归档。
 * 由 app 组合到 /notes/:id；query 缓存与退出清理由现有应用会话层管理。
 * 每次写入传服务端记录版本；冲突后刷新而不自动覆盖，归档后仅展示结果。
 */
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { note, useNote } from '@app/contracts';
import { useCan } from '@yss123/cage-client';

/** 加载独立详情；标题草稿为 null 时显示服务端标题，空字符串仍表示用户正在编辑。 */
export function NoteDetailPage() {
  const { id = '' } = useParams();
  const query = useNote(id);
  const canUpdate = useCan('Note.update');
  const canArchive = useCan('Note.archive');
  const [draft, setDraft] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const record = query.data;
  const title = draft?.id === id ? draft.title : (record?.title ?? '');

  /**
   * 保存或归档当前记录，使用读取版本防止覆盖并发变更；失败保留草稿，成功后清除草稿并读取。
   * 冲突刷新后要求用户核对再提交；按钮禁用与引用锁限制本页同时提交，不替代内核检查。
   */
  async function save(action: 'update' | 'archive') {
    if (!record || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      const result =
        action === 'update'
          ? await note.update(record.id, { title }, record.version)
          : await note.archive(record.id, record.version);
      if (!result.ok) {
        setError(
          result.code === 'CONFLICT'
            ? '记录已变化，请核对最新数据和当前草稿后再提交。'
            : `操作失败：${result.code}`,
        );
        if (result.code === 'CONFLICT') await query.refetch();
        return;
      }
      setDraft(null);
      await query.refetch();
    } catch {
      setError('请求未完成，请重新读取记录确认结果。');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <section>
      <Link to="/notes">返回列表</Link>
      {query.isPending && <p role="status">正在加载…</p>}
      {query.isError && (
        <p role="alert">
          无法读取记录：可能不存在、会话失效或不在可见范围。
          <button onClick={() => void query.refetch()}>重试</button>
        </p>
      )}
      {record && (
        <>
          <h1>{record.title}</h1>
          <p>
            状态：{record.status}；版本：{record.version}
          </p>
          {record.status === 'active' && (
            <>
              {canUpdate && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save('update');
                  }}
                >
                  <label>
                    标题
                    <input
                      value={title}
                      required
                      maxLength={120}
                      onChange={(event) => setDraft({ id, title: event.target.value })}
                    />
                  </label>
                  <button disabled={saving || !title.trim()}>保存</button>
                </form>
              )}
              {canArchive && (
                <button disabled={saving} onClick={() => void save('archive')}>
                  归档
                </button>
              )}
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
