# CAGE-FIELD-001：敏感字段种类不存在

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

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

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/fields.ts:197`

实现片段（位置随框架版本更新）：

```ts
    if (isRelation(this)) throw declError('CAGE-REL-001', '关系字段不支持 sensitive；目标字段按目标聚合权限掩码');
    if (!SENSITIVE_KINDS.includes(kind)) throw declError('CAGE-FIELD-001', `未知的敏感种类 ${kind}`);
    return this.with({ sensitiveKind: kind });
  }
  /** 返回要求租户内唯一的新字段；实际约束由 DDL/迁移落实，不是仅一次应用查询。文件和集合已有专用归属/配对语义，拒绝该修饰。 */
```

</details>
