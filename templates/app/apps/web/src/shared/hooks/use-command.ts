/**
 * 页面命令调用的轻量状态封装，统一提交中状态、成功反馈和领域错误文案。
 * 消费契约客户端返回的 CageResult；不会自行写数据库或将前端显示状态当作授权。
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CageResult } from '@app/contracts';
import { errorMessage } from '../lib/error-message';

/**
 * 页面传入 action 执行一次命令，success 为业务成功提示。
 * Promise<boolean> 只表示本次结果是否 ok，供表单决定关闭或保留草稿；调用者仍需提供目标和版本。
 */
export type RunCommand = (
  action: () => Promise<CageResult<unknown, string>>,
  success: string,
) => Promise<boolean>;

/**
 * 页面间复用提交状态和结果提示，不包含采购或库存的业务判断。
 * 成功后使查询缓存失效，让列表从服务端重新读取版本和状态；写入仍由生成 SDK 完成。
 */
/**
 * 返回 run、busy、message 和 clearMessage，供按钮禁用与结果提示复用。
 * run 等待 action 返回 CageResult 后解除 busy，成功时请求刷新查询缓存，失败时保留错误文案。
 * 本封装没有捕获 action 抛出的异常；action 应遵守客户端的结果协议，不能把它当作任意异步任务的异常屏障。
 */
export function useCommand() {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run: RunCommand = async (action, success) => {
    setBusy(true);
    setMessage('');
    const result = await action();
    setBusy(false);
    setMessage(result.ok ? success : errorMessage(result));
    if (result.ok) await cache.invalidateQueries();
    return result.ok;
  };
  return { run, busy, message, clearMessage: () => setMessage('') };
}
