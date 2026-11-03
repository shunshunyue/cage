// 图谱每次刷新都在独立进程抽取。ESM 会缓存 domain 及其依赖；只给入口添加
// 时间戳无法刷新所有间接导入，因此不在常驻 Web 服务里重复 import domain。
import { analyze } from './analyze.js';
import { loadConfig } from './config.js';
import type { Finding } from './findings.js';
import type { Ontology } from './ontology.js';
import { graphPresentation, type GraphPresentation } from './graph-presentation.js';

export interface GraphSnapshot {
  project: string;
  domain: string;
  generatedAt: string;
  graph: Ontology;
  findings: Finding[];
  presentation: GraphPresentation;
  /** 仅保存在本地抽取快照；HTTP 按节点提供，不能接受任意文件路径。 */
  sources?: Record<string, GraphSource>;
}

export interface GraphSource {
  file: string;
  line: number;
  endLine: number;
  exportName: string;
  code: string;
}

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
