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

列表和详情有独立 URL，app 从模块公开入口组合。跨模块导航由 app 协调；只有确实被多个模块复用的 UI 或纯工具才进入 shared。具体边界见[目录规范](../reference/project-structure.md)。

## 完成后检查

用浏览器完成成功与失败操作，确认输入保留、版本冲突、查询刷新和账号切换清理。再按[路由指南](routing.md)检查深链接与部署；展示的数据、权限和流程状态都要有服务端来源。

[返回开发手册](../README.md)
