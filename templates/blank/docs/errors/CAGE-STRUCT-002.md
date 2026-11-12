# CAGE-STRUCT-002：源码依赖越过模块边界

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：check / analyze / verify（structure: modular）。

共享代码反向依赖业务，前端业务互相穿透，领域模块依赖组合层，或跨模块导入了内部文件。

## 修复步骤

1. app 组合前端模块；各模块只用自己的实现和 shared，通过 props/回调协作。shared 不放具体业务请求、文案和状态。
2. 领域模块间确有 reads 等依赖时从目标 index.ts 导入；跨模块事件反应写到 workflows，外部协议写到 integrations。
3. 不要用领域总入口反向导入模块内部。公开入口仅转导出，依赖必须保持单向，禁止通过路径别名或转导出绕开规则。

## 正例

```text
// 领域采购模块读取库存公开声明
import { Inventory } from '../inventory/index.js';
```

## 反例

```text
// shared 反向依赖某项业务页面
import { ExpensePage } from '../../modules/expense/pages/expense-page';
```

## 修复后验证

按 docs/development/reference/project-structure.md 整理归属和导入后重跑 cage check 与 verify；不关闭目录规则，也不改业务表或能力标识。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/project-structure.ts:124`

实现片段（位置随框架版本更新）：

```ts
          findings.push({
            code: 'CAGE-STRUCT-002',
            at: `${at}:${source.slice(0, spec.pos).split('\n').length}`,
            reason: `${reason}（${spec.fileName}）`,
            fix: '调整依赖归属；共用纯逻辑下沉到 shared，页面协作由 app 传参，领域交互通过模块公开声明。见 docs/development/reference/project-structure.md',
```

</details>
