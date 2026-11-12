# CAGE-SCOPE-001：范围组合子未知

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明 / 范围编译。

角色范围数据或内部调用传入了无法编译的 combinator。

## 修复步骤

1. 使用框架内置 self/dept/deptSubtree/deptSet/all，核对授权数据；别把显示中文当成存储标识。

## 正例

```text
combinator: 'deptSubtree'
```

## 反例

```text
combinator: '部门及下级'
```

## 修复后验证

重跑 cage check；分别使用本人/部门等实际授权用户验证范围内外结果。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/scope/index.ts:71`

实现片段（位置随框架版本更新）：

```ts
    default:
      throw new Error('[CAGE-SCOPE-001] 未知的范围组合子');
  }
}

```

</details>
