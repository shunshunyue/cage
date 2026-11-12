# 上传、绑定与下载私有附件

附件有两次完成：字节上传完成，以及业务命令保存完成。Cage 文件服务负责前者，领域事务负责把文件 ID 绑定到业务记录。

## 1. 定义字段和接收它的命令

以便笺增加 PDF 附件为例，在聚合 fields 声明：

<!-- cage:example files-field -->
```ts
attachments: files({
  maxBytes: 20 * 1024 * 1024,
  maxCount: 3,
  accept: ['application/pdf'],
}).describe('便笺附件'),
```

files 来自 kernel，maxBytes 按单个文件的字节数，maxCount 为 1–100，accept 使用明确 MIME 类型。单文件可用 file(...).optional()；字段值是 UUID，不是 URL 或字节。

例如单个可选封面允许未上传，此字段与附件数组分别声明，不把 URL 存进文件字段：

<!-- cage:check domain files-single-field -->
```ts
export const cover = file({ maxBytes: 1024 * 1024, accept: ['image/png'] }).optional().describe('封面');
```

创建或修改命令的 Zod input 还需接收 attachments，例如 UUID 数组并限制最多三项。上传服务会检查所指用户命令确实接收该文件字段。改已有对象时另提供 targetId，并检查当前状态、read、范围和命令能力。

例如创建输入只传文件 UUID，未传附件与显式空数组都不携带文件字节：

<!-- cage:check domain files-command-input -->
```ts
export const noteWithFilesInput = z.object({
  title: z.string().trim().min(1).max(120),
  attachments: z.array(z.uuid()).max(3).optional(),
});
```

从 domain 导出后运行 check/gen，审查并执行迁移。页面获得的是更新后的契约。

## 2. 上传到临时会话

下面放在用户选择了 File 的事件处理中，title 和 selectedFile 来自当前表单：

<!-- cage:example files-upload -->
```ts
const task = client.upload(selectedFile, {
  command: 'Note.create',
  field: 'attachments',
});
const session = await task.start();
```

client 来自 cage-client；构造 task 尚不发请求，start 才创建会话、校验分片与完成合并。订阅 task.subscribe/getSnapshot 展示确认字节、速度和状态，失败保留表单并提供重试。

例如监听确认字节，返回函数用于界面卸载时取消这项监听。getSnapshot 取的是已确认进度，不是浏览器已发送字节：

<!-- cage:check web files-subscribe -->
```ts
export function watchUpload(task: FileUploadTask, show: (confirmed: number, total: number) => void) {
  return task.subscribe(() => {
    const progress = task.getSnapshot();
    show(progress.confirmedBytes, progress.totalBytes);
  });
}
```

服务端状态依次可能为 uploading、completing、ready、bound、deleting、deleted。ready 表示完整内容已校验，可以交给命令；不表示便笺已创建。

## 3. 用业务命令绑定

更新契约后，页面调用：

<!-- cage:example files-bind -->
```ts
const result = await note.create({ title, attachments: [session.id] });
```

只有 result.ok 为 true，才能显示业务保存成功。命令事务检查上传者、目标、字段政策、状态与归属后绑定，失败整笔回滚。临时上传仍可供后续重试或过期清理，页面不应因此清空输入。

已绑定文件通过业务命令修改附件集合来移除；取消上传接口不能删除已绑定附件。绑定属于领域事务，字节 IO 不放进 handler。

例如要新增“替换附件”业务动作，在 Note.fields 已有 attachments 后声明接收完整数组的命令，再生成契约：

<!-- cage:check domain files-replace-command -->
```ts
export const replaceAttachments = command(Note, {
  name: 'replaceAttachments', description: '替换便笺附件集合', from: 'active', to: null,
  input: z.object({ id: z.uuid(), attachments: z.array(z.uuid()).max(3) }),
  handler: (_draft, input) => ({ attachments: input.attachments }),
});
```

传 [] 表示解除所有附件绑定；文件清理由文件服务随后处理，不等于命令事务直接删除字节。

## 4. 暂停、续传与清理界面

task.pause() 中断本地工作并保留分片，再 start() 继续；task.cancel() 还请求服务端取消；不用该实例时 dispose() 解除订阅并暂停。

暂停与继续使用同一实例，取消则结束这个上传意图。下面分别对应三个按钮处理函数：

