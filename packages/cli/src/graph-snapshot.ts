/**
 * 独立抽取子进程的入口，由 collectGraph fork 启动并通过 IPC 交付快照。
 * 加载指定应用配置，分析声明后同时保存语义图、展示标签、发现的问题及注册声明代码片段。
 * 普通导入不刷新 ESM 依赖缓存，因此每次抽取使用新进程；只交付本次已读源码，不开放任意路径读取。
 */
// 图谱每次刷新都在独立进程抽取。ESM 会缓存 domain 及其依赖；只给入口添加
// 时间戳无法刷新所有间接导入，因此不在常驻 Web 服务里重复 import domain。
import { analyze } from './analyze.js';
import { loadConfig } from './config.js';
import type { Finding } from './findings.js';
import type { Ontology } from './ontology.js';
import { graphPresentation, type GraphPresentation } from './graph-presentation.js';

/**
 * 单次独立进程抽取的完整快照，图、问题、标签和可选代码片段属于同一时刻。
 */
export interface GraphSnapshot {
  /** 项目显示名称。 */
  project: string;
  /** 本次加载的领域入口路径。 */
  domain: string;
  /** 本次抽取完成时间的 ISO 字符串。 */
  generatedAt: string;
  /** 单次抽取所得语义本体。 */
  graph: Ontology;
  /** 静态和图规则诊断，图可展示时也需保留错误。 */
  findings: Finding[];
  /** 不参与业务身份的中文标题和描述索引。 */
  presentation: GraphPresentation;
  /** 仅保存在本地抽取快照；HTTP 按节点提供，不能接受任意文件路径。 */
  sources?: Record<string, GraphSource>;
}

/**
 * 静态扫描保存的声明源码片段，供按已注册节点读取，行号为一基。
 */
export interface GraphSource {
  /** 已索引声明所在的项目相对路径。 */
  file: string;
  /** 源码片段起始行，从 1 计数。 */
  line: number;
  /** 源码片段终止行，从 1 计数并包含末行。 */
  endLine: number;
  /** 当前源码声明的导出名称。 */
  exportName: string;
  /** 允许展示的声明片段；服务按已知节点读取此值。 */
  code: string;
}

/**
 * 按子进程参数加载应用并通过 IPC 交付一次快照。
 * 静态错误导致没有图时抛出；可抽取的图规则错误仍随 findings 交付。
 * 完成发送后由入口断开 IPC；不监听业务文件，也不执行具体命令。
 */
async function collect() {
  const cfg = loadConfig(process.argv[2]);
  const result = await analyze(cfg);
  if (!result.graph) {
    throw new Error(result.findings.map((f) => `[${f.code}] ${f.reason}`).join('\n'));
  }
  // 有图规则问题时仍展示图和问题列表，开发者可以借助关系图定位错误。
  const snapshot: GraphSnapshot = {
    project: cfg.name,
    domain: cfg.domain,
    generatedAt: new Date().toISOString(),
    graph: result.graph,
    findings: result.findings,
    presentation: graphPresentation(cfg, result.registry!),
    // 复用本次静态检查已读到的声明，预览和图谱始终对应同一时刻；
    // 请求代码时不重新读磁盘，避免旧行号错指及任意文件读取。
    sources: Object.fromEntries(
      result.graph.nodes.flatMap((node) => {
        const site = result.source.sites.find((s) => s.file === node.file && s.line === node.line);
        return site
          ? [
              [
                `${node.kind}:${node.id}`,
                {
                  file: site.file,
                  line: site.line,
                  endLine: site.line + site.text.split('\n').length - 1,
                  exportName: site.exportName,
                  code: site.text,
                },
              ],
            ]
          : [];
      }),
    ),
  };
  process.send!({ snapshot });
}

collect()
  .catch((error: Error) => {
    process.send!({ error: error.message });
    process.exitCode = 1;
  })
  .finally(() => process.disconnect());
