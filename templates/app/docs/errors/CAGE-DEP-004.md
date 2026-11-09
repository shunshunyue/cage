# CAGE-DEP-004：声明或 handler 直接发请求/动态导入

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：静态检查 / verify。

静态检查发现 domain 调用 fetch 或动态 import。

## 修复步骤

1. 把外部 IO 声明成连接器，把声明改为静态导出，避免在运行时动态生成业务规格。

## 正例

```text
event → outbound → onSuccess.command
```

## 反例

```text
handler 里 await fetch(...) 或动态 import 数据库模块
```

## 修复后验证

重跑 cage check 和 verify，确认边界修复而不是禁用规则。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/static-check.ts:199`

实现片段（位置随框架版本更新）：

```ts
          findings.push({
            code: 'CAGE-DEP-004',
            at: loc(node),
            reason: name === 'fetch' ? 'handler 里直接发网络请求' : '声明文件里使用了动态 import',
            fix: '第三方调用改为连接器声明 + outbound 出站映射',
```
