/**
 * 把契约命令的失败结果转换为页面提示，集中维护本应用的错误码文案。
 * 请求追踪标识只用于排错关联，不能用显示文案代替对 ok/code 的控制流判断。
 */
import type { CageResult } from '@app/contracts';

/** 将框架错误码转换成操作提示，保留 requestId 供用户向维护人员反馈。 */
/**
 * 选取 domainCode（缺省时取 code）查文案，未知值保留错误码，并在存在 requestId 时附上短追踪标识。
 * @param r 已经判定 ok 为 false 的客户端结果，不接收成功数据。
 * @returns 适合 Notice 展示的错误描述；不会重试命令或修改结果。
 */
export function errorMessage(r: Extract<CageResult<unknown, string>, { ok: false }>): string {
  const labels: Record<string, string> = {
    FORBIDDEN: '你没有执行此操作的权限',
    INVALID_INPUT: '请检查填写内容',
    CONFLICT: '数据或任务已更新，请刷新后重试',
    UNAUTHENTICATED: '登录已过期',
    CONSTRAINT_VIOLATED: '未满足业务条件，请检查操作人及具体原因',
    STOCK_SHORT: '库存不足',
    REVIEWERS_REQUIRED: '请为专业会签选择 1–5 位协作人',
    REVIEWERS_NOT_REQUIRED: '取消专业会签时请清空复核人员',
    DUPLICATE_REVIEWERS: '专业会签人员不能重复',
    REVIEWER_IS_APPLICANT: '申请人不能担任本单专业会签人',
    REVIEWER_UNAVAILABLE: '所选人员已不可用，请重新核对协作名录',
    NETWORK: '连接失败，请稍后重试',
  };
  return `${labels[r.domainCode ?? r.code] ?? r.domainCode ?? r.code}${r.requestId ? ` · 请求 ${r.requestId.slice(0, 8)}` : ''}`;
}
