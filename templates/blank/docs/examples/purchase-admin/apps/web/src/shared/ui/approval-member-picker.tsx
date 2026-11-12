/**
 * 采购参与者共用的审批协作名录选择器，由采购表单和审批管理弹窗消费。
 * 仅通过生成契约读取 ApprovalMember 安全视图，不读取完整 User 或凭账号名猜测权限。
 * 目录是公开协作身份，不保证被选者对当前单据有审批权限；实际提交由服务端复核，空/失败不能伪装成可选名单。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { approvalMember } from '@app/contracts';
import { errorMessage } from '../lib/error-message';
import './approval-member-picker.css';

/**
 * 在有名录读取权限的界面加载当前页，可按显示名/职责就地筛选；最多读取 200 项，不声称返回完整组织。
 * page 进入查询缓存键，退出账号时由应用会话层清理；retired 默认不用于选人。
 */
export function useApprovalMembers(page = 1, includeRetired = false) {
  return useQuery({ queryKey: ['approval-members', page, includeRetired], queryFn: async () => {
    const result = await approvalMember.list({ page, pageSize: 200, ...(includeRetired ? {} : { status: 'active' }) });
    if (!result.ok) throw new Error(errorMessage(result));
    return result.data;
  } });
}

/**
 * 单选/多选均输出真实 userId，value 与 onChange 由父表单持有，exclude 只改善体验，不替代服务端重复票检查。
 * max 限制本次选择数量，已选项始终可取消；翻页保留已选 ID，页面展示本次已选数量。
 * disabled 用于在父级提交时冻结编辑；刷新与失败保留用户选择，不自动选择或发起写操作。
 */
export function ApprovalMemberPicker({ value, onChange, max = 5, exclude = [], disabled = false }: {
  value: string[]; onChange: (ids: string[]) => void; max?: number; exclude?: string[]; disabled?: boolean;
}) {
  const [search, setSearch] = useState(''), [page, setPage] = useState(1);
  const query = useApprovalMembers(page);
  const entries = query.data?.items.filter(member => !exclude.includes(member.userId) &&
    `${member.displayName} ${member.specialty}`.includes(search.trim())) ?? [];
  return <fieldset className="approval-member-picker" disabled={disabled}>
    <legend>选择协作人员 · 已选 {value.length}/{max}</legend>
    <input aria-label="筛选协作人员" placeholder="按姓名或职责筛选当前页" value={search} onChange={event => setSearch(event.target.value)} />
    {query.isPending && <p role="status">正在读取协作名录…</p>}
    {query.isError && <p role="alert">{query.error.message} <button type="button" onClick={() => void query.refetch()}>重试</button></p>}
    <div className="approval-member-options">{entries.map(member => <label key={member.id}>
      <input type="checkbox" checked={value.includes(member.userId)} disabled={disabled || (!value.includes(member.userId) && value.length >= max && max !== 1)}
        onChange={event => onChange(event.target.checked ? max === 1 ? [member.userId] : [...value, member.userId] : value.filter(id => id !== member.userId))} />
      <span><strong>{member.displayName}</strong><small>{member.specialty}</small></span>
    </label>)}</div>
    {query.data && entries.length === 0 && <p className="muted">当前页没有匹配人员，请调整筛选或联系名录维护人。</p>}
    {(query.data?.total ?? 0) > 200 && <div className="actions"><button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span>第 {page} 页</span><button type="button" disabled={page * 200 >= query.data!.total} onClick={() => setPage(page + 1)}>下一页</button></div>}
    <small className="muted">名录只提供选人信息，处理权限和数据范围仍以服务端校验为准。</small>
  </fieldset>;
}
