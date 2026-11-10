/**
 * 模块化应用的目录与公开入口门禁，随 analyze 在领域求值前执行。
 * 检查 domain、Web 的允许层次、模块入口以及跨模块引用边界，用诊断定位不符合约定的文件。
 * 只在 structure=modular 时启用，不自动移动代码、不修改路径；文本与 AST 检查不能替代业务分层设计。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { abs, type CageConfig } from './config.js';
import type { Finding } from './findings.js';
import { listTs } from './static-check.js';

/**
 * 相对 src 的源码层和可选模块归属；模块外文件不伪造模块名。
 */
interface Area {
  /** 模块路径归属的层，如 app/modules/shared 或领域工作流。 */
  layer: string;
  /** 模块标识，shared/app 等非业务模块路径可缺省。 */
  module?: string;
  /** 相对对应源码根的规范化路径，供入口边界判断。 */
  path: string;
}

/** 相对 src 识别归属；检查目录职责，不强迫小模块拆出空的 components/hooks 文件夹。 */
function area(root: string, file: string): Area | undefined {
  const path = relative(root, file).replace(/\\/g, '/');
  if (isAbsolute(path) || path.startsWith('../') || path === '..') return;
  const parts = path.split('/');
  return {
    layer: parts.length === 1 ? 'entry' : parts[0],
    module: parts[0] === 'modules' ? parts[1] : undefined,
    path,
  };
}

/**
 * 目录规则只在 structure: modular 的应用启用，不约束框架自身或旧应用。
 * 使用 TypeScript 的模块解析处理 .js 源码导入、目录 index 和 tsconfig paths，
 * 这样换用别名也不能绕过模块边界。这里只读源码，绝不加载或执行页面模块。
 */
/**
 * 检查模块布局及跨层导入，发现问题只返回诊断。
 * @param cfg structure=modular 才启用；源码位置由应用配置决定。
 * @returns CAGE-STRUCT 诊断；缺少一侧目录时跳过，不移动代码或改写导入。
 */
export function checkProjectStructure(cfg: CageConfig): Finding[] {
  if (cfg.structure !== 'modular') return [];
  const findings: Finding[] = [];
  for (const kind of ['domain', 'web'] as const) {
    const root = kind === 'domain' ? dirname(abs(cfg, cfg.domain)) : abs(cfg, join(cfg.web, 'src'));
    if (!existsSync(root)) continue;
    const entry = kind === 'domain' ? resolve(abs(cfg, cfg.domain)) : join(root, 'main.tsx');
    const layers =
      kind === 'domain' ? ['modules', 'workflows', 'integrations', 'shared'] : ['app', 'modules', 'shared'];
    const configFile = ts.findConfigFile(dirname(root), ts.sys.fileExists);
    const options = configFile
      ? ts.parseJsonConfigFileContent(
          ts.readConfigFile(configFile, ts.sys.readFile).config,
          ts.sys,
          dirname(configFile),
        ).options
      : { moduleResolution: ts.ModuleResolutionKind.Bundler };
    const resolutionCache = ts.createModuleResolutionCache(cfg.root, (name) => name, options);

    for (const file of listTs(root)) {
      const from = area(root, file)!;
      const at = relative(cfg.root, file).replace(/\\/g, '/');
      if (
        (from.layer === 'entry' && resolve(file) !== entry) ||
        (from.layer !== 'entry' && !layers.includes(from.layer))
      ) {
        findings.push({
          code: 'CAGE-STRUCT-001',
          at,
          reason: `${kind} 源码没有放入约定模块：${from.path}`,
          fix: `src 根目录只保留${kind === 'domain' ? '领域 index.ts' : '浏览器 main.tsx'}；业务按归属放入 ${layers.join(' / ')}，见 docs/development/reference/project-structure.md`,
        });
      }
      const source = readFileSync(file, 'utf8');
      // preProcessFile 同时收集 import、export ... from 和字面量动态导入，防止转导出绕过边界。
      for (const spec of ts.preProcessFile(source, true, true).importedFiles) {
        const target = ts.resolveModuleName(
          spec.fileName,
          file,
          options,
          ts.sys,
          resolutionCache,
        ).resolvedModule;
        const to = target && area(root, target.resolvedFileName);
        if (!to) continue;
        let reason: string | undefined;
        if (from.layer === 'shared' && to.layer !== 'shared') reason = 'shared 不能依赖业务模块或应用组合层';
        else if (from.layer === 'modules') {
          if (
            kind === 'web' &&
            to.layer !== 'shared' &&
            !(to.layer === 'modules' && from.module === to.module)
          )
            reason = '前端模块只依赖本模块与 shared；跨业务页面由 app 组合或通过参数协作';
          if (kind === 'domain' && !['modules', 'shared'].includes(to.layer))
            reason = '领域模块不能反向依赖 workflows、integrations 或领域总入口';
        }
        // 聚合间允许单向 reads/命令依赖，但其他模块必须经过 index，避免内部文件成为事实公共 API。
        if (
          !reason &&
          to.layer === 'modules' &&
          from.module !== to.module &&
          to.path !== `modules/${to.module}/index.ts`
        )
          reason = '跨模块导入必须经过目标模块的 index.ts 公开入口';
        if (
          !reason &&
          kind === 'web' &&
          from.layer === 'entry' &&
          to.layer !== 'app' &&
          to.layer !== 'shared'
        )
          reason = '浏览器入口只挂载 app 和共享基础设施，不直接组装业务页面';
        if (!reason && kind === 'domain' && from.layer === 'integrations' && to.layer === 'workflows')
          reason = '连接器不能反向依赖跨模块流程；流程和外部协议分别组合领域声明';
        if (reason)
          findings.push({
            code: 'CAGE-STRUCT-002',
            at: `${at}:${source.slice(0, spec.pos).split('\n').length}`,
            reason: `${reason}（${spec.fileName}）`,
            fix: '调整依赖归属；共用纯逻辑下沉到 shared，页面协作由 app 传参，领域交互通过模块公开声明。见 docs/development/reference/project-structure.md',
          });
      }
    }
  }
  return findings;
}
