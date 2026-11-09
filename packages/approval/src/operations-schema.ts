/**
 * 通用审批运营 HTTP 的封闭输入协议，供路由校验与 OpenAPI 共用。
 * 这里只做格式约束；本人身份、实例版本、节点状态和冷却在 operations 服务的事务内复核。
 */
import { z } from 'zod';

/** 已读取实例当前节点与共享催办说明；不允许客户端指定收件人、申请人或冷却时间。 */
export const approvalUrgeSchema = z.strictObject({
  expectedStep: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** 并行实例必填，按升序携带读取到的完整活跃节点集合；顺序旧客户端可省略。 */
  expectedSteps: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).min(1).max(128)
    .refine(items => items.every((item, index) => index === 0 || items[index - 1] < item)).optional(),
  reason: z.string().trim().min(1).max(1000),
});

/** 提醒游标按 bigint 字符串传输；HTTP 查询布尔值显式解析，避免把字符串 false 转成 true。 */
export const approvalNoticeQuerySchema = z.strictObject({
  after: z.string().regex(/^(0|[1-9]\d{0,18})$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  unreadOnly: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
});
