# CAGE-AUDIT-001：可靠读取审计失败

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：安全读侧 / 查询。

敏感明文读取，或声明 audit.purpose 的查询，无法完成交付前的审计写入。请求拒绝交付结果。

## 修复步骤

1. 凭 requestId 检查审计存储、写账号权限和数据库可用性；修复后重新读取。
2. 不要吞掉审计异常、去除敏感声明或改用基表绕过审计。查询只声明目的，不把敏感输入放进目的文本。

## 正例

```text
query('report', { reads: [Order], audit: { purpose: '月度核对' }, /* input/sql */ })
```

## 反例

```text
审计写入失败后继续返回敏感明文
```

## 修复后验证

修复审计存储后重新读取，确认有权交付的数据与相应审计均完成。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/read.ts:136`
- `packages/kernel/src/read.ts:137`
- `packages/kernel/src/read.ts:284`
- `packages/kernel/src/read.ts:285`
- `packages/kernel/src/transfer/index.ts:176`
- `packages/kernel/src/transfer/index.ts:177`

实现片段（位置随框架版本更新）：

```ts
    }); } catch {
      this.k.log.error({ code: 'CAGE-AUDIT-001', aggregate: agg.name, kind, requestId: ctx.requestId }, '读取审计失败，未交付数据');
      throw cageError('INTERNAL', { diagnostic: 'CAGE-AUDIT-001', phase: 'audit', operation: kind, retryable: true });
    }
  }
```

</details>
