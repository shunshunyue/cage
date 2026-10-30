# CAGE-SECRET-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/lint/src/rules/no-secret-literal.ts:19](../../packages/lint/src/rules/no-secret-literal.ts)

```ts
    docs: { description: '禁止密钥字面量' },
    messages: { secret: '[CAGE-SECRET-002] 疑似{{what}}写在了代码里：密钥只写名字，值由密钥管理服务注入' },
    schema: [],
  },
  create(context) {
    const check = (node: any, value: string, name?: string) => {
```

## 怎么修

配置中只写密钥名；密钥值通过运行环境注入，移除源码中的字面量。

## 正例

```text
secret: 'ERP_API_TOKEN'
```

## 反例

```text
secret: 'a-real-token-in-source'
```
