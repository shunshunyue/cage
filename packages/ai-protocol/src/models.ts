import { z } from 'zod';

export const modelKeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
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
export type AiModelConfigInput = z.input<typeof modelConfigSchema>;
/** 密钥永远不回传；未配置的声明也会出现在列表中。 */
export interface AiModelConfig {
  key: string; version: number; label: string; baseUrl: string; model: string;
  enabled: boolean; timeoutMs: number; hasApiKey: boolean; updatedAt: string | null;
  apiFormat: 'chat-completions' | 'responses'; contextWindowTokens: number; responsesCompaction: boolean;
}
export interface AiModelProbe { ok: boolean; code: string; version: number; latencyMs: number }
