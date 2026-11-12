/**
 * 前端与路由课程的 Ant Design 便笺页面，放到 Web modules/note/pages 并由模块入口导出。
 * URL 保存状态筛选和页码，查询与写入使用真实生成契约；创建成功后清空表单并重新读取。
 * 组件依赖应用已有的 Router、QueryClientProvider 和 Ant Design App，权限显示不能代替服务端授权。
 */
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, App, Button, Form, Input, Select, Skeleton, Space, Table } from 'antd';
import { useCan } from '@yss123/cage-client';
import { note, useNoteList, type Note } from '@app/contracts';

/** 列表、筛选与创建组成一页；详情继续使用独立 /notes/:id，刷新和前进后退均从 URL 恢复条件。 */
export function NotesTablePage() {
  const { message } = App.useApp();
  const [search, setSearch] = useSearchParams();
  const requestedPage = Number(search.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const rawStatus = search.get('status');
  const status = rawStatus === 'active' || rawStatus === 'archived' ? rawStatus : undefined;
  const query = useNoteList({ page, pageSize: 20, status, sort: '-createdAt' });
  const canCreate = useCan('Note.create');
  const [form] = Form.useForm<{ title: string }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);

  /** 筛选改变时回第一页，翻页保留筛选；更新 URL 会触发真实列表请求，而非过滤当前一页。 */
  function changeList(nextPage: number, nextStatus: 'active' | 'archived' | undefined) {
    const next = new URLSearchParams(search);
    next.set('page', String(nextPage));
    if (nextStatus) next.set('status', nextStatus);
    else next.delete('status');
    setSearch(next);
  }

  /** 创建失败保留表单，业务成功后才清空；提交锁只限制当前页面的重复点击。 */
  async function create(values: { title: string }) {
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await note.create({ title: values.title.trim() });
      if (!result.ok) {
        setError(`创建失败：${result.domainCode ?? result.code}`);
        return;
      }
      form.resetFields();
      void message.success('便笺已保存');
      await query.refetch();
    } catch {
      setError('请求未完成，请重新读取列表核对结果后再决定是否重试。');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  if (query.isPending) return <Skeleton active />;
  if (query.isError) return <Alert type="error" title="便笺读取失败" action={<Button onClick={() => void query.refetch()}>重试</Button>} />;

  return (
    <section>
      <h1>部门便笺</h1>
      {canCreate && <Form form={form} layout="inline" onFinish={create}>
        <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, max: 120 }]}>
          <Input maxLength={120} disabled={saving} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>创建</Button>
      </Form>}
      {error && <Alert type="error" title={error} />}
      <Space>
        <label htmlFor="note-status">状态</label>
        <Select<'all' | 'active' | 'archived'> id="note-status" value={status ?? 'all'} onChange={(value) => changeList(1, value === 'all' ? undefined : value)} options={[
          { value: 'all', label: '全部' }, { value: 'active', label: '使用中' }, { value: 'archived', label: '已归档' },
        ]} />
      </Space>
      <Table<Note> rowKey="id" dataSource={query.data.items} loading={query.isFetching} columns={[
        { title: '标题', dataIndex: 'title', render: (_value, record) => <Link to={`/notes/${encodeURIComponent(record.id)}`}>{record.title}</Link> },
        { title: '状态', dataIndex: 'status', render: (value) => value === 'active' ? '使用中' : '已归档' },
      ]} pagination={{ current: page, pageSize: 20, total: query.data.total, showSizeChanger: false, onChange: (nextPage) => changeList(nextPage, status) }} />
    </section>
  );
}
