import { z } from 'zod';

export const personalityKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
/** 表达偏好是有界数据，不接受权限、工具或审核策略配置。 */
export const personalityFieldsSchema = z.object({
  label: z.string().trim().min(1).max(40), avatar: z.string().trim().min(1).max(16),
  description: z.string().trim().min(1).max(3000),
  verbosity: z.enum(['concise', 'balanced', 'detailed']), address: z.string().trim().max(40),
  emoji: z.enum(['none', 'light', 'expressive']), examples: z.array(z.string().trim().min(1).max(400)).max(3), enabled: z.boolean(),
}).strict();
export const personalityInputSchema = personalityFieldsSchema.extend({ version: z.number().int().nonnegative() });
export const personalitySettingsSchema = z.object({ version: z.number().int().nonnegative(), defaultKey: personalityKeySchema }).strict();
export const personalitySelectionSchema = z.object({ key: personalityKeySchema.nullable(), version: z.number().int().nonnegative() }).strict();
export const personalityPreviewSchema = z.object({ profile: personalityFieldsSchema, message: z.string().trim().min(1).max(2000) }).strict();
export type AiPersonalityFields = z.infer<typeof personalityFieldsSchema>;
export type AiPersonalityInput = z.infer<typeof personalityInputSchema>;
export interface AiPersonality extends AiPersonalityInput { key: string; builtin: boolean; updatedAt: string | null }
export interface AiPersonalitySummary { key: string; version: number; label: string; avatar: string }
export interface AiPersonalityCatalog { defaultKey: string; items: AiPersonalitySummary[] }
export interface AiPersonalitySettings { version: number; defaultKey: string }
export interface AiPersonalityAdmin { settings: AiPersonalitySettings; items: AiPersonality[] }
export type AiPersonalityPreviewInput = z.infer<typeof personalityPreviewSchema>;
export interface AiPersonalityPreview { text: string; latencyMs: number }
export type AiPersonalityPreviewEvent = { type: 'delta'; text: string } | { type: 'done'; result: AiPersonalityPreview } | { type: 'error'; code: string };
export const sessionInputSchema = z.object({ title: z.string().trim().min(1).max(160).optional(), personalityKey: personalityKeySchema.nullable().optional() }).strict();
export type AiSessionInput = z.infer<typeof sessionInputSchema>;
