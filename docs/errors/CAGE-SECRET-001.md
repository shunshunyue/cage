# CAGE-SECRET-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/connectors/src/runtime.ts:22](../../packages/connectors/src/runtime.ts)

```ts
    const v = process.env[name];
    if (!v) throw new Error(`[CAGE-SECRET-001] 缺少密钥 ${name}（由密钥管理服务或环境变量注入）`);
    return v;
  },
};

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
