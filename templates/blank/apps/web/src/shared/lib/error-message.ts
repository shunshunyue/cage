/**
 * 空白应用通用错误码的中文展示表，由登录页和公共外壳共享。
 * 保持与 CommonError 类型覆盖一致；错误文案只供提示，控制流应仍判断客户端 ok/code。
 * 取消和超时由客户端请求生命周期产生，不代表服务端一定没有完成操作，提示用户先确认当前状态。
 */
import type { CommonError } from '@app/contracts';

// 通用错误提示不依赖具体业务，登录页和应用壳复用它。
/**
 * 完整映射认证、授权、输入、限流、服务异常、网络、取消和超时错误；新增业务领域错误由其模块单独说明。
 * Record 保留穷尽检查，SDK 增加通用错误码时必须补充文案，不能用空提示或静默默认值掩盖缺项。
 */
export const errorMessages: Record<CommonError, string> = {
  UNAUTHENTICATED: '账号或密码不正确，请重新输入。',
  FORBIDDEN: '当前账号无法执行此操作，请联系管理员。',
  INVALID_INPUT: '请检查输入的账号和密码。',
  RATE_LIMITED: '操作过于频繁，请稍后重试。',
  INTERNAL: '服务暂时无法处理请求，请稍后重试。',
  NETWORK: '无法连接服务，请检查网络和 API 是否已启动。',
  CANCELLED: '请求已取消，请确认当前页面状态后重试。',
  TIMEOUT: '请求超时，请检查网络并确认操作结果后重试。',
};
