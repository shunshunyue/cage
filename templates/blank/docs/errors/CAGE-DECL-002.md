# CAGE-DECL-002：声明没有从 domain 入口导出

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：静态检查 / 注册。

文件里有声明，但 domain/index.ts 最终导出集合中没有它。

## 修复步骤

1. 在统一入口 re-export，确认没有 export * 的同名冲突；只创建文件不会自动注册。

## 正例

```text
export * from './purchase-order.js'; // index.ts
```

## 反例

```text
文件存在，但 index.ts 未导出
```

## 修复后验证

重跑 cage check/analyze，确认声明出现在本体图，再运行 gen。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/doctor.ts:96`
- `packages/cli/src/static-check.ts:304`

实现片段（位置随框架版本更新）：

```ts
    exports: result.registration?.find(entry => entry.name === site.exportName && entry.file === site.file),
    registered: !result.findings.some(f => f.code === 'CAGE-DECL-002' && f.at === `${site.file}:${site.line}`),
    nodes: result.graph?.nodes.filter(n => n.file === site.file && n.line === site.line).map(n => ({ key: `${n.kind}:${n.id}`, attrs: n.kind === 'reaction' ? { event: n.attrs.event, command: n.attrs.command, tx: n.attrs.tx, order: n.attrs.order, collection: n.attrs.collection } : undefined })) ?? [] }));
  const verifyFile = abs(cfg, '.cage/verify.json');
  return { schemaVersion: 1, cliVersion: VERSION, observedAt, project: cfg.name, registryHash, sourceHash, registryHashSource: compiledExists ? compiledEntry : /\.js$/.test(cfg.domain) ? cfg.domain : null, ok: checks.every(c => c.status !== 'fail'), complete: checks.every(c => c.status !== 'unknown'), checks, findings, registration,
```
