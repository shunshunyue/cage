// 浏览器页面仅依赖本地 ES 模块。TypeScript 负责完整类型检查；此处只做
// 语法转译和复制，无需为 CLI 添加前端框架、远程字体或打包器依赖。
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import ts from 'typescript';

const base = new URL('../', import.meta.url);
const output = new URL('graph-ui/', base);
mkdirSync(output, { recursive: true });
for (const name of ['app', 'model', 'relations', 'structure']) {
  const source = readFileSync(new URL(`ui/${name}.ts`, base), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: `${name}.ts`,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, removeComments: false },
  });
  writeFileSync(new URL(`${name}.js`, output), outputText);
}
for (const name of ['index.html', 'style.css'])
  copyFileSync(new URL(`ui/${name}`, base), new URL(name, output));
