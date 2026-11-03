# @yss123/create-cage-app

产物自带 `AGENTS.md`、`docs/ai` 业务开发指南、采购标准范例与 `docs/errors` 错误码册。使用 Codex 等编程工具时，让它先读项目根目录 `AGENTS.md`，按 `docs/ai/recipes.md` 开发客户业务，无需克隆 Cage 框架仓库。

从 Cage 薄壳模板创建中后台项目

Cage 是通过 TypeScript 声明业务、由框架统一执行权限和数据规则的中后台框架。此包是框架的一部分。

## 使用

```powershell
pnpm create @yss123/cage-app my-app
```

交互终端用 ↑↓ 选择，Enter 确认；Ctrl+C 取消不会创建项目。省略项目名时还会询问目录。

| 模板 | 内容 |
| --- | --- |
| 空白业务项目 `blank` | 登录、用户/部门/角色、权限、系统管理和 AI 教材；采购源码仅存于 docs 供参考 |
| 采购示例项目 `purchase` | 完整采购、库存锁、审批、fake ERP 及业务页面 |

脚本或 CI 可跳过选择，必须明确指定目录和模板：

```powershell
pnpm create @yss123/cage-app my-app --template blank
pnpm create @yss123/cage-app purchase-demo --template purchase
```

双模板选择自 `0.2.0` 提供。要固定版本使用 `pnpm create @yss123/cage-app@0.2.0 my-app --template blank`；本地框架测试仍可在源码仓库运行 `node packages/cli/bin/cage.js create ../my-app --template blank --framework-path F:/cage`。

首次使用建议通过脚手架创建完整项目，所需依赖由模板统一配置。需要 Node.js 24 或更新版本。

- [完整使用说明](https://github.com/shunshunyue/cage/blob/main/docs/使用说明.md)
- [框架源码与范例](https://github.com/shunshunyue/cage)
- [问题反馈](https://github.com/shunshunyue/cage/issues)

许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
