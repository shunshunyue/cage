# CAGE-NAME-002：字段名必须小驼峰

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

聚合字段名不是小写字母开头的字母数字标识。

## 修复步骤

1. 业务字段使用小驼峰；数据库 snake_case 由框架转换，中文列名写在页面或图谱显示配置。

## 正例

```text
fields: { supplierPhone: text() }
```

## 反例

```text
fields: { supplier_phone: text() }
```

## 修复后验证

重跑 cage check/gen；改动线上标识时还要审查能力、路由、迁移及旧消费者影响。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/aggregate.ts:178`

实现片段（位置随框架版本更新）：

```ts
    }
    if (!/^[a-z][A-Za-z0-9]*$/.test(k)) throw declError('CAGE-NAME-002', `字段名 ${name}.${k} 必须是小驼峰`);
    fields[k] = v;
  }
  const states = st ?? DEFAULT_STATES;
```
