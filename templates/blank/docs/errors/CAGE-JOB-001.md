# CAGE-JOB-001：定时表达式不合法

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明 / worker。

job 声明的 cron 缺少基本时间字段，后续解析也可能发现具体表达式错误。

## 修复步骤

1. 使用受支持的 cron 表达式并按业务明确运行频率；不要将无效配置静默改成每分钟执行。

## 正例

```text
cron: '0 2 * * *'
```

## 反例

```text
cron: '每天两点'
```

## 修复后验证

先 cage check，再在独立测试环境用目标任务数据验证读取、调用与审计；不要等待生产定时器试错。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:346`

实现片段（位置随框架版本更新）：

```ts
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-006', `任务名 ${name} 必须是小驼峰`);
  if (def.cron.trim().split(/\s+/).length < 5) throw declError('CAGE-JOB-001', `任务 ${name} 的 cron 表达式不合法`);
  return Object.freeze({
    [JOB]: true as const,
    name,
```

</details>
