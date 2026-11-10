# CAGE-DIAG-001：运行诊断输入或连接失败

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：doctor / timeline / explain。

诊断 URL、Cookie 文件、输入文件或筛选项无效，或受控诊断请求无法完成。

## 修复步骤

1. 使用不含用户信息、查询参数或片段的 HTTP(S) 地址；通过 --cookie-file 提供受控会话。
2. 按 reason 检查目标接口、权限、输入和服务状态；unknown 不能视为通过。不要在 URL 中携带令牌。

## 正例

```text
cage doctor --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
```

## 反例

```text
把密码或 Cookie 写进 --runtime-url 的查询参数
```

## 修复后验证

核对诊断输入、受控会话和目标服务，再重新获取实际运行证据；未知不当作通过。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/main.ts:150`
- `packages/cli/src/runtime-diagnostics.ts:23`
- `packages/cli/src/runtime-diagnostics.ts:26`
- `packages/cli/src/runtime-diagnostics.ts:27`
- `packages/cli/src/runtime-diagnostics.ts:29`
- `packages/cli/src/runtime-diagnostics.ts:32`

实现片段（位置随框架版本更新）：

```ts
  if (command === 'timeline' || command === 'explain') {
    if (command === 'explain' && (!target || !o['input-file'])) throw new Error('[CAGE-DIAG-001] 使用 cage explain <命令> --input-file <JSON文件> --runtime-url <地址> --cookie-file <文件>');
    const body = command === 'explain' ? { command: target, input: JSON.parse(readFileSync(abs(cfg, o['input-file']!), 'utf8')), userId: o['user-id'] } : undefined;
    const result = await (await import('./runtime-diagnostics.js')).runtimeDiagnostic(cfg, { runtimeUrl: o['runtime-url'], cookieFile: o['cookie-file'] }, `/api/sys/diagnostics/${command === 'timeline' ? 'timeline' : 'authorization'}`, {
      query: command === 'timeline' ? { requestId: o['request-id'], outboxId: o['outbox-id'], aggregate: o.aggregate, aggregateId: o['aggregate-id'] } : undefined, body,
```
