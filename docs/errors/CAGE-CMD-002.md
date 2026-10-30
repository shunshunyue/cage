# CAGE-CMD-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/command.ts:142](../../packages/kernel/src/primitives/command.ts)

```ts
  if (from !== 'new' && input instanceof z.ZodObject && !('id' in input.shape)) {
    throw declError('CAGE-CMD-002', `${agg.name} 的非新建命令输入必须包含 id`);
  }
  if (def.name !== undefined && !/^[a-z][A-Za-z0-9]*$/.test(def.name)) {
    throw declError('CAGE-NAME-004', `命令名 ${def.name} 必须是小驼峰`);
  }
```

## 怎么修

非新建命令的输入必须含 id；from/to、调用身份和聚合定义保持一致。

## 正例

```text
input: z.object({ id: z.string().uuid(), note: z.string() })
```

## 反例

```text
input: z.object({ note: z.string() }) // 非新建命令缺少 id
```
