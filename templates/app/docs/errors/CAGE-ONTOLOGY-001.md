# CAGE-ONTOLOGY-001：本体节点缺少结构化业务名称

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：check / gen / verify / 图谱与上下文诊断。

当前项目可定位的聚合、字段、状态、命令、事件、查询或任务没有非空业务名称，图谱只能回退机器标识。默认警告，graph.naming 为 required 时作为门禁错误。

## 修复步骤

1. 按 reason 的完整节点 key 定位声明。字段和状态的位置指向所属聚合，继续在其中查找成员；无本地源码位置的依赖节点不在本检查范围。
2. 对象、命令、查询和任务填写 description；事件在第三个参数填写 description；字段用 .describe(...) 或关系选项 description；每个状态都在 states 的 labels 中命名。旧声明可用 graph.labels 的完整 key 覆盖显示。
3. 普通注释与前端 statusLabel 不会自动进入本体。名称用用户的业务用语，不为翻译改表名、状态值或能力点；详见 docs/development/guides/ontology-modeling.md。
4. 补齐后重跑 check 并查看 graph/context；完整性不验证语言、名称质量或任意业务关系，仍按已明确规则验证外键方向、基数、状态迁移及真实触发链。

## 正例

```text
states('active', 'archived', { terminal: ['archived'], labels: { active: '使用中', archived: '已归档' } })
```

## 反例

```text
states('active', 'archived', { terminal: ['archived'] }) // 只在页面或注释中翻译状态，没有结构化名称
```

## 修复后验证

重跑 cage check，再在 graph/context 中按业务用语核对名称；对象关系与运行行为仍需独立业务用例验证。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/ontology-names.ts:27`
- `packages/cli/src/ontology-names.ts:42`

实现片段（位置随框架版本更新）：

```ts
 * @param presentation 与图谱同一次抽取产生的名称，配置短标题优先于声明文案。
 * @returns 每个缺名节点一条 CAGE-ONTOLOGY-001；不推断语言、不从注释或前端反推业务名称。
 */
export function checkOntologyNames(cfg: CageConfig, graph: Ontology, presentation: GraphPresentation): Finding[] {
  const aggregates = new Map(graph.nodes.filter(node => node.kind === 'aggregate').map(node => [node.id, node]));
```

</details>
