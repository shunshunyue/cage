# CAGE-INIT-004：账号已创建但 .env 替换失败

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：init。

数据库账号权限已提交，随机凭证仍保存在错误指出的 .env.cage-init-*.tmp 恢复文件中。

## 修复步骤

1. 保留恢复文件，解除文件占用或修复项目目录权限，将该文件恢复为项目 .env。
2. 恢复后运行 init 验证连接，不重新生成密码；恢复文件及 .env 均含凭证，不提交到 Git，不发到聊天。

## 正例

```text
按报错路径恢复 .env 后验证并继续 gen/migrate
```

## 反例

```text
删除恢复文件，丢失刚创建角色的随机密码
```

## 修复后验证

恢复/核对配置后运行 cage init 验证，随后按流程 gen、审查迁移并 migrate；不输出凭证。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/init.ts:142`

实现片段（位置随框架版本更新）：

```ts
    } catch {
      throw new Error(`[CAGE-INIT-004] 账号权限已准备，但无法替换 .env；凭证保存在 ${staged}，请将它恢复为项目 .env 后继续`);
    }
    staged = undefined;
    return { status: reuse ? 'reused' : 'created', envFile };
```

</details>
