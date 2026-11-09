/**
 * Admin 模型配置的共享输入与公开 DTO。后端 ModelManager 验证版本、权限和加密，前端仅消费无密钥视图。
 * 地址校验拒绝账号、查询参数及片段；启用协议或压缩配置并不证明外部网关实际兼容。
 */
import { z } from 'zod';

/**
 * 模型稳定别名格式：字母开头，最多 64 字符；仅使用字母、数字、下划线和连字符。
 */
export const modelKeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
/**
 * 模型保存输入：version 为读到的配置版本，label 为显示名，baseUrl 为无凭据 HTTP(S) 地址，model 为服务模型名。
 * apiKey 留空/省略由服务按旧配置保留，换地址时服务要求新密钥；timeoutMs 单位毫秒。apiFormat、contextWindowTokens、responsesCompaction 可省略以沿用服务兼容默认值。
 */
export const modelConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  label: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().max(1000).url().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, '使用不含账号、查询参数和片段的 HTTP 或 HTTPS API 地址'),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().max(4096).refine(value => !/[\r\n]/.test(value)).optional(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(180_000).default(90_000),
  apiFormat: z.enum(['chat-completions', 'responses']).optional(),
  contextWindowTokens: z.number().int().min(8192).max(2_000_000).optional(),
  responsesCompaction: z.boolean().optional(),
}).strict();
/**
 * 保存时的原始输入类型，保留 schema 默认值处理前的可选字段。
 */
export type AiModelConfigInput = z.input<typeof modelConfigSchema>;
/** 密钥永远不回传；未配置的声明也会出现在列表中。 */
/**
 * 模型公开配置，version=0 表示声明尚未保存；只提供 hasApiKey，不回传加密值或明文。
 */
export interface AiModelConfig {
  /**
   * 声明中的模型别名。
   */
  key: string; /** 配置乐观版本，保存时原样提交。 */ version: number; /** 管理界面的显示名。 */ label: string; /** 已规范化的服务地址，不含凭据。 */ baseUrl: string; /** 外部服务模型名称。 */ model: string;
  /**
   * 是否允许运行使用。
   */
  enabled: boolean; /** 单次网络调用超时毫秒数。 */ timeoutMs: number; /** 是否已有密钥，仅为布尔值。 */ hasApiKey: boolean; /** 更新时间，未配置为 null。 */ updatedAt: string | null;
  /**
   * 实际选择的 Chat Completions 或 Responses 协议。
   */
  apiFormat: 'chat-completions' | 'responses'; /** 配置的真实窗口 Token 数，用于有界请求。 */ contextWindowTokens: number; /** 是否请求 Responses 服务端压缩，只有该协议有效。 */ responsesCompaction: boolean;
}
/**
 * 一次固定诊断请求的结果，不证明函数工具、接续或业务审批质量已通过。
 */
export interface AiModelProbe { /** 固定请求是否完成。 */ ok: boolean; /** 稳定成功/错误分类，不包含上游正文。 */ code: string; /** 被测试配置的版本。 */ version: number; /** 端到端探测耗时，单位毫秒。 */ latencyMs: number }
