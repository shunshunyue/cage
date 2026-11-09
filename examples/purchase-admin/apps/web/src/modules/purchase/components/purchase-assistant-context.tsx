/**
 * 采购模块与公共助理之间的语义适配层，提供采购字段、命令的中文展示名称。
 * 页面通过 context 显式传入当前所见，不导入领域运行时或自行获取越权数据。
 */
import type { PageContextInput } from '@yss123/cage-client';
import { AssistantPage } from '../../../shared/ui/assistant-scope';

// 页面只补充业务文案与上下文，工具发现、授权及命令执行全部使用框架 SDK。
/**
 * 将页面快照与建议问题注册到最近的 AssistantScope，不再创建第二个面板。
 * context 中的记录/草稿来源由页面负责；标签仅用于确认展示，工具与授权仍来自框架。
 */
export function PurchaseAssistantContext({ context, suggestions }: { context: PageContextInput; suggestions: string[] }) {
  return <AssistantPage context={context} suggestions={suggestions}
    fieldLabels={{ reason: '采购用途', amount: '金额', items: '物料', key: '偏好名称', value: '偏好内容', comment: '审批意见', outcome: '审批结果' }}
    commandLabels={{ 'PurchaseOrder.submit': '提交采购审批', 'PurchaseOrder.explainPurpose': '保存采购用途', 'PurchaseOrder.cancel': '取消采购单', 'PurchaseOrder.create': '新建采购单' }} />;
}
