// 同一业务的列表与详情共用展示口径；不把采购状态塞入全局 shared。
export const statusLabels: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已通过',
  received: '已收货',
  rejected: '已驳回',
  cancelled: '已取消',
};
export const currency = (value: string) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(Number(value));
