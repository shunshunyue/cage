# 私有文件字段与断点续传

[返回学习入口](README.md) · [原语](primitives.md) · [权限与执行模型](architecture.md)

文件字节由 `@yss123/cage-files` 管理；业务字段只保存文件 ID。上传完成得到临时文件，业务命令成功后才正式绑定。不要把文件内容、Base64、存储路径或公开 URL 放进业务字段、事件或审计。

## 声明与命令

下面是声明片段，放入现有聚合的 fields：

```ts
import { file, files } from '@yss123/cage-kernel';

// 单文件为 UUID 或 null；多文件为 UUID 数组，新建不传时初始化为 []。
contract: file({ maxBytes: 20 * 1024 * 1024, accept: ['application/pdf'] }).optional(),
attachments: files({ maxCount: 10, maxBytes: 2 * 1024 ** 3, accept: ['application/pdf', 'image/jpeg', 'image/png', 'text/plain'] }),
```

上传目标用户命令必须使用 `z.object`，在 input 中直接声明同名字段，例如 `attachments: z.array(z.string().uuid()).max(10).optional()`；修改已有对象还需 input.id。不支持由任意别名输入推测文件归属。上传请求的 `command/field/targetId` 必须与声明一致；新建命令不传 targetId，已有对象命令必须传。

`files` 允许 1–100 的 maxCount；accept 使用明确 MIME，不接受扩展名或 `*/*`。文件只能放在聚合顶层，不嵌入 list/事件，不作为范围字段，也不支持 hidden/sensitive/unique。事件传引用使用 id/list(id())。文件不可覆盖，替换需要新文件 ID。一个文件只绑定一个对象的一个字段，第一版不共享文件。

生成契约包括 UUID/数组读侧类型和 `<Aggregate>FileFields` 限制；本体字段记录 filePolicy。修改声明后执行 `pnpm gen`，审查新迁移，执行 `pnpm migrate`。给已有对象增加必填 files 时，需要在新迁移草稿中把新列回填为 `[]` 再设 NOT NULL；不要修改历史迁移。采购范例的附件迁移演示了这个步骤。

## 客户端上传

下面是页面逻辑片段，selectedFile 为用户选择的浏览器 File：

```ts
import { client, purchaseOrder } from '@app/contracts';

const task = client.upload(selectedFile, {
  command: 'PurchaseOrder.create', field: 'attachments',
}, { concurrency: 3 });
const unsubscribe = task.subscribe(() => renderProgress(task.getSnapshot()));

try {
  const uploaded = await task.start();
  // 这里仍需处理 result.ok；保存失败可继续使用有效期内的同一附件 ID。
  const result = await purchaseOrder.create({
    amount: '100.00', items: [{ sku: 'A-01', qty: 1 }], attachments: [uploaded.id],
  });
} finally {
  unsubscribe();
  task.dispose();
}
```

`renderProgress` 是页面自己的显示函数。task.start() 失败会抛 FileUploadError（网络/服务端错误）或文件身份校验错误；页面必须捕获。React 可用 `useFileUpload(task)` 订阅稳定快照，卸载时 dispose 暂停并解除订阅。

- `task.pause()` 中断当前请求，保留服务端确认分片；等待本次 start 结束后再次 start 继续。
- `task.cancel()` 标记取消，清理由后台执行；已绑定附件不能取消，必须通过业务命令移除。
- 刷新后通过 `client.uploadSessions({ command, field, targetId? })` 查找本人未过期会话。用户重新选择原文件，再调用 `client.upload(file, target, { uploadId })`。SDK 对每个已确认分片重新计算 SHA-256，内容不一致则拒绝恢复。普通浏览器不会自动恢复本地文件访问权。
- SDK 默认并发 3，允许 1–6；失败分片退避重试。合并重试仍使用同一会话，超时不代表服务端未完成。
- 进度 confirmedBytes 只统计服务端确认的内容；恢复核对、上传、校验合并分别显示。不是逐网络字节进度。
- 注销、401 或切换账号会暂停任务并取消请求。业务应用仍需按会话隔离和清除自己的页面/查询缓存。

