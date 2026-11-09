/**
 * 把目录技术标识映射为系统管理页面的中文展示文字。
 * 目录由应用启动阶段加载，函数按现有 state.catalog 查找；默认文案只影响显示，不改能力标识、状态或授权规则。
 */
import { state } from './api.js';
import type { Capability, ScopeKind } from './types.js';

/**
 * 范围组合子的固定名称和说明，供角色范围编辑器复用。实际可见记录仍由聚合字段与服务端授权决定。
 */
export const scopes: Record<ScopeKind, { title: string; hint: string }> = {
  self: { title: '仅本人', hint: '仅查看归属于自己的记录' },
  dept: { title: '本部门', hint: '查看本人所在部门的记录' },
  deptSubtree: { title: '本部门及下级', hint: '查看本人部门及下属部门的记录' },
  deptSet: { title: '指定部门', hint: '仅查看所选部门的记录' },
  all: { title: '全部数据', hint: '查看当前租户内的全部记录' },
};
/**
 * 按聚合标识查找中文 label/description，没有独立中文名时返回通用对象名。
 */
export function objectName(name: string) {
  const object = state.catalog!.aggregates.find((item) => item.name === name);
  return object?.label && object.label !== name ? object.label : object?.description || '业务对象';
}
/**
 * 先使用能力目录解释操作名，再处理不属于目录的登录与运维审计动作。
 * 找不到映射时返回通用名称，原始 capability 仍应保留供诊断。
 */
export function capabilityName(capability: string) {
  const item = state.catalog!.capabilities.find((item) => item.capability === capability);
  if (item)
    return item.aggregate ? item.label.replaceAll(item.aggregate, objectName(item.aggregate)) : item.label;
  // 这些审计操作不属于领域能力目录，单独命名，避免登录和运维都显示成“业务操作”。
  const operations: Record<string, string> = {
    'auth.login': '账号登录',
    'deadLetter.replay': '重新投递事件',
    'deadLetter.discard': '丢弃死信事件',
    'job.enable': '启用定时任务',
    'job.disable': '停用定时任务',
  };
  return operations[capability] || '业务操作';
}
/**
 * 为不能由 user 直接调用的命令生成流程来源提示；含 user 或没有调用身份限制时返回空串。
 */
export function invocation(capability: Capability) {
  if (!capability.invokedBy || capability.invokedBy.includes('user')) return '';
  const names: Record<string, string> = {
    process: '审批流程',
    external: '外部系统',
    job: '定时任务',
    system: '系统内部',
    reaction: '自动反应',
  };
  return capability.invokedBy.map((item) => names[item] || '自动流程').join(' / ') + '调用';
}
/**
 * 组织与运行记录的常见状态文案表；展示映射不推断事件已完成或远端调用成功。
 */
export const statusNames: Record<string, string> = {
  active: '已启用',
  disabled: '已停用',
  archived: '已停用',
  pending: '等待处理',
  processing: '处理中',
  running: '执行中',
  done: '已完成',
  ok: '成功',
  failed: '失败',
  error: '失败',
  dead: '已进入死信',
  retry: '等待重试',
};
/**
 * 返回常见状态的中文说明，未知值显示待确认，避免将新状态误写为成功。
 */
export const statusName = (status: string) => statusNames[status] || '待确认';
/**
 * 从项目图谱 labels 查事件中文名，缺配置时只给通用说明。
 */
export const eventName = (name: string) => state.catalog!.labels[`event:${name}`] || '业务事件';
/**
 * 从当前目录查定时任务展示名；不读取调度执行状态或任务结果。
 */
export const jobName = (name: string) =>
  state.catalog!.jobs.find((item) => item.name === name)?.label || '定时任务';
