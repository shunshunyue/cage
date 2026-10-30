// 门禁报错：每条都有错误码、位置、原因、修复方法，末尾附错误码册路径，agent 可以直接打开。

export interface Finding {
  code: string;
  /** 文件:行 */
  at?: string;
  reason: string;
  fix?: string;
  severity?: 'error' | 'warning';
}

export function formatFinding(f: Finding): string {
  const lines = [`  [${f.code}] ${f.at ?? ''}`.trimEnd(), `  原因：${f.reason}`];
  if (f.fix) lines.push(`  修复：${f.fix}`);
  lines.push(`  详见：docs/errors/${f.code}.md`);
  return lines.join('\n');
}

export function formatFindings(list: Finding[]): string {
  return list.map(formatFinding).join('\n\n');
}

export const errorsOnly = (list: Finding[]) => list.filter((f) => f.severity !== 'warning');
