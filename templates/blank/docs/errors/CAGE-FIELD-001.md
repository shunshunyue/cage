# CAGE-FIELD-001：敏感字段种类不存在

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

sensitive 使用了 SENSITIVE_KINDS 之外的值。

## 修复步骤

1. 选用当前包导出的敏感种类；确需新掩码规则时评估框架扩展，不以 any 绕过声明。

## 正例

```text
supplierPhone: text(32).sensitive('phone')
```

## 反例

```text
text().sensitive('自定义随意字符串')
```

## 修复后验证

重跑 cage check/gen，审查契约与迁移；敏感字段还要验证普通用户读结果。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/fields.ts:112`

实现片段（位置随框架版本更新）：

```ts
    if (isRelation(this)) throw declError('CAGE-REL-001', '关系字段不支持 sensitive；目标字段按目标聚合权限掩码');
    if (!SENSITIVE_KINDS.includes(kind)) throw declError('CAGE-FIELD-001', `未知的敏感种类 ${kind}`);
    return this.with({ sensitiveKind: kind });
  }
  /** 唯一约束（租户内） */
```
