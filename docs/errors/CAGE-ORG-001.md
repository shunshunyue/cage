# CAGE-ORG-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:211](../../packages/cli/src/rules.ts)

```ts

/** CAGE-ORG-001：domain 必须包含框架自带的组织模型 */
export function checkOrg(g: Ontology): Finding[] {
  const has = (id: string) => g.nodes.some((n) => n.kind === 'aggregate' && n.id === id);
  return has('User') && has('Dept') && has('Role')
    ? []
```

## 怎么修

从 domain 入口导出框架组织模型。

## 正例

```text
export * from '@yss123/cage-admin/domain';
```

## 反例

```text
// domain 入口只导出业务聚合，遗漏组织模型
```
