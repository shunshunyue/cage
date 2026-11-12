/**
 * 审批课程的浏览器调用示例，页面事件可以复用这些方法并处理返回的 CageResult。
 * 只依赖生成契约和客户端；提交由用户明确触发，决定基于真实待办的 revision，不导入 process 命令。
 * 本文件随教材分发且由隔离课程检查编译，不在空白应用中自动执行或注册页面。
 */
import { client, reviewRequest } from '@app/contracts';

/** 用申请说明创建草稿，返回服务端成功/失败；页面成功后读取记录，失败保留输入。 */
export function createRequest(reason: string) {
  return reviewRequest.create({ reason });
}

/** 提交已读取的草稿版本；返回成功只表示提交，待办需要由 worker 后续创建。 */
export function submitRequest(id: string, version: number) {
  return reviewRequest.submit(id, version);
}

/** 撤回当前版本并通过事件关闭待办；页面重新读取状态，冲突不能静默重试。 */
export function withdrawRequest(id: string, version: number) {
  return reviewRequest.withdraw(id, version);
}

/** 读取当前用户本人待办，页面展示后由用户选择；返回列表不自动批准其中任何任务。 */
export function requestTasks() {
  return client.approvalTasks();
}

/**
 * 提交用户已明确选择的通过/驳回，任务 ID 和 revision 来自最近的待办读取，comment 为用户意见。
 * 返回 CageResult 供页面显示失败或刷新，领域最终状态由审批引擎调用受保护的 process 命令决定。
 */
export function decideRequest(taskId: string, revision: number, outcome: 'approve' | 'reject', comment: string) {
  return client.decideApprovalTask(taskId, outcome, { expectedRevision: revision, comment });
}
