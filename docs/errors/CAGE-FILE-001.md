# CAGE-FILE-001：文件字段或上传配置无效

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：字段声明 / 私有文件服务配置。

文件缺少明确的大小/MIME 限制，多文件数量无效，文件嵌入 JSON/事件/范围字段，或存储分片配置超出适配器限制。

## 修复步骤

1. 文件直接声明在聚合 fields 中，设置正整数 maxBytes、明确 MIME accept；files 还需 1–100 的 maxCount。
2. 不使用 sensitive/hidden/unique 修饰文件；事件只传 id/list(id())。上传 partBytes/maxFileBytes 必须符合存储适配器分片限制。

## 正例

```text
attachments: files({ maxBytes: 20971520, maxCount: 10, accept: ['application/pdf'] })
```

## 反例

```text
list({ contract: file({ maxBytes: 0, accept: ['*/*'] }) })
```

## 修复后验证

重跑 cage check、gen 和文件回归；实际验证暂停、续传、命令绑定及当前权限下载，云存储联调单独报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/files/src/service.ts:95`
- `packages/files/src/service.ts:98`
- `packages/kernel/src/primitives/aggregate.ts:189`
- `packages/kernel/src/primitives/event.ts:51`
- `packages/kernel/src/primitives/fields.ts:195`
- `packages/kernel/src/primitives/fields.ts:202`
- `packages/kernel/src/primitives/fields.ts:208`
- `packages/kernel/src/primitives/fields.ts:305`
- `packages/kernel/src/primitives/fields.ts:336`

实现片段（位置随框架版本更新）：

```ts
    };
    for (const [name, value] of Object.entries(this.options)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`[CAGE-FILE-001] ${name} 必须为正安全整数`);
    const limits = this.storage.limits;
    if (this.options.partBytes < limits.minPartBytes || this.options.partBytes > limits.maxPartBytes || Math.ceil(this.options.maxFileBytes / this.options.partBytes) > limits.maxParts)
      throw new Error('[CAGE-FILE-001] 分片配置超出存储适配器限制');
```
