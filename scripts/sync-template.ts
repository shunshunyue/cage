/**
 * 从标准采购范例重建分发快照，并向两套模板复制共享配置、教材和错误码册。
 * 采购模板的源码目录由此脚本拥有；空白模板只覆盖显式共享项，其领域和页面独立维护。
 * 空白模板中的采购代码放到 docs/examples 作为离线参考，不参与 workspace 注册。
 * 脚本会重写模板资源和说明文件，但不处理业务数据库；运行前先同步范例 AGENTS 托管区。
 */
// 采购模板同步标准范例；空白模板只共享基础配置，其领域和页面单独维护。
// 不通过复制采购业务再删除文件构造空白项目，避免新增范例功能意外混入空白项目。
// 框架包始终通过依赖引用。模板同时携带本地 框架教材，创建后无需访问框架源码。
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackageManifest } from './release-utils.ts';
import { syncAgentSkill } from './sync-agent-skill.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
// 发布版本取自 CLI 包清单；模板不能继续依赖某个写死的历史版本。
const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
const target = join(root, 'templates/app');
const blank = join(root, 'templates/blank');
mkdirSync(target, { recursive: true });
/**
 * 以下目录是可重建的模板快照。先移除旧快照再复制，避免改目录后旧平铺源码继续被分发。
 * 删除目标必须在指定模板所有者内；不触碰范例、本机配置、node_modules 或迁移历史。
 */
