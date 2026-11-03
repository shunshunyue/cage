# CAGE-CONN-007：当前环境没有连接器地址

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

非 fake 环境中，连接器 hosts 找不到当前 stage 对应的主机。

## 修复步骤

1. 检查 CAGE_STAGE 与 hosts.test/prod。fake 不需要真实主机；真实联调必须配置正确环境及密钥。

## 正例

```text
CAGE_STAGE=test，hosts.test 指向沙箱主机
```

## 反例

```text
只配置 prod 却用 test 环境启动，或把 fake 成功称作真实联调通过
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:150`

实现片段（位置随框架版本更新）：

```ts
      const host = o.connector.hosts[st];
      if (!host) throw new ConnectorError(`[CAGE-CONN-007] 连接器 ${o.connector.name} 没有 ${st} 环境的地址`, null, false);
      const token = o.connector.secret ? await secrets.get(o.connector.secret) : undefined;
      await take(o.connector, signal);
      const url = new URL(o.path, `https://${host}`);
```
