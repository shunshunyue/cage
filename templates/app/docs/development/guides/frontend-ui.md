# 组合真实的 React 业务界面

Cage Web 使用 React、React Router 和 Ant Design。页面围绕用户动作组织：列表帮助查找，详情解释状态，表单提交真实命令，流程页展示实际待办。业务数据来自生成契约和服务端结果。

## 从任务选择组件

| 使用目的 | 常用组件 |
| --- | --- |
| 编辑与输入提示 | Form、Input、Select、DatePicker 等 |
| 行列对比与服务端分页 | Table |
| 展示对象字段 | Descriptions、Typography |
| 状态与数量 | Tag、Badge |
| 反馈与恢复 | Alert、Result、Empty、Skeleton、消息和通知 |
| 布局 | Layout、Flex、Grid、Space 与局部 CSS |

默认控件来自 antd 和 @ant-design/icons。聊天气泡与推理步骤确有需要时可评估 Ant Design X；模板未预装。界面由实际业务组合，不需要引入页面描述语言或固定 CRUD 渲染体系。

## 沿用应用上下文

Web 入口已经组合 ConfigProvider、中文 locale、主题 token 和 Ant Design App。组件内通过 App.useApp() 使用 message、notification、modal，继承当前上下文。

样式优先使用组件 props 和主题 token。业务 CSS 就近维护，避免把旧原生 button 的全局类直接赋给 Ant Design 控件。图标用清楚的操作文字补充，布局在窄屏仍可操作。

## 页面完整处理一次操作

开始前读取真实模块、路由和契约类型。表单保存草稿，提交调用对应生成命令；检查业务成功后再清空、关闭或刷新查询，失败保留输入并显示可处理原因。

每页处理加载、空结果、失败、权限与提交中状态。未知数据不能默认显示为零或成功。表格使用稳定 rowKey，分页和筛选同步 URL 与服务端；表单校验用于即时反馈，服务端 schema 与规则决定最终写入。

## 一个表单怎样接到真实保存

[完整的 Ant Design 便笺页面](../examples/note/notes-table-page.tsx)包含 import、表单、查询、筛选和错误状态。放到 apps/web/src/modules/note/pages/notes-table-page.tsx，从模块导出并让 /notes 路由渲染 NotesTablePage；详情继续使用基础课程页面。

组件内通过 App.useApp() 取得 message，通过 Form.useForm() 保存表单。下面是完整文件里的提交函数，query 来自 useNoteList，submitting、saving、error 都是当前组件状态：

<!-- cage:example create-note-form -->
```tsx
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
```

onFinish 接到该函数；loading 控制提交反馈，disabled 防止保存过程中输入被后来成功的 resetFields 清掉：

<!-- cage:example note-form-view -->
```tsx
{canCreate && <Form form={form} layout="inline" onFinish={create}>
  <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, max: 120 }]}>
    <Input maxLength={120} disabled={saving} />
  </Form.Item>
  <Button type="primary" htmlType="submit" loading={saving}>创建</Button>
</Form>}
```

canCreate 使用 useCan('Note.create')。失败时上述路径没有 resetFields，用户可以保留内容处理原因；成功后重新读取服务端列表。表格和 URL 部分见[路由指南](routing.md)。

列表和详情有独立 URL，app 从模块公开入口组合。跨模块导航由 app 协调；只有确实被多个模块复用的 UI 或纯工具才进入 shared。具体边界见[目录规范](../reference/project-structure.md)。

## 完成后检查

用浏览器完成成功与失败操作，确认输入保留、版本冲突、查询刷新和账号切换清理。再按[路由指南](routing.md)检查深链接与部署；展示的数据、权限和流程状态都要有服务端来源。

[返回开发手册](../README.md)