function resetManagedSource(owner: string, path: string) {
  const directory = resolve(owner, path);
  if (!directory.startsWith(resolve(owner) + sep)) throw new Error(`模板快照路径越界：${directory}`);
  rmSync(directory, { recursive: true, force: true });
}
const sourceDirectories = ['packages/domain/src', 'packages/contracts/src', 'apps/api/src', 'apps/web/src'];
for (const directory of sourceDirectories) resetManagedSource(target, directory);
cpSync(join(root, 'examples/purchase-admin'), target, {
  recursive: true,
  filter: (path) =>
    !/(^|[\\/])(node_modules|dist|\.cage|\.cage-files|generated|\.turbo)([\\/]|$)/.test(path) &&
    // 本地凭证不可进入模板；只有不含密钥的 .env.example 可以分发。
    (!/^\.env(?:\..+)?$/.test(basename(path)) || basename(path) === '.env.example') &&
    // Docker Compose 仅供框架维护者测试，不属于业务应用脚手架。
    basename(path) !== 'compose.yaml',
});
writeFileSync(
  join(target, 'pnpm-workspace.yaml'),
  "packages:\n  - apps/*\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\n  - embedded-postgres\n  - '@embedded-postgres/windows-x64'\n  - '@embedded-postgres/linux-x64'\n  - '@embedded-postgres/darwin-arm64'\n  - '@embedded-postgres/darwin-x64'\n",
);
writeFileSync(
  // npm 打包会排除 .gitignore，使用占位文件分发，创建项目时再改回正式文件名。
  join(target, '_gitignore'),
  'node_modules/\ndist/\n.cage/\n.cage-files/\ngenerated/\n.env\n.env.*\n!.env.example\n*.log\n',
);
cpSync(join(root, 'renovate.json'), join(target, 'renovate.json'));
// 这份清单限定两种模板共享的薄壳；空白项目的 src、配置、迁移不被采购模板覆盖。
for (const path of [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '_gitignore',
  '.env.example',
  '.dockerignore',
  'Dockerfile',
  'deploy/nginx.conf',
  'renovate.json',
  '.github/workflows/cage.yml',
  'packages/domain/package.json',
  'packages/domain/tsconfig.json',
  'packages/contracts/package.json',
  'packages/contracts/tsconfig.json',
  'apps/api/package.json',
  'apps/api/tsconfig.json',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/web/vite.config.ts',
]) {
  mkdirSync(dirname(join(blank, path)), { recursive: true });
  cpSync(join(target, path), join(blank, path));
}
const blankPackage = JSON.parse(readFileSync(join(blank, 'package.json'), 'utf8'));
blankPackage.name = '@app/business-app';
writeFileSync(join(blank, 'package.json'), JSON.stringify(blankPackage, null, 2) + '\n');
const blankApi = JSON.parse(readFileSync(join(blank, 'apps/api/package.json'), 'utf8'));
delete blankApi.dependencies['@yss123/cage-connectors'];
writeFileSync(join(blank, 'apps/api/package.json'), JSON.stringify(blankApi, null, 2) + '\n');
// 会话、登录回跳和页面级状态属于共享应用基础设施；页面与路由表仍由各模板独立维护。
for (const path of [
  'app/use-session.ts',
  'shared/lib/navigation.ts',
  'shared/ui/page-state.tsx',
  'shared/ui/page-state.css',
  'shared/ui/require-capability.tsx',
]) {
  const destination = join(blank, 'apps/web/src', path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(target, 'apps/web/src', path), destination);
}
// 指南与错误码册各保留一个人工维护来源，在这里形成模板快照。
// 所有链接均以业务项目为上下文，不能依赖框架仓库中的 packages/kernel 等目录。
for (const application of [target, blank]) {
  // 这些教材目录完全由框架拥有；先清理再复制，使已删除的指南和课程代码不会留在分发快照。
  for (const directory of ['docs/development', 'docs/errors']) resetManagedSource(application, directory);
  cpSync(join(root, 'docs/development'), join(application, 'docs/development'), { recursive: true });
  cpSync(join(root, 'docs/errors'), join(application, 'docs/errors'), { recursive: true });
  // 独立项目只带开发教材和错误码，文档目录入口不引用框架维护者的设计/发布/验收资料。
  writeFileSync(
    join(application, 'docs/README.md'),
    '# 本地框架文档\n\n从 [框架学习入口](development/README.md) 或 [Cage 开发 Skill](development/skills/cage-development/SKILL.md) 开始。\n\n- `development/getting-started`：运行模型、完整入门课和开发步骤。\n- `development/guides`：[业务澄清与共同设计](development/guides/business-collaboration.md)、能力选择与各专题接入。\n- `development/reference`：原语与工程规范。\n- `development/tools`：诊断、本体查询和排错。\n- `development/examples`：教学源码与采购导读。\n- `development/skills`：框架开发方法。\n- [错误码册](errors/README.md)：按实际错误定位原因。\n',
  );
  syncAgentSkill(application);
}
syncAgentSkill(root);

// 空白项目仍要能离线学习完整范例；参考源码放在工作区和 domain 之外，
// 没有 package.json，不会被 pnpm 当作应用包，也不会被 CLI 注册或生成业务表。
const reference = join(blank, 'docs/examples/purchase-admin');
for (const path of [...sourceDirectories, 'cage.config.json']) {
  if (sourceDirectories.includes(path)) resetManagedSource(reference, path);
  mkdirSync(dirname(join(reference, path)), { recursive: true });
  cpSync(join(target, path), join(reference, path), { recursive: true });
}
writeFileSync(
  join(reference, 'README.md'),
  `# 采购范例参考源码\n\n本目录只供阅读，不参与应用编译、注册、运行或迁移。当前应用的真实领域入口是项目根目录 packages/domain/src/index.ts。\n\n按 [采购范例导读](../../development/examples/purchase-example.md) 阅读；导读中的范例路径在本目录下查找。需要可运行的完整采购项目时，重新使用 create-cage-app --template purchase 创建新目录，不要直接把整套业务导入空白项目。\n`,
);

