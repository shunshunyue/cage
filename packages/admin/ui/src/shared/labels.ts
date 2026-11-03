import { state } from './api.js';
import type { Capability, ScopeKind } from './types.js';

export const scopes: Record<ScopeKind, { title: string; hint: string }> = {
  self: { title: '仅本人', hint: '仅查看归属于自己的记录' },
  dept: { title: '本部门', hint: '查看本人所在部门的记录' },
  deptSubtree: { title: '本部门及下级', hint: '查看本人部门及下属部门的记录' },
  deptSet: { title: '指定部门', hint: '仅查看所选部门的记录' },
  all: { title: '全部数据', hint: '查看当前租户内的全部记录' },
};
export function objectName(name: string) {
  const object = state.catalog!.aggregates.find((item) => item.name === name);
  return object?.label && object.label !== name ? object.label : object?.description || '业务对象';
}
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
export const statusName = (status: string) => statusNames[status] || '待确认';
export const eventName = (name: string) => state.catalog!.labels[`event:${name}`] || '业务事件';
export const jobName = (name: string) =>
  state.catalog!.jobs.find((item) => item.name === name)?.label || '定时任务';
