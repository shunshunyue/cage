/**
 * 静态分析与门禁共享的诊断数据和终端格式化工具。
 * 规则产生 code、位置、原因与可选修复建议，再由这里关联本地错误码册。
 * 格式化是纯文本转换；severity 省略时按错误处理，只有明确 warning 才不阻止门禁。
 */
// 门禁报错：每条都有错误码、位置、原因、修复方法，末尾附错误码册路径，agent 可以直接打开。

/**
 * 静态检查和门禁的一条诊断，按 code 链接逐码说明，支持可选源码位置与修复方向。severity 缺省按错误处理。
 */
export interface Finding {
  /** 稳定 CAGE 错误码，链接到统一错误码册。 */
  code: string;
  /** 文件:行 */
  at?: string;
  /** 具体失败原因，不仅是错误类别标题。 */
  reason: string;
  /** 可选可执行修复建议；不存在时由上层补通用定位信息。 */
  fix?: string;
  /** warning 不阻断 errorsOnly；缺省按 error 处理。 */
  severity?: 'error' | 'warning';
}

/**
 * 生成单条人类可读诊断及本地错误码册路径。
 * @param f 原始诊断，缺位置或 fix 时对应行按实现省略。
 * @returns 多行文本；不读取或验证目标文档。
 */
export function formatFinding(f: Finding): string {
  const lines = [`  [${f.code}] ${f.at ?? ''}`.trimEnd(), `  原因：${f.reason}`];
  if (f.fix) lines.push(`  修复：${f.fix}`);
  lines.push(`  详见：docs/errors/${f.code}.md`);
  return lines.join('\n');
}

/**
 * 按输入顺序拼接诊断，空列表返回空字符串。
 * @param list 不会被修改的诊断数组。
 * @returns 条目间空行分隔的终端文本。
 */
export function formatFindings(list: Finding[]): string {
  return list.map(formatFinding).join('\n\n');
}

/**
 * 筛选阻止门禁的诊断，只有显式 warning 被排除。
 * @param list 原始列表，不会被修改。
 * @returns severity 缺省或为 error 的条目。
 */
export const errorsOnly = (list: Finding[]) => list.filter((f) => f.severity !== 'warning');
