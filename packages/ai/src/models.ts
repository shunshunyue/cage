import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { cageError, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { secrets, ConnectorError } from '@yss123/cage-connectors';
import { modelKeySchema, modelConfigSchema, type AiModelConfig, type AiModelProbe } from '@yss123/cage-ai-protocol';
import { sql } from 'kysely';
import { digest, parse } from './security.js';
import { chatModel } from './model.js';
import { responsesModel } from './responses.js';
import type { ModelProvider, ModelRequest, ModelResult } from './types.js';

export const MODEL_CAPABILITY = 'Sys.ai.models.manage';
export const MODEL_MIGRATION = { name: 'cage:ai_models_001', sql: `
CREATE TABLE sys.ai_model (
 tenant_id uuid NOT NULL, key text NOT NULL, version integer NOT NULL,
 label text NOT NULL, base_url text NOT NULL, model text NOT NULL, enabled boolean NOT NULL,
 timeout_ms integer NOT NULL, encrypted_key text NOT NULL, updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key)
);
GRANT SELECT, INSERT, UPDATE ON sys.ai_model TO cage_app;
` };

async function encryptionKey(): Promise<Buffer> {
  let value: string;
  try { value = await secrets.get('CAGE_AI_ENCRYPTION_KEY'); }
  catch { throw cageError('DOMAIN_ERROR', { message: '部署尚未配置 CAGE_AI_ENCRYPTION_KEY，请配置后再保存模型' }); }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw cageError('DOMAIN_ERROR', { message: 'CAGE_AI_ENCRYPTION_KEY 必须是 32 字节随机密钥的标准 Base64 编码' });
  return key;
}
const aad = (tenantId: string, key: string, baseUrl: string) => Buffer.from(JSON.stringify([tenantId, key, baseUrl]));
async function encrypt(value: string, associated: Buffer): Promise<string> {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}
async function decrypt(value: string, associated: Buffer): Promise<string> {
  const key = await encryptionKey();
  try {
    const [version, iv, tag, ciphertext] = value.split(':');
    if (version !== 'v1') throw new Error('unsupported');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    cipher.setAAD(associated); cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64')), cipher.final()]).toString('utf8');
  } catch { throw cageError('DOMAIN_ERROR', { message: '模型密钥无法解密，请检查部署加密密钥或重新保存 API Key' }); }
}
function dto(key: string, row?: any): AiModelConfig {
  return { key, version: row?.version ?? 0, label: row?.label ?? key, baseUrl: row?.base_url ?? '', model: row?.model ?? '',
    enabled: row?.enabled ?? false, timeoutMs: row?.timeout_ms ?? 90_000, hasApiKey: Boolean(row?.encrypted_key),
    apiFormat: row?.api_format ?? 'chat-completions', contextWindowTokens: row?.context_window_tokens ?? 32768, responsesCompaction: row?.responses_compaction ?? false,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null };
}

/** 系统配置服务：按租户读取，写入与脱敏审计同事务；不进入业务本体和助理工具。 */
export class ModelManager {
  constructor(readonly kernel: Kernel, readonly keys: readonly string[]) {}
  private need(ctx: Ctx, key?: string): void {
    if (ctx.actor?.kind !== 'user' || !ctx.userId) throw cageError('UNAUTHENTICATED');
    if (!ctx.capabilities.has(MODEL_CAPABILITY)) throw cageError('FORBIDDEN', { capability: MODEL_CAPABILITY });
    if (key !== undefined) this.known(key);
  }
  private known(key: string): void { parse(modelKeySchema, key); if (!this.keys.includes(key)) throw cageError('NOT_FOUND'); }
  async list(ctx: Ctx): Promise<AiModelConfig[]> {
    this.need(ctx);
    const rows = await this.kernel.app.selectFrom('sys.ai_model').selectAll().where('tenant_id', '=', ctx.tenantId).execute();
    return this.keys.map(key => dto(key, rows.find(r => r.key === key)));
  }
  async save(ctx: Ctx, key: string, raw: unknown): Promise<AiModelConfig> {
    this.need(ctx, key);
    const input = parse(modelConfigSchema, raw), baseUrl = new URL(input.baseUrl).toString().replace(/\/$/, '');
    return this.kernel.app.transaction().execute(async tx => {
      // 同一别名首次创建也需串行，不能只锁尚不存在的行。
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:ai-model:${key}`}, 0))`.execute(tx);
      const previous = await tx.selectFrom('sys.ai_model').selectAll().where('tenant_id', '=', ctx.tenantId).where('key', '=', key).forUpdate().executeTakeFirst();
      if ((previous?.version ?? 0) !== input.version) throw cageError('CONFLICT');
      const apiFormat = input.apiFormat ?? previous?.api_format ?? 'chat-completions';
      if (input.responsesCompaction && apiFormat !== 'responses') throw cageError('INVALID_INPUT', '服务端自动压缩仅适用于 Responses');
      if (!input.apiKey && (!previous || previous.base_url !== baseUrl)) throw cageError('INVALID_INPUT', { message: '首次配置或更换服务地址时，请同时填写新的 API Key' });
      const encrypted = input.apiKey ? await encrypt(input.apiKey, aad(ctx.tenantId, key, baseUrl)) : previous!.encrypted_key;
      const values = { version: input.version + 1, label: input.label, base_url: baseUrl, model: input.model, enabled: input.enabled,
        api_format: apiFormat, context_window_tokens: input.contextWindowTokens ?? previous?.context_window_tokens ?? 32768,
        responses_compaction: apiFormat === 'responses' && (input.responsesCompaction ?? previous?.responses_compaction ?? false),
        timeout_ms: input.timeoutMs, encrypted_key: encrypted, updated_by: ctx.userId!, updated_at: new Date() };
      await tx.insertInto('sys.ai_model').values({ tenant_id: ctx.tenantId, key, ...values })
        .onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet(values)).execute();
      const saved = dto(key, values);
      await this.kernel.writeAudit(tx, { tenantId: ctx.tenantId, actor: ctx.actor!.id, actorKind: 'user', source: 'api', kind: 'ops',
        capability: MODEL_CAPABILITY, command: 'Sys.ai.models.save', result: 'ok', requestId: ctx.requestId ?? null,
        diff: { before: previous ? dto(key, previous) : null, after: saved, keyChanged: Boolean(input.apiKey) } });
      return saved;
    });
  }
  private async configured(tenantId: string, key: string): Promise<any> {
    this.known(key);
    const row = await this.kernel.app.selectFrom('sys.ai_model').selectAll().where('tenant_id', '=', tenantId).where('key', '=', key).executeTakeFirst();
    if (!row?.enabled) throw cageError('DOMAIN_ERROR', { message: '模型尚未配置或已停用，请在系统管理中启用' });
    return row;
  }
  private provider(tenantId: string, key: string, row: any): ModelProvider {
    const base = new URL(row.base_url), path = base.pathname.replace(/\/$/, '').replace(/\/(chat\/completions|responses)$/, '');
    const responses = row.api_format === 'responses';
    const provider = (responses ? responsesModel : chatModel)(`managed-${tenantId}-${key}`, { model: row.model, hosts: { prod: base.host }, environment: 'prod',
      protocol: base.protocol as 'http:' | 'https:',
      path: `${path}/${responses ? 'responses' : 'chat/completions'}`, timeoutMs: row.timeout_ms, rateLimit: { perSecond: 2 },
      contextWindowTokens: row.context_window_tokens, ...{ compaction: row.responses_compaction },
      credential: () => decrypt(row.encrypted_key, aad(tenantId, key, row.base_url)) });
    if (provider.continuation) provider.continuation = { ...provider.continuation, key: digest({ tenantId, key, version: row.version }) };
    return provider;
  }
  async resolve(tenantId: string, key: string): Promise<ModelProvider> {
    return this.provider(tenantId, key, await this.configured(tenantId, key));
  }
  async generate(tenantId: string, key: string, request: ModelRequest): Promise<ModelResult> {
    // 每个模型步进读取最新配置；已发出的请求保持原配置快照，避免跨地址串用凭据。
    return (await this.resolve(tenantId, key)).generate(request);
  }
  async test(ctx: Ctx, key: string): Promise<AiModelProbe> {
    this.need(ctx, key);
    const row = await this.configured(ctx.tenantId, key), started = Date.now();
    let code = 'CONNECTED';
    try {
      await this.provider(ctx.tenantId, key, row).generate({ messages: [{ role: 'user', content: 'Reply OK.' }], tools: [], maxOutputTokens: 64, signal: AbortSignal.timeout(20_000) });
    } catch (error) { code = error instanceof ConnectorError && error.status ? `HTTP_${error.status}` : 'MODEL_CONNECTION_FAILED'; }
    const result = { ok: code === 'CONNECTED', code, version: row.version, latencyMs: Date.now() - started };
    await this.kernel.writeAudit(this.kernel.app, { tenantId: ctx.tenantId, actor: ctx.actor!.id, actorKind: 'user', source: 'api', kind: 'ops',
      capability: MODEL_CAPABILITY, command: 'Sys.ai.models.test', result: result.ok ? 'ok' : 'failed', requestId: ctx.requestId ?? null, diff: { key, ...result } });
    return result;
  }
}

/** 应用仅声明稳定的模型别名；API、worker 共用数据库中的租户配置。声明时不读取密钥或外呼。 */
export function managedModel(key: string): ModelProvider {
  parse(modelKeySchema, key);
  const spec = { kind: 'managed-model', key };
  return { spec, async generate() { throw new Error('managedModel 必须由 Cage 运行时绑定'); },
    bind(kernel) { const manager = new ModelManager(kernel, [key]); return { spec, resolve: context => manager.resolve(context.tenantId, key), generate(request) {
      if (!request.context) throw new Error('模型调用缺少可信运行上下文');
      return manager.generate(request.context.tenantId, key, request);
    } }; },
  };
}
