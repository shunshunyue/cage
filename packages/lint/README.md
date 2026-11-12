# @yss123/cage-lint

Cage 的静态边界：ESLint 检查手写业务路由、SQL 拼接、疑似密钥和 unsafe 说明；dependency-cruiser 检查 domain、contracts、Web 与服务端依赖方向。

## 使用推荐规则

Node.js 24+、ESLint 9，安装 pnpm add -D @yss123/cage-lint eslint@^9 dependency-cruiser。ESM 项目的 eslint.config.js：

```js
import cage from '@yss123/cage-lint';

/** 使用框架边界规则，应用可追加自身检查。 */
export default [...cage.configs.recommended];
```

依赖配置 .dependency-cruiser.cjs 使用公开子路径：

```js
module.exports = require('@yss123/cage-lint/dependency-cruiser.cjs');
```

从项目根目录运行 eslint packages apps 和 depcruise packages apps --config .dependency-cruiser.cjs；脚手架已配置相应依赖。

## 检查范围

cage/no-manual-routes 约束后端业务接口，不禁止 React Router。其他规则维护参数化 SQL、部署密钥和显式 unsafe 责任；领域不直接 IO，Web 不导入服务端，domain 不依赖 contracts。

检查基于语法与约定目录，不能证明任意程序没有漏洞，也不代替服务端授权或数据库回归。按诊断修复真实职责与依赖，保持门禁有效。

[代码组织](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/project-structure.md) · [错误码册](https://github.com/shunshunyue/cage/blob/main/docs/errors/README.md)
