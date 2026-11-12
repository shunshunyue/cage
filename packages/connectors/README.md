# @yss123/cage-connectors

管理应用与外部系统的协议边界：允许的主机、密钥名称、请求/响应 schema、fake、验签及出站执行。领域 handler 通过事件和命令连接外部效果。

## 声明操作

安装 pnpm add @yss123/cage-connectors zod，与 Cage 其余包保持同版本：

```ts
import { connector, op } from '@yss123/cage-connectors';
import { z } from 'zod';

/** 测试账务协议的声明；只有对方真实按键去重时才可使用 retryableWrite。 */
export const ledger = connector('ledger', {
  hosts: { test: 'ledger.example.test' },
  secret: 'LEDGER_TOKEN',
  operations: {
    send: op({
      method: 'POST', path: '/documents', effect: 'retryableWrite',
      request: z.object({ externalId: z.string().uuid() }),
      response: z.object({ number: z.string() }),
    }),
  },
});
```

主机不带协议/路径，secret 是部署注入名称。声明本身不请求网络；outbound 将事件映射到操作，成功通过 external 命令回写。inbound 先验原始正文，再映射领域命令。

## 重试与核对

read、retryableWrite、write 依据远端真实效果选择。外部执行、持久回执和本地回写分阶段；不可重试写的未知结果会隔离，普通死信重放不解除 unknown。数据库事务不能回滚远端。

fakeConnector 验证本地协议与映射，不能证明真实联调。当前没有通用确认远端回执/解除未知状态的管理入口，需按业务协议恢复或补偿。

[自动化与第三方](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/automation.md) · [执行保证](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/execution.md)
