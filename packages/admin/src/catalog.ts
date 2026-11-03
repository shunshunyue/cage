import { sensitiveFields, type Registry } from '@yss123/cage-kernel';

/** 显示名沿用图谱的节点键；只影响文案，不重命名权限、命令、表或业务字段。 */
export type AdminLabels = Record<string, string>;

const actions: Record<string, string> = {
  create: '新建',
  read: '查看',
  export: '导出',
  update: '编辑',
  rename: '修改名称',
  delete: '删除',
  archive: '停用',
  enable: '启用',
  disable: '停用',
  submit: '提交',
  approve: '审批通过',
  reject: '驳回',
  cancel: '取消',
  revoke: '撤回',
  confirm: '确认',
  void: '作废',
  receive: '确认收货',
  markReceived: '确认收货',
  recordErpNo: '回写外部单号',
  acquire: '占用资源',
  release: '释放资源',
  assignRoles: '分配角色',
  setPassword: '重置密码',
  grantCapability: '授予操作权限',
  revokeCapability: '收回操作权限',
  setScope: '设置数据范围',
};
const sensitive: Record<string, string> = {
  phone: '手机号',
  email: '邮箱',
  idCard: '身份证号',
  bankCard: '银行卡号',
  name: '姓名',
  address: '地址',
};

/**
 * 展示目录独立于内核的授权目录。原始字段继续提供给 API 调用者，额外 label 专供界面使用。
 * 自定义业务名称来自项目声明或 labels，框架不猜测客户术语；缺少中文时明确提示需要命名。
 */
export function adminCatalog(registry: Registry, labels: AdminLabels = {}) {
  const aggregates = registry.aggregates.map((a) => {
    const label = labels[`aggregate:${a.name}`] || a.description || a.name;
    return {
      name: a.name,
      description: a.description ?? null,
      label,
      states: a.states.values,
      scope: { deptField: a.scope.deptField ?? null, ownerField: a.scope.ownerField ?? null },
      sensitive: sensitiveFields(a),
    };
  });
  const names = new Map(aggregates.map((a) => [a.name, a.label]));
  const capabilities = registry.capabilityCatalog().map((c) => {
    const subject = names.get(c.aggregate ?? '') ?? '';
    const action = c.capability.split('.').at(-1)!;
    const override = labels[`capability:${c.capability}`] || labels[`command:${c.capability}`];
    // 内核的 read/export 文案可能含英文聚合名，重组后才能复用项目提供的中文名称。
    const label =
      override ||
      (c.kind === 'read'
        ? `查看${subject}`
        : c.kind === 'export'
          ? `导出${subject}`
          : c.kind === 'unmask'
            ? `查看${sensitive[action] ?? '敏感字段'}明文`
            : c.description || actions[action] || '自定义操作');
    return { ...c, label };
  });
  return {
    capabilities,
    aggregates,
    combinators: ['self', 'dept', 'deptSubtree', 'deptSet', 'all'],
    approvals: registry.approvals.map(({ a, name }) => ({
      name,
      process: a.process,
      aggregate: a.agg.name,
      routable: a.routable,
      label: labels[`approval:${name}`] || a.process,
    })),
    jobs: registry.jobs.map((j) => ({
      name: j.name,
      cron: j.cron,
      description: j.description ?? null,
      label: labels[`job:${j.name}`] || j.description || j.name,
    })),
    // 事件、状态和连接器也能复用图谱文案，供审计、待办和运维页面解释业务标识。
    labels,
  };
}
