import type { CommonError } from '@app/contracts';

// 通用错误提示不依赖具体业务，登录页和应用壳复用它。
export const errorMessages: Record<CommonError, string> = {
  UNAUTHENTICATED: '账号或密码不正确，请重新输入。',
  FORBIDDEN: '当前账号无法执行此操作，请联系管理员。',
  INVALID_INPUT: '请检查输入的账号和密码。',
  RATE_LIMITED: '操作过于频繁，请稍后重试。',
  INTERNAL: '服务暂时无法处理请求，请稍后重试。',
  NETWORK: '无法连接服务，请检查网络和 API 是否已启动。',
};
