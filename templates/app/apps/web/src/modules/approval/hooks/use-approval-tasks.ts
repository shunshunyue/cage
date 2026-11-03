import { useQuery } from '@tanstack/react-query';
import { client } from '@app/contracts';
import { errorMessage } from '../../../shared/lib/error-message';

type Task = { id: string; businessKey: string; title: string; createdAt: string };

/**
 * 审批是框架通用接口，不属于某个聚合的生成方法，因此请求封装在审批模块内。
 * 待办页面和导航角标复用同一缓存键，调用方不需要了解接口地址或响应形状。
 */
export function useApprovalTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => {
      const result = await client.get<Task[]>('/api/approval/tasks');
      if (!result.ok) throw new Error(errorMessage(result));
      return result.data;
    },
  });
}