<!-- cage:check web files-controls -->
```ts
export const pauseUpload = (task: FileUploadTask) => task.pause();
export const continueUpload = (task: FileUploadTask) => task.start();
export const abandonUpload = (task: FileUploadTask) => task.cancel();
```

组件离开时解除自己的监听并清理任务实例，避免继续更新已卸载的界面：

<!-- cage:check web files-dispose -->
```ts
export function disposeUpload(task: FileUploadTask, unsubscribe: () => void) {
  unsubscribe();
  task.dispose();
}
```

刷新后保存 uploadId，让用户重选原 File，再调用 client.upload(file, target, { uploadId })。SDK 按服务端已确认分片重新计算 SHA-256，同名同大小不足以证明是原文件。会话可通过 uploadSession/uploadSessions 查询。

例如恢复新增便笺的附件；uploadId 来自此前任务快照，selectedFile 是用户重新选择的 File：

<!-- cage:check web files-resume -->
```ts
export const resumeFile = (selectedFile: File, uploadId: string) => client.upload(
  selectedFile, { command: 'Note.create', field: 'attachments' }, { uploadId },
);
```

修改已有便笺时则提供真实对象 ID；不能把新建的上传目标沿用为另一条已有记录：

<!-- cage:check web files-existing-target -->
```ts
export const uploadForExistingNote = (selectedFile: File, record: Note) => client.upload(
  selectedFile, { command: 'Note.replaceAttachments', field: 'attachments', targetId: record.id },
);
```

SDK 默认并发 3、重试 4，可设并发 1–6、重试 0–10；仅对可恢复失败有界退避。暂停和请求取消不等于服务端已经删除文件。

例如慢速网络改成两个并发分片、最多额外重试两次；这不会改变业务字段的大小和数量限制：

<!-- cage:check web files-upload-options -->
```ts
export const limitedUpload = (selectedFile: File) => client.upload(
  selectedFile, { command: 'Note.create', field: 'attachments' }, { concurrency: 2, retries: 2 },
);
```

## 5. 下载按当前业务授权判断

client.fileInfo(id) 返回元数据，client.fileDownloadUrl(id) 构造受控下载地址。服务端每次重新判断当前记录 read、范围和字段仍存在的绑定；临时 ready 文件仅上传者在有效会话下访问。下载地址本身不授予权限。

例如元数据通过后才显示下载入口；保留失败结果供页面解释，而不是无条件打开地址：

<!-- cage:check web files-download -->
```ts
export async function fileLink(id: string) {
  const info = await client.fileInfo(id);
  if (!info.ok) return info;
  return { ok: true as const, data: { ...info.data, href: client.fileDownloadUrl(id) } };
}
```

支持范围下载，服务端可靠审计成功后才交付字节。文件路径和存储凭据不会作为业务字段公开。

## 存储与运行边界

默认 LocalFileStorage，目录默认 .cage-files。FileStorage 是对象存储适配接口，当前没有内置 S3/OSS、签名直传、病毒扫描或共享文件协议。

默认分片 16 MiB，服务级单文件上限 2 GiB，未绑定保留一天；业务字段还可以设更小上限。服务按用户会话数、暂存字节及租户存储量限制占用。长 IO 用租约和 token 防迟到回写，后台清理过期内容；进程关闭先取消并等待在途操作。

部署时持久保存私有存储并规划容量，不能把可丢弃的容器临时目录当正式存储。

例如容器重建后，仍应能用原文件 ID 授权下载相同字节。只挂载数据库而没有保存 .cage-files 所对应的存储位置，不满足这个结果：

```text
上传 PDF → 命令绑定 → 重建应用容器 → 以原账号下载 → 字节与原 PDF 一致
```

## 验证

用实际字节上传、暂停恢复、保存，再授权下载并比对内容。覆盖错误 MIME、超限、内容不一致、无命令能力、范围外下载、业务失败后重试和移除绑定。上传进度 100% 与业务保存结果分别显示。

例如上传完成后故意提交空标题：便笺创建应失败，界面保留附件会话和标题草稿；修正标题后才显示便笺保存成功。另用范围外账号请求下载，服务端应拒绝。

[客户端参考](../reference/client.md) · [返回开发手册](../README.md)
