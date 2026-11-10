# @yss123/cage-lint

Cage 的静态边界检查包。ESLint 规则检查手写业务路由、SQL 拼接、疑似密钥和缺少说明的 unsafe；dependency-cruiser 配置约束 domain、contracts、Web 与服务端的依赖方向。用于开发与 CI，不参与运行时授权。

## 安装

需要 Node.js 24+、ESLint 9；在应用根目录安装为开发依赖：

```powershell
pnpm add -D @yss123/cage-lint eslint@^9 dependency-cruiser
```

脚手架项目已经包含对应依赖与检查配置，升级时保留应用现有扩展规则。

## 接入 ESLint

在 ESM 项目的 `eslint.config.js` 中使用 flat config：

```js
/** 使用 Cage 推荐规则；后续可追加应用规则，不能为绕过门禁关闭边界检查。 */
import cage from '@yss123/cage-lint';

export default [...cage.configs.recommended];
```

执行：

```powershell
pnpm exec eslint packages apps
```

推荐配置包括 TypeScript/TSX 解析器，并排除依赖、构建产物、生成契约和 `.cage`。应从项目根目录运行，使相对路径规则与模板结构一致。

## 接入依赖方向检查

在项目根目录 `.dependency-cruiser.cjs` 中导出框架规则：

```js
/** 沿用框架的模块边界；本文件只配置静态依赖分析，不改变运行权限。 */
module.exports = require('@yss123/cage-lint/dependency-cruiser.cjs');
```

执行：

```powershell
pnpm exec depcruise packages apps --config .dependency-cruiser.cjs
```

也可在完整脚手架中运行 `pnpm exec cage check`，结合声明、目录与图规则检查定位问题。

## 包含哪些规则

| 规则/边界 | 目的 |
| --- | --- |
| `cage/no-manual-routes` | 普通业务通过声明生成路由，避免另写接口绕过统一流水线 |
| `cage/no-sql-concat` | 拒绝可识别的 SQL 字符串拼接，使用参数化安全查询 |
| `cage/no-secret-literal` | 检查疑似密钥字面量，真实值通过部署配置注入 |
| `cage/unsafe-needs-reason` | unsafe 需记录原因与责任，供审查和预算追踪 |
| domain 不直接 IO | 不导入文件/网络/数据库或 HTTP/文件服务实现 |
| Web 不导入服务端 | 前端消费 contracts、client 和浏览器安全协议 |
| domain 不反向依赖 contracts | 避免声明与生成契约形成依赖循环 |
| 适配器不直接写库 | 外部结果仍回到领域命令 |

本包默认导出插件与 `configs.recommended`，另有命名导出 `rules`；依赖规则通过公开子路径 `@yss123/cage-lint/dependency-cruiser.cjs` 获取。

检查基于语法与约定目录，不能证明任意代码不存在漏洞、SQL 注入或秘密，也不能替代后端授权与数据库回归。出现诊断时阅读 `code/at/reason/fix` 并修正职责归属，不通过删除约束或禁用 lint 消除报错。

## 文档

- [工程目录与模块组织](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/project-structure.md)
- [开发流程](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/workflow.md)
- [错误码册](https://github.com/shunshunyue/cage/blob/main/docs/errors/README.md)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
