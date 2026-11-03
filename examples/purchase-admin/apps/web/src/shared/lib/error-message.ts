import type { CageResult } from '@app/contracts';

/** 将框架错误码转换成操作提示，保留 requestId 供用户向维护人员反馈。 */
export function errorMessage(r: Extract<CageResult<unknown, string>, { ok: false }>): string {
  const labels: Record<string, string> = {
    FORBIDDEN: '你没有执行此操作的权限',
    INVALID_INPUT: '请检查填写内容',
    CONFLICT: '单据已更新，请刷新后重试',
    UNAUTHENTICATED: '登录已过期',
    CONSTRAINT_VIOLATED: '未满足审批条件，请检查审批人或额度',
    STOCK_SHORT: '库存不足',
    NETWORK: '连接失败，请稍后重试',
  };
  return `${labels[r.domainCode ?? r.code] ?? r.domainCode ?? r.code}${r.requestId ? ` · 请求 ${r.requestId.slice(0, 8)}` : ''}`;
}
