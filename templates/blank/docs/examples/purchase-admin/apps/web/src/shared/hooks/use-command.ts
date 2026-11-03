import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CageResult } from '@app/contracts';
import { errorMessage } from '../lib/error-message';

export type RunCommand = (
  action: () => Promise<CageResult<unknown, string>>,
  success: string,
) => Promise<boolean>;

/**
 * 页面间复用提交状态和结果提示，不包含采购或库存的业务判断。
 * 成功后使查询缓存失效，让列表从服务端重新读取版本和状态；写入仍由生成 SDK 完成。
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
