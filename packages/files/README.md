# @yss123/cage-files

Cage 的私有文件服务。管理上传会话、可恢复分片、SHA-256 校验、配额、私有下载和过期清理，内置本地磁盘实现，并提供自定义对象存储适配接口。适合业务附件；字段声明和业务事务内绑定仍由 kernel 负责。

上传完成只得到临时文件 ID，调用业务命令成功后才正式绑定。文件字节、存储路径和公开 URL 不进入业务字段。

## 安装与服务端配置

需要 Node.js 24+、PostgreSQL 和持久存储，与其他 Cage 包保持同版本：

```powershell
pnpm add @yss123/cage-files
```

标准 `@yss123/cage-http` 已装配本包。定制存储时在 API 入口配置，以下例子里的 `@app/domain` 来自脚手架应用：

```ts
/** API 私有文件装配；目录持久保存，不能作为静态资源公开。 */
import { createServer } from '@yss123/cage-http';
import { LocalFileStorage } from '@yss123/cage-files';
import * as domain from '@app/domain';

const server = createServer({
  domain,
  files: {
    storage: new LocalFileStorage('.cage-files'),
    partBytes: 16 * 1024 * 1024,
    maxFileBytes: 2 * 1024 ** 3,
    retentionMs: 24 * 3600_000,
  },
});
await server.listen();
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
```

未传 `storage` 时会创建本地实现，目录由 `files.directory`、`CAGE_FILES_DIR` 或默认 `.cage-files` 决定。这个目录不属于可再生的 `.cage`；容器应使用持久卷，数据库元数据与文件字节应配套备份。

## 业务接入的三个步骤

1. 在聚合 `fields` 使用 kernel 的 `file/files`，并在目标用户命令 input 中声明同名 UUID 或 UUID 数组。字段只能位于聚合顶层。
2. 运行 `pnpm gen`，审查迁移并执行 `pnpm migrate`，授予目标命令及所需读取/范围能力。
3. 浏览器使用 `client.upload` 上传，成功后将返回 ID 交给目标业务命令；字段绑定与业务记录同事务提交。

字段片段合并到已有聚合，不能单独作为完整 domain：

```ts
import { files } from '@yss123/cage-kernel';

// 每个文件最多 20 MiB、最多 5 个，仅允许明确的 MIME 类型。
const attachments = files({
  maxCount: 5,
  maxBytes: 20 * 1024 * 1024,
  accept: ['application/pdf', 'image/png'],
});
// 放入聚合 fields: { attachments }；命令 input 需同名 z.array(z.string().uuid())。
```

下例为采购模板的页面操作，`selectedFile` 来自文件选择框。其他业务应替换目标命令、字段与生成契约：

```ts
import { client, purchaseOrder } from '@app/contracts';

/** 上传失败会抛错；业务保存失败仍须展示结果，不能把上传成功当作订单已保存。 */
async function createWithAttachment(selectedFile: File) {
  const task = client.upload(selectedFile, {
    command: 'PurchaseOrder.create',
    field: 'attachments',
  });
  try {
    const uploaded = await task.start();
    return await purchaseOrder.create({
      amount: '100.00',
      items: [{ sku: 'A-01', qty: 1 }],
      attachments: [uploaded.id],
    });
  } finally {
    task.dispose();
  }
}
```

调用方捕获上传异常并检查返回值 `ok`。修改已有记录时，上传目标还须传 `targetId`。刷新后通过客户端查询本人会话，重新选择原文件，再传 `uploadId` 恢复；SDK 会核对已确认分片内容。

## 公开入口与边界

| 入口 | 作用 |
| --- | --- |
| `FileService`、`FileServiceOptions` | 协调授权、会话、配额、上传、下载和清理；通常由 HTTP 层持有 |
| `LocalFileStorage` | 流式写入、校验、合并及范围读取的磁盘实现 |
| `FileStorage`、`StoredPart`、`ByteRange` | 自定义存储协议；适配 writePart/complete/read/remove/prune |
| `beginUploadSchema`、`UploadSession`、`FileInfo` | 服务端输入校验与公开上传/文件描述 |

一个文件只能绑定一个对象的一个字段，不能覆盖原文件；替换需新 ID。下载依当前 Cookie 会话、对象范围和字段引用重新授权，不提供永久公开链接。分片/完成操作的预检查不保证最终命令必定通过。

API 启动后及每分钟执行有界清理；独立持有 `FileService` 时须自行定期调用 `cleanup()`，退出时 `close()`。本地多实例必须共享同一目录，不能只共享数据库。代理需允许分片请求体、关闭上传缓冲并配置合并超时。

目前只内置本地存储；`FileStorage` 不代表已提供 S3/OSS SDK 或签名直传。内容头校验也不等于病毒扫描或完整格式验证。

完整说明：[私有文件字段与断点续传](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/files.md)。源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
