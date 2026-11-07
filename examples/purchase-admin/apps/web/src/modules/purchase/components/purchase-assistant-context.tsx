import type { PageContextInput } from '@yss123/cage-client';
import { AssistantPage } from '../../../shared/ui/assistant-scope';

// 页面只补充业务文案与上下文，工具发现、授权及命令执行全部使用框架 SDK。
export function PurchaseAssistantContext({ context, suggestions }: { context: PageContextInput; suggestions: string[] }) {
  return <AssistantPage context={context} suggestions={suggestions}
    fieldLabels={{ reason: '采购用途', amount: '金额', items: '物料', key: '偏好名称', value: '偏好内容', comment: '审批意见', outcome: '审批结果' }}
    commandLabels={{ 'PurchaseOrder.submit': '提交采购审批', 'PurchaseOrder.explainPurpose': '保存采购用途', 'PurchaseOrder.cancel': '取消采购单', 'PurchaseOrder.create': '新建采购单' }} />;
}
