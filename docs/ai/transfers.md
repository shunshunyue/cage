# 在客户业务页接入导入和导出

[返回学习入口](README.md) · [开发步骤](workflow.md)

框架提供持久化任务、CSV 处理、权限和下载接口。业务项目决定入口、列名、上传表单、任务状态与报告如何展示；不要求用户进入系统管理页，也不要求具备 Sys.ops 能力。路径中的 `/api/sys/transfers` 是通用任务接口。

继续使用项目已有的 createServer 和 startWorker，不另写数据库连接、队列或文件服务。先审查并运行 `pnpm migrate`，同时部署 API 与 worker；只运行 API 会让任务一直等待。

## 业务前端如何调用

以下是业务事件处理函数，可按页面需要使用。目标导出对象与导入命令来自实际业务，不必固定为采购或库存。

```ts
import { client, purchaseOrder } from '@app/contracts';

export async function exportApprovedOrders() {
  // 同一次业务操作需要重试时，在页面保存并复用 key。
  const key = crypto.randomUUID();
  return purchaseOrder.export({ status: 'approved' }, { idempotencyKey: key });
}

export async function importCommandCsv(command: string, file: File, key: string) {
  return client.importCsv(command, await file.text(), {
    atomic: false,
    idempotencyKey: key,
  });
}

export async function inspectTransfer(id: string) {
  const result = await client.transfer(id);
  if (!result.ok) return result;
  if (result.data.status !== 'completed') return result;
  // 导入完成还可能有失败行，页面需展示报告中的 failed/succeeded。
  if (result.data.kind === 'import') return client.importReport(id);
  return client.transferDownloadUrl(id);
}
```

所有提交先判断 `result.ok`，再保存返回任务的 id，HTTP 202 仅表示已接受。React 可从 `@app/contracts` 引入 `useTransfer(id)`：等待、处理中和重试中每两秒刷新，完成/失败/过期停止。没有 React 时自行调用 client.transfer。

页面返回时可用 `client.transfers('实际聚合名')` 恢复本人该对象最近任务。任务状态包括 queued、processing、retrying、completed、failed、expired；completed 的导入也可能部分失败或整批回滚，不能只按状态显示“全部成功”。

## 导入 CSV 怎么准备

目标命令必须已经导出、允许 user 调用、使用 Zod object 输入，并且当前用户具有对应命令能力。比如业务输入 `{ sku: string, available: number }` 的 UTF-8 CSV：

```csv
sku,available
SKU-001,100
SKU-002,50
```

- 表头是**命令输入字段名**，使用小驼峰，不是数据库列名或中文标题。页面可自行做中文列名映射。
- 可选列可省略；空的可选单元格表示不提供值。已有记录命令需要 id，还可提供 expectedVersion 控制乐观锁。
- 数字按数字解析，布尔使用 true/false，数组与对象写 JSON，金额按字符串输入。
- 复杂单元格仍要遵守 CSV 引号规则，例如 items 单元格可以是 `"[{""sku"":""A-01"",""qty"":1}]"`。
- 支持 BOM、CRLF、引号中的逗号/换行及双引号转义。重复/未知表头、错列和未闭合引号等文件错误会在排队前拒绝。
- 每行仍走原命令的权限、范围、状态、约束、不变量、审计、事件与同事务反应；导入不能绕过 process/external 限制。

默认 `atomic: false`：成功行提交，失败行及其同事务反应回滚。`atomic: true`：任意行失败撤销整批业务写入，原成功行在报告中标为 ABORTED。

报告只含记录号、ok/code/domainCode/fields，不返回原始值或命令快照。表头算第 1 条，第一条数据记录为第 2 条；带换行的引号单元格仍只算一条记录。页面用记录号帮助用户修复 CSV，不把失败文本直接拼成 HTML。

**导出文件不是导入模板。** 读侧导出包含 id/status/version 等系统列及掩码值，不能原样回写；按所选命令整理输入。

## 接口与授权

| HTTP | 输入或结果 |
| --- | --- |
| POST `/api/{聚合短横线名}/export` | 列表筛选参数；返回 202 和任务，需要该聚合 export 能力 |
| POST `/api/sys/transfers/import` | `{ command, csv, atomic? }`，command 是 `聚合.命令` 能力标识；返回 202 和任务 |
| GET `/api/sys/transfers/options` | 本人可用的导出对象、导入命令、字段 name/required 与限制 |
| GET `/api/sys/transfers?aggregate=聚合名` | 本人最近 100 个任务，按需筛选业务对象 |
| GET `/api/sys/transfers/:id` | 本人单个任务的状态、计数及 errorCode |
| GET `/api/sys/transfers/:id/download` | 已完成导出的 CSV，或已完成导入的 JSON 报告 |

options 可用 `client.get('/api/sys/transfers/options')` 读取，没有额外假定的专用 helper。直接调用 HTTP 时，提交必须附会话、CSRF 以及 1–200 字符 Idempotency-Key；client 会处理这些协议。相同租户/用户的同键同内容返回同一任务，同键不同内容返回 CONFLICT。

导出经过安全视图，按提交人的范围和明文权限读取。仅提交人能下载；账号停用、能力收回或范围/明文权限/部门树变化后，旧文件可能被拒绝下载，需要重新导出。系统运维权限不会自动授予他人的文件下载权。

## 限制与排错

| 项目 | 当前限制 |
| --- | --- |
| 导入 | UTF-8 CSV，1 MiB / 1000 条数据记录 |
| 导出 | 100000 行 / 20 MiB；超限任务失败，不静默截断 |
| 导出分页参数 | page/pageSize 不限制导出范围；使用业务筛选条件缩小数据 |
| 有效期 | 提交起 24 小时，到期拒绝下载，由 worker 清理文件和结果 |
| 存储 | PostgreSQL 持久化，API 与 worker 不需要共享磁盘 |
| 暂未提供 | XLSX、对象存储、断点续传、逐行实时进度、超大文件流式导入 |

任务一直 queued 先查 worker；failed 看 errorCode/导入报告；数据库故障耗尽重试时查原有死信链路。先修复根因再重放，别创建直接写业务表的“快速导入”接口。
