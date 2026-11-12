# CAGE-READS-001：handler 使用了未声明读依赖

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：handler 执行。

handler 访问 deps 中不存在的别名。

## 修复步骤

1. 在命令 reads 添加真实聚合与正确别名，核对入口导出。不要通过 any 或自建仓储绕过依赖声明。

## 正例

```text
reads: { stock: Inventory }；使用 deps.stock.findOne({ sku })
```

## 反例

```text
reads: {}；使用 deps.stock
```

## 修复后验证

检查本体图 reads 边并运行该命令的业务用例。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/pipeline/load.ts:74`
- `packages/kernel/src/pipeline/load.ts:99`
- `packages/kernel/src/primitives/command.ts:54`
- `packages/kernel/src/primitives/command.ts:183`

实现片段（位置随框架版本更新）：

```ts
 * 仓储绑定当前事务与身份，handler 的读操作因此看到同一事务状态且不能写入。
 * Proxy 将未声明别名转成明确 CAGE-READS-001；then/toJSON 保留为普通对象协议属性。
 */
export function bindReads<R extends Reads>(tx: Db, reads: R, ctx: Ctx): Record<string, ReadRepo<any>> {
  const deps: Record<string, ReadRepo<any>> = {};
```

</details>