// 范例在仓库里使用根文档；用户得到的项目使用本地文档，因此项目说明单独生成。
// 框架托管区保持与范例一致，不维护第二份规则文本。
const sourceAgents = readFileSync(join(root, 'examples/purchase-admin/AGENTS.md'), 'utf8');
const managed = sourceAgents.match(/<!-- cage:begin[^\n]*-->[\s\S]*?<!-- cage:end -->/);
if (!managed) throw new Error('请先在标准范例执行 cage sync，补齐 AGENTS.md 托管区');
writeFileSync(
  join(target, 'AGENTS.md'),
  `# 本项目的业务开发说明

这是 create-cage-app 生成的业务项目，当前包含采购演示，可逐步替换成客户业务。业务源码在本项目，框架通过 @yss123/cage-* 依赖提供。

先读 [业务开发指南](docs/development/README.md)，按需求查 [任务配方](docs/development/guides/recipes.md)、[完整采购范例](docs/development/examples/purchase-example.md) 和 [错误码册](docs/errors/README.md)。这些资料就在项目内，无需克隆框架仓库。

## 项目自己的业务约定

客户术语、角色权限、状态规则、第三方协议和验收标准写在本节或独立业务文档，再从这里链接。新增业务以用户需求为准，不因模板包含采购示例就固定实现采购流程。

本节位于托管区之外，cage sync 会保留。下面的托管区提供框架工作方法。

${managed[0]}
`,
);
writeFileSync(
  join(blank, 'AGENTS.md'),
  `# 本项目的业务开发说明

这是 create-cage-app 的空白业务项目。真实运行的 domain 仅包含用户、部门和角色组织模型；从 packages/domain/src 新建客户自己的业务，再从 index.ts 导出。框架通过 @yss123/cage-* 依赖提供。

先读 [业务开发指南](docs/development/README.md)、[任务配方](docs/development/guides/recipes.md) 和 [错误码册](docs/errors/README.md)。[采购范例参考源码](docs/examples/purchase-admin/README.md) 只用于学习，未注册到应用；导读中的采购路径在 docs/examples/purchase-admin 下查找。普通业务路径仍相对项目根目录。

## 项目自己的业务约定

客户术语、角色权限、状态规则、第三方协议和验收标准写在本节或链接到独立文档。按客户需求新增业务，不要为了让空白页面有内容而复制采购演示、演示数据或伪造统计。

本节位于托管区之外，cage sync 会保留。下面的托管区提供框架工作方法。

${managed[0]}
`,
);
// README 共享启动与演示流程，但独立应用的学习链接必须指向自己的 docs。
const readme = readFileSync(join(root, 'examples/purchase-admin/README.md'), 'utf8')
  .replace('# 采购工作台', '# Cage 业务应用（含采购示例）')
  .replace(
    '在框架仓库根目录执行 `pnpm install`、`pnpm build`，然后进入本目录。独立模板项目先执行 `pnpm install`、`pnpm build:app`。',
    '在本项目根目录执行 `pnpm install`、`pnpm build:app`；无需克隆或构建框架仓库。',
  )
  .replaceAll('(../../docs/', '(docs/');
writeFileSync(join(target, 'README.md'), readme);
// 脚手架首次创建会再次按所选版本统一替换；模板本身也不残留 workspace:* 框架版本。
/**
 * 递归规范模板清单中的框架依赖版本，取当前 CLI 版本替换 workspace 或旧版本。
 * 跳过依赖、构建及运行目录；仅处理 dependencies/devDependencies，不执行安装或修改领域代码。
 */
function manifests(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', '.cage', 'generated', '.turbo'].includes(entry.name))
      manifests(file);
    else if (entry.name === 'package.json') {
      const p: PackageManifest = JSON.parse(readFileSync(file, 'utf8'));
      for (const group of ['dependencies', 'devDependencies'] as const) {
        const dependencies = p[group];
        for (const name of Object.keys(dependencies ?? {})) {
          if (name.startsWith('@yss123/cage-')) dependencies![name] = version;
        }
      }
      writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
    }
  }
}
manifests(target);
manifests(blank);
