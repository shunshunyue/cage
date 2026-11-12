// 阅读规格引用真实命令与审批；人工收货通知与自动锁库存分别表达。
import { businessProcess } from '@yss123/cage-kernel';
import { PurchaseOrder, create, submit, approve, reject, cancel, markReceived, poApproval, returnForChanges, explainPurpose } from '../modules/purchase/index.js';
import { InventoryLock, acquireLock, releaseLock } from '../modules/inventory/index.js';

/**
 * 面向人和 agent 的流程阅读规格，引用真实命令、审批和资源对象，供本体图展示及一致性检查。
 * stages/transitions 说明人工、自动和等待关系，本声明本身不调度命令，也不新增权限或运行时副作用。
 * 自动动作的真实事务和异步边界分别以 approval、reaction、connector 声明为准。
 */
export const purchaseLifecycle = businessProcess('purchase-lifecycle', {
  title: '采购全流程', description: '从填写申请、提交审批到确认收货，查看库存占用与释放。',
  area: { id: 'purchase', title: '采购管理', description: '采购申请、审批、收货与库存协作。' },
  subject: PurchaseOrder, entry: 'create',
  stages: {
    create: { title: '填写采购申请', description: '录入采购金额和明细，保存采购草稿。', actor: '申请人', action: create },
    submit: { title: '提交申请', description: '检查明细并提交采购审批。', actor: '申请人', action: submit },
    approval: { title: '采购审批', description: 'AI 先核查材料；通过后部门经理审批，金额超过五万元时增加财务审批。疑难材料由本步骤转人工。', actor: 'AI、部门经理、财务', kind: 'decision', action: poApproval },
    returned: { title: '退回修改', description: '材料不足退回草稿，保留本轮审核理由。', actor: '审批流程', action: returnForChanges },
    revise: { title: '补充采购用途', description: '依据建议补充用途，再次提交后从 AI 预审开始。', actor: '申请人', action: explainPurpose },
    approved: { title: '批准并锁定库存', description: '审批结论通过权限和库存校验后，同事务锁定所需库存。', actor: '审批流程与系统', action: approve,
      related: [{ object: InventoryLock, label: '同事务锁库存', via: acquireLock }] },
    received: { title: '确认收货', description: '接收外部收货通知并更新采购单，异步释放库存锁。', actor: '外部系统与系统', kind: 'end', action: markReceived,
      related: [{ object: InventoryLock, label: '收货后释放占用', via: releaseLock }] },
    rejected: { title: '审批驳回', description: '驳回结论通过领域命令落到采购单，本范例此轮采购结束。', actor: '审批流程', kind: 'end', action: reject },
    cancelled: { title: '取消采购', description: '申请人取消采购；若已批准则按实际映射释放库存占用。', actor: '申请人', kind: 'end', action: cancel,
      related: [{ object: InventoryLock, label: '按原状态释放占用', via: releaseLock }] },
  },
  transitions: [
    { from: 'create', to: 'submit', mode: 'manual', label: '填写完成后提交' },
    { from: 'submit', to: 'approval', mode: 'automatic', label: '提交成功后启动审批' },
    { from: 'approval', to: 'approved', mode: 'automatic', label: '审批通过' },
    { from: 'approval', to: 'rejected', mode: 'automatic', label: '审批驳回' },
    { from: 'approval', to: 'returned', mode: 'automatic', label: '材料不足' },
    { from: 'returned', to: 'revise', mode: 'manual', label: '补充材料' },
    { from: 'revise', to: 'submit', mode: 'manual', label: '重新提交' },
    { from: 'approved', to: 'received', mode: 'wait', label: '等待外部收货通知' },
    { from: 'create', to: 'cancelled', mode: 'manual', label: '取消草稿', branch: true },
    { from: 'submit', to: 'cancelled', mode: 'manual', label: '取消审批中的采购', branch: true },
    { from: 'approved', to: 'cancelled', mode: 'manual', label: '取消已批准采购', branch: true },
  ],
});
