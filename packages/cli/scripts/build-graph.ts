// 浏览器页面仅依赖本地 ES 模块。TypeScript 编译器负责完整类型检查；此处只做
// 语法转译和复制，无需为 CLI 添加前端框架、远程字体或打包器依赖。
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import ts from 'typescript';

const base = new URL('../', import.meta.url);
const output = new URL('graph-ui/', base);
mkdirSync(output, { recursive: true });
for (const [directory, name] of [
  ...[
    'app',
    'model',
    'relations',
    'structure',
    'business',
    'flowchart',
    'flowchart-interaction',
    'approval-flow',
  ].map((name) => ['ui', name]),
  ...['graph-model', 'graph-relations', 'graph-search', 'graph-business', 'graph-approvals'].map((name) => [
    'src',
    name,
  ]),
]) {
  const source = readFileSync(new URL(`${directory}/${name}.ts`, base), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: `${name}.ts`,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, removeComments: false },
  });
  // ui/ 和 src/ 的共享纯函数在分发时位于同一资源目录，固定重定位这些内部导入。
  // 不复制 Node 查询/文件读取模块进浏览器，也不暴露任意源码路径。
  writeFileSync(new URL(`${name}.js`, output), outputText.replaceAll('../src/graph-', './graph-'));
}
for (const name of ['index.html', 'style.css', 'business.css'])
  copyFileSync(new URL(`ui/${name}`, base), new URL(name, output));