底层方法为 beginUpload/uploadSession/uploadSessions/uploadPart/completeUpload/cancelUpload/fileInfo/fileDownloadUrl。下载链接只含文件 ID，仍依靠当前 Cookie 会话授权，不是永久 bearer 链接。

## 服务端配置与存储

`createServer({ domain })` 默认启用私有本地目录 `.cage-files`，也可通过 `CAGE_FILES_DIR` 或 `files.directory` 指定。这个目录不属于可再生的 `.cage`，不能被发布清理脚本删除或静态服务公开；已从模板分发和 Git/Docker 上下文中排除。容器必须给运行用户提供可写持久卷。数据库元数据和文件内容需要配套备份，不能只备份数据库。

```ts
createServer({ domain, files: {
  directory: '/srv/cage/private-files',
  partBytes: 16 * 1024 * 1024,
  maxFileBytes: 2 * 1024 ** 3,
  maxPendingBytesPerUser: 8 * 1024 ** 3,
  maxStoredBytesPerTenant: 100 * 1024 ** 3,
  maxPendingUploadsPerUser: 100,
  retentionMs: 24 * 3600_000,
  ioTimeoutMs: 30 * 60_000,
} });
```

有效文件上限取字段和系统限制的较小值。配额按租户串行预留，跨 API 实例有效；租户总量包括待清理内容。磁盘峰值还要预留合并占用和失败 IO 的临时内容，逻辑配额不是物理磁盘容量保证。上传会话到期不自动续期，第一版有效期固定；修改 partBytes 不影响已有会话的协议参数，部署时不要把路由限制调低到小于未完成旧会话的分片大小。

`FileStorage` 是公开存储适配接口：name/limits、writePart、complete、read（含范围）、remove、prune。通过 `files.storage` 注入。适配器需遵守长度/校验和、不可变产物、token 隔离、取消、幂等删除和流式内存边界。name 必须稳定标识相同存储空间；本地 name 含目录指纹，改目录后旧文件不会被误清理，但不会自动迁移。

本地先流式写分片，校验长度及 SHA-256，fsync 后确认；完成时按序流式复核并合并，最终 rename 发布。数据库事务不跨字节 IO。分片和合并使用持久租约，进程重启后确认清单仍在；未结束租约最多等待约两分钟后可接管。对象存储适配器可映射原生 multipart，但第一版只内置本地实现，未提供 S3/OSS SDK、签名直传或真实云存储联调。

API 进程启动后及每分钟执行有界清理。先锁元数据认领，再在事务外删除；已绑定文件不因上传有效期删除。移除后重新获得 24 小时保留期。墓碑定期复查，完成文件的过期执行残留也会重试清理。没有运行 API 时不会清理；单独使用 FileService 的调用方需定期调用 cleanup 并在退出时 close。

## 权限、下载与部署

暂存、分片和完成需要本人登录、目标用户命令能力；修改已有对象还检查当前 read/范围及命令起始状态。硬约束及最终字段关联在业务命令提交时校验，上传预检查不表示命令必定成功。命令事务重新验证租户、上传者、目标字段、目标对象、文件状态、有效期、大小与类型；关联和业务记录、审计、outbox 同事务提交或回滚。旧附件保留不要求当前操作者是原上传者。

绑定后元数据和下载按所属对象当前 read/范围及字段引用授权；临时完成文件只对上传者开放且仍需目标命令能力。下载交付前写可靠审计，失败拒绝交付。响应使用 attachment、nosniff 和 no-store，支持单段 HTTP Range；第一版不提供匿名访问或在线 Office 预览。

服务端对已知二进制格式检查内容头；UTF-8 文本进行保守前缀校验；未知二进制只能显式允许 application/octet-stream。这不是病毒扫描、完整文件格式验证或所有 MIME 的识别保证。

代理必须允许至少一个分片的请求体，并关闭分片请求缓冲；采购部署 Nginx 示例提供默认 16 MiB 配置。合并可能持续较久，代理超时要与服务配置协调。本地模式的多个 API 必须共享同一个持久目录和配置；不同磁盘节点不能只共享数据库。新增加的 setAttachments 等业务能力仍需管理员显式授权，框架不会自动授给生产角色。
