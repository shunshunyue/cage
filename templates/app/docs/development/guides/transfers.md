# 在业务页面导入和导出 CSV

Cage 把导入映射到现有用户命令，把导出映射到安全读取。两者先返回异步任务，页面负责选择文件、筛选、进度和报告展示。

## 导入：准备命令输入

以便笺创建命令为例，CSV 表头就是该命令的输入字段：

```csv
title
月度工作纪要
部门值班安排
```

页面调用：

```ts
const result = await client.importCsv('Note.create', csv, { atomic: false });
```

client 来自 cage-client，csv 是 UTF-8 文本。用户需有该命令能力，目标必须允许 user 调用且输入为 Zod 对象；每行继续经过输入、范围、状态、约束、不变量和审计。

更新命令还要有 id，可选 expectedVersion。表头不接受命令之外的字段，空可选单元格表示未提供；数组和对象使用单元格 JSON，CSV 内双引号要按 CSV 规则转义。当前不是任意 xlsx 文件识别。

## 选择整批规则

| 选项 | 业务结果 |
| --- | --- |
| atomic: false，默认 | 业务拒绝记录为失败行，正确行保留 |
| atomic: true | 任一业务行失败则整批业务变更回滚，原成功行报告为 ABORTED |

内部错误、连接故障与死锁属于任务失败或重试，不伪装成普通坏数据行。逐行模式不表示每一行在独立请求中即时提交；消费者使用事务与保存点管理任务。

一次导入最多 1 MiB UTF-8、1000 数据行，不含表头。支持 BOM、CRLF、引号内换行和双引号转义；列数、重复/空表头和引号歧义明确拒绝。

## 导出：使用服务端筛选

```ts
const result = await note.export({ status: 'active', sort: '-createdAt' });
```

note 来自本项目生成契约。导出需 Note.export，读取受当前范围与掩码约束；页面筛选应提交给服务端，不只过滤已加载的一页。

worker 在同一可重复读快照中分批构建文件，当前上限 100000 行、20 MiB，超限失败并要求缩小范围。导出包含公开业务字段和系统列，公式前缀有安全转义；它不是可直接回导的命令模板，掩码和系统列也不能原样回写。

## 跟踪任务到终态

result.ok 只说明任务接受，HTTP 为 202。保存 result.data.id，用 client.transfer(id) 或 useTransfer(id) 观察：

| 状态 | 页面行为 |
| --- | --- |
| queued / processing / retrying | 显示进度与可继续查询的任务标识 |
| completed | 查看摘要，提供报告或文件下载 |
| failed | 展示稳定错误码和可处理原因 |
| expired | 说明结果已过期，按当前需求重新提交 |

useTransfer 处理中每两秒刷新，终态停止。完成后使用 client.transferDownloadUrl(id) 下载。导入报告提供行号、成功/失败、code/domainCode 和字段名，不含原始单元格敏感值。

下面是一个完整的结果组件，id 来自任务接受后的 result.data.id。它可放到 Web 的便笺模块中，与提交按钮组合：

<!-- cage:example transfer-result -->
```tsx
import { client, useTransfer } from '@yss123/cage-client';

/** 跟踪一项已接受的任务，completed 才展示下载，处理中的响应不会显示为导入完成。 */
export function TransferResult({ id }: { id: string }) {
  const task = useTransfer(id);
  if (task.isPending) return <p role="status">正在读取任务…</p>;
  if (task.isError) return <button onClick={() => void task.refetch()}>读取失败，重试查询</button>;
  if (task.data.status === 'failed') return <p role="alert">任务失败：{task.data.errorCode}</p>;
  if (task.data.status === 'expired') return <p>任务结果已过期</p>;
  if (task.data.status !== 'completed') return <p role="status">任务处理中：{task.data.status}</p>;
  return <a href={client.transferDownloadUrl(id)}>下载{task.data.kind === 'import' ? '逐行报告' : '导出文件'}</a>;
}
```

[完整 CSV 面板](../examples/note/transfer-panel.tsx)进一步包含文本输入、导入/导出按钮、能力显示、重复提交限制和任务标识。复制到 apps/web/src/modules/note/transfer-panel.tsx，在已有页面中挂载 NoteTransferPanel；普通授权、worker 和真实便笺契约仍须已接通。

任务和结果默认保留 24 小时。读取、执行和下载重新核对身份与权限；授权变化可能使原导出文件不再可下载。

## 协议与部署

| 接口 | 用途 |
| --- | --- |
| POST /api/note/export | 为 Note 创建导出，其他对象由注册表生成路径 |
| POST /api/sys/transfers/import | 创建命令导入 |
| GET /api/sys/transfers | 本人可见任务 |
| GET /api/sys/transfers/:id | 状态 |
| GET /api/sys/transfers/:id/download | 文件或报告 |

具体路径和参数以 SDK/OpenAPI 为准。接口不要求把业务用户带到系统管理，也不统一要求 Sys.ops 权限；仍需目标命令/导出授权、会话、CSRF 和 worker。

结果与消费者记录共同持久化，崩溃可重投；任务接受、处理完成、报告下载是三个不同阶段。

## 验证

导入准备全部成功、部分失败、原子回滚及缺能力样例；观察任务终态后独立读取业务数据。导出用不同范围和敏感字段权限比对，并检查超限、过期及下载时撤权。CSV 展示与真正写入规则分别核对。

[返回开发手册](../README.md)
