/**
 * 采购页面共享的展示映射与金额格式；不承载状态迁移、权限或精确金额计算。
 */
// 同一业务的列表与详情共用展示口径；不把采购状态塞入全局 shared。
/**
 * 采购记录状态到中文名称的界面映射，状态合法性与迁移规则仍以领域声明为准。
 */
export const statusLabels: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已通过',
  received: '已收货',
  rejected: '已驳回',
  cancelled: '已取消',
};
/**
 * 把以元表示的金额字符串转为人民币格式显示；Number 转换只用于展示，不能用于账务计算。
 */
export const currency = (value: string) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(Number(value));
