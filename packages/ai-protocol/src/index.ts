// 协议独立于数据库、React 和模型实现，同一 schema 同时约束 HTTP、SDK 与工具交互。
import { z } from 'zod';
export { modelKeySchema, modelConfigSchema, type AiModelConfig, type AiModelConfigInput, type AiModelProbe } from './models.js';
export * from './personalities.js';
import type { AiPersonalitySummary } from './personalities.js';

const name = z.string().min(1).max(160);
const objectRef = z.object({ aggregate: name, id: z.uuid(), observedVersion: z.number().int().positive().optional() }).strict();
export const pageContextSchema = z.object({
  pageInstanceId: z.string().min(1).max(160), revision: z.number().int().nonnegative(), capturedAt: z.iso.datetime({ offset: true }),
  page: z.object({ id: name, title: z.string().max(200), kind: z.enum(['list', 'detail', 'form', 'dashboard', 'custom']), route: z.string().max(1000) }).strict(),
  subject: objectRef.optional(),
  selection: z.object({ aggregate: name, ids: z.array(z.uuid()).max(100) }).strict().optional(),
  view: z.object({ aggregate: name.optional(), query: name.optional(), input: z.record(z.string(), z.unknown()).optional(),
    visibleIds: z.array(z.uuid()).max(100).optional(), visibleFields: z.array(name).max(80).optional() }).strict().optional(),
  draft: z.object({ command: name, values: z.record(z.string(), z.unknown()), baseVersion: z.number().int().positive().optional() }).strict().optional(),
  visibleContent: z.array(z.object({ id: name, text: z.string().max(4000) }).strict()).max(10).optional(),
}).strict();
export type PageContext = z.infer<typeof pageContextSchema>;

export const messageInputSchema = z.object({ message: z.string().trim().min(1).max(16_000), pageContext: pageContextSchema.optional() }).strict();
export type AiMessageInput = z.infer<typeof messageInputSchema>;
export const aiDecisionSchema = z.object({
  decision: z.enum(['pass', 'return', 'manual']), reason: z.string().min(1).max(2000),
  suggestions: z.array(z.string().max(1000)).max(20).default([]),
  evidence: z.array(z.object({ source: name, detail: z.string().max(1000) }).strict()).max(30).default([]),
}).strict();
export const runStatusSchema = z.enum(['queued', 'running', 'waiting_input', 'waiting_confirmation', 'succeeded', 'failed', 'cancelled', 'expired']);
export type AiRunStatus = z.infer<typeof runStatusSchema>;
export interface AiSession { id: string; title: string; createdAt: string; updatedAt: string; personalityKey: string | null; personalityVersion: number }
export interface AiInteraction { id: string; kind: 'input' | 'confirmation' | 'page_context'; prompt: string; data: unknown; expiresAt: string }
export interface AiRun {
  id: string; sessionId: string | null; status: AiRunStatus; phase: string; answer: string | null; error: string | null;
  steps: number; toolCalls: number; tokens: number; createdAt: string; updatedAt: string; interactions: AiInteraction[];
  personality?: AiPersonalitySummary;
}
export type AiEventType = 'run.status' | 'model.started' | 'model.completed' | 'model.failed' | 'message.delta' | 'message.completed' | 'tool.started' | 'tool.completed' | 'interaction.required' | 'context.updated';
export interface AiEvent { runId: string; sequence: number; type: AiEventType; data: unknown; createdAt: string }
export const interactionResponseSchema = z.object({
  approved: z.boolean().optional(), answer: z.string().max(16000).optional(), pageContext: pageContextSchema.optional(),
}).strict().refine(value => [value.approved, value.answer, value.pageContext].filter(v => v !== undefined).length === 1, '只能提供一种交互答复');
export type AiInteractionResponse = z.infer<typeof interactionResponseSchema>;
export interface AiMemory { id: string; key: string; value: string; updatedAt: string }

export const queryPlanSchema = z.object({
  aggregate: name,
  select: z.array(name).max(40).optional(),
  where: z.array(z.object({ field: name, op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']), value: z.unknown() }).strict()).max(20).default([]),
  groupBy: z.array(name).max(4).default([]),
  metrics: z.array(z.object({ op: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: name.optional(), as: z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/) }).strict()).max(8).default([]),
  orderBy: z.object({ field: name, direction: z.enum(['asc', 'desc']) }).strict().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type QueryPlan = z.infer<typeof queryPlanSchema>;
