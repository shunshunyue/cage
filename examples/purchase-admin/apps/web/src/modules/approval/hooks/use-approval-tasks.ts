/**
 * 当前账号本人、候选或等待加签任务的共享查询入口，默认待办供 app 数量组合复用。
 * 任务分配与实际决策授权均来自服务端，不从角色名称在前端自行推导。
 */
import { useQuery } from '@tanstack/react-query';
import { client } from '@app/contracts';
import { errorMessage } from '../../../shared/lib/error-message';

/**
 * 审批是框架通用接口，不属于某个聚合的生成方法，因此请求封装在审批模块内。
 * 待办页面和导航角标复用同一缓存键，调用方不需要了解接口地址或响应形状。
 */
/**
 * 在 React Query 中读取审批待办，非 ok 结果转为查询错误。
 * view 默认 pending，与导航角标共享；candidates/waiting 使用独立缓存，不混入可决定的任务数量。
 * 返回查询状态及 refetch；空数组表示当前结果没有待办，未加载或失败不等同于零条。
 */
export function useApprovalTasks(view: 'pending' | 'candidates' | 'waiting' = 'pending') {
  return useQuery({
    queryKey: ['tasks', view],
    queryFn: async () => {
      // 使用框架任务协议保留 revision，避免页面决定丢失任务流转后的并发校验。
      const result = await (view === 'candidates' ? client.approvalCandidateTasks() : client.approvalTasks(view));
      if (!result.ok) throw new Error(errorMessage(result));
      return result.data;
    },
  });
}
