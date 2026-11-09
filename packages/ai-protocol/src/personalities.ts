/**
 * 助理性格管理、会话选择和试聊的共享协议。性格只影响表达，不授予工具权限或改变审批规则。
 * 持久编辑使用版本冲突检测；普通用户目录只暴露摘要，完整描述供管理和后端提示装配使用。
 */
import { z } from 'zod';

/**
 * 性格稳定 key，小写字母开头，最多 64 字符，可含数字、下划线和连字符。
 */
export const personalityKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
/** 表达偏好是有界数据，不接受权限、工具或审核策略配置。 */
/**
 * 性格内容：label/ avatar 为显示信息，description 为表达风格，verbosity/emoji 为偏好档位，address 为称呼。
 * examples 最多三段示例；enabled 控制可选择性。全部为有界数据，不能配置权限或审核策略。
 */
export const personalityFieldsSchema = z.object({
  label: z.string().trim().min(1).max(40), avatar: z.string().trim().min(1).max(16),
  description: z.string().trim().min(1).max(3000),
  verbosity: z.enum(['concise', 'balanced', 'detailed']), address: z.string().trim().max(40),
  emoji: z.enum(['none', 'light', 'expressive']), examples: z.array(z.string().trim().min(1).max(400)).max(3), enabled: z.boolean(),
}).strict();
/**
 * 保存性格时在内容外增加非负 version，首次创建使用零，冲突由服务拒绝。
 */
export const personalityInputSchema = personalityFieldsSchema.extend({ version: z.number().int().nonnegative() });
/**
 * 租户默认性格及设置版本，默认 key 必须在服务端解析到已启用项。
 */
export const personalitySettingsSchema = z.object({ version: z.number().int().nonnegative(), defaultKey: personalityKeySchema }).strict();
/**
 * 会话选择输入：key=null 跟随默认，version 是会话选择版本而非性格内容版本。
 */
export const personalitySelectionSchema = z.object({ key: personalityKeySchema.nullable(), version: z.number().int().nonnegative() }).strict();
/**
 * 未保存风格的试聊输入；profile 为草稿，message 为有界测试文字，不携带业务会话。
 */
export const personalityPreviewSchema = z.object({ profile: personalityFieldsSchema, message: z.string().trim().min(1).max(2000) }).strict();
/**
 * 通过性格字段 schema 派生的完整内容类型。
 */
export type AiPersonalityFields = z.infer<typeof personalityFieldsSchema>;
/**
 * 包含乐观版本的性格保存输入。
 */
export type AiPersonalityInput = z.infer<typeof personalityInputSchema>;
/**
 * 管理端完整性格内容及来源元数据，普通用户只获取摘要。
 */
export interface AiPersonality extends AiPersonalityInput { /** 稳定性格 key。 */ key: string; /** 是否覆盖或继承框架预设。 */ builtin: boolean; /** 租户保存时间 ISO 字符串，纯预设为 null。 */ updatedAt: string | null }
/**
 * 选择器可见摘要，不暴露内部提示或示例。
 */
export interface AiPersonalitySummary { /** 选择时提交的 key。 */ key: string; /** 性格内容版本，区别于会话选择版本。 */ version: number; /** 选择器显示名。 */ label: string; /** 短头像符号或文字。 */ avatar: string }
/**
 * 当前用户可选目录和租户默认 key，仅包含启用项。
 */
export interface AiPersonalityCatalog { /** 跟随默认时使用的性格 key。 */ defaultKey: string; /** 已启用性格的摘要。 */ items: AiPersonalitySummary[] }
/**
 * 租户默认项的乐观版本快照。
 */
export interface AiPersonalitySettings { /** 设置乐观版本。 */ version: number; /** 租户默认性格 key。 */ defaultKey: string }
/**
 * 管理员读取的完整设置与性格列表。
 */
export interface AiPersonalityAdmin { /** 默认项配置。 */ settings: AiPersonalitySettings; /** 包含停用项的完整管理列表。 */ items: AiPersonality[] }
/**
 * 试聊草稿输入，不代表已保存配置。
 */
export type AiPersonalityPreviewInput = z.infer<typeof personalityPreviewSchema>;
/**
 * 一次试聊最终文字及耗时，不保存成正常会话。
 */
export interface AiPersonalityPreview { /** 最终试聊文字。 */ text: string; /** 试聊端到端耗时毫秒数。 */ latencyMs: number }
/**
 * 试聊 SSE：delta 是增量文字，done 携带最终校准结果，error 仅携带稳定错误码。
 */
export type AiPersonalityPreviewEvent = { type: 'delta'; text: string } | { type: 'done'; result: AiPersonalityPreview } | { type: 'error'; code: string };
/**
 * 创建会话的可选标题与性格；personalityKey 省略或 null 使用租户默认项。
 */
export const sessionInputSchema = z.object({ title: z.string().trim().min(1).max(160).optional(), personalityKey: personalityKeySchema.nullable().optional() }).strict();
/**
 * 创建会话输入，不接收用户 ID 或授权信息。
 */
export type AiSessionInput = z.infer<typeof sessionInputSchema>;
