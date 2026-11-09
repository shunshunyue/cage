/**
 * 管理租户的动态模型配置、加密凭据和连接探测，并绑定 managedModel 声明。
 * Admin 通过独立管理能力修改配置，API/worker 每个模型步进读取一致快照；密钥只在服务端加解密，不进入 DTO、业务本体、助理工具或审计正文。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { cageError, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { secrets, ConnectorError } from '@yss123/cage-connectors';
import { modelKeySchema, modelConfigSchema, type AiModelConfig, type AiModelProbe } from '@yss123/cage-ai-protocol';
import { sql } from 'kysely';
import { digest, parse } from './security.js';
import { chatModel } from './model.js';
import { responsesModel } from './responses.js';
import type { ModelProvider, ModelRequest, ModelResult } from './types.js';

/**
 * 动态模型管理的独立系统能力；配置、列出及连接测试均要求用户持有此能力。
 */
export const MODEL_CAPABILITY = 'Sys.ai.models.manage';
/**
 * 动态模型配置最初版本的历史迁移；密文列不保存 API Key 明文。
 * 结构扩展由后续迁移承担，不修改已发布的名称或 SQL。
 */
export const MODEL_MIGRATION = { name: 'cage:ai_models_001', sql: `
CREATE TABLE sys.ai_model (
 tenant_id uuid NOT NULL, key text NOT NULL, version integer NOT NULL,
 label text NOT NULL, base_url text NOT NULL, model text NOT NULL, enabled boolean NOT NULL,
 timeout_ms integer NOT NULL, encrypted_key text NOT NULL, updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key)
);
GRANT SELECT, INSERT, UPDATE ON sys.ai_model TO cage_app;
` };

/**
 * 从部署 SecretProvider 读取 CAGE_AI_ENCRYPTION_KEY，要求标准 Base64 编码的 32 字节密钥。
 * 缺失或格式错误返回稳定部署提示，不输出密钥内容；每次加解密解析，未在此实现多版本密钥轮换。
 */
async function encryptionKey(): Promise<Buffer> {
  let value: string;
  try { value = await secrets.get('CAGE_AI_ENCRYPTION_KEY'); }
  catch { throw cageError('DOMAIN_ERROR', { message: '部署尚未配置 CAGE_AI_ENCRYPTION_KEY，请配置后再保存模型' }); }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw cageError('DOMAIN_ERROR', { message: 'CAGE_AI_ENCRYPTION_KEY 必须是 32 字节随机密钥的标准 Base64 编码' });
  return key;
}
/**
 * 把租户、模型别名和服务地址编码成 AES-GCM 附加认证数据，防止密文跨租户、别名或目标地址搬用。
 */
const aad = (tenantId: string, key: string, baseUrl: string) => Buffer.from(JSON.stringify([tenantId, key, baseUrl]));
/**
 * 以随机 12 字节 IV 和 AES-256-GCM 加密 API Key，返回含版本、IV、认证标签和密文的封装。
 * 附加认证数据由调用方绑定配置身份；只返回密文，不记录明文或部署密钥。
 */
async function encrypt(value: string, associated: Buffer): Promise<string> {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}
/**
 * 验证 v1 密文、认证标签和配置绑定信息后恢复请求所需的 API Key。
 * 格式、密钥或绑定不一致统一返回可操作的解密失败提示，避免底层错误暴露密文片段；明文只交给连接器凭据回调。
 */
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
/**
 * 把数据库模型记录映射为不含密钥的管理 DTO；未配置别名返回版本 0、停用和默认窗口/超时。
 * hasApiKey 仅表示存在密文，不能证明凭据当前可用。
 */
function dto(key: string, row?: any): AiModelConfig {
  return { key, version: row?.version ?? 0, label: row?.label ?? key, baseUrl: row?.base_url ?? '', model: row?.model ?? '',
    enabled: row?.enabled ?? false, timeoutMs: row?.timeout_ms ?? 90_000, hasApiKey: Boolean(row?.encrypted_key),
    apiFormat: row?.api_format ?? 'chat-completions', contextWindowTokens: row?.context_window_tokens ?? 32768, responsesCompaction: row?.responses_compaction ?? false,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null };
}

/** 系统配置服务：按租户读取，写入与脱敏审计同事务；不进入业务本体和助理工具。 */
/**
 * 动态模型配置服务，限定应用显式声明的别名和当前租户。
 * 保存通过 advisory lock 与乐观版本防止首次创建及并发覆盖，配置和脱敏审计同事务提交；生成请求使用配置快照，避免地址与密钥混用。
 */
export class ModelManager {
  /**
   * 绑定内核及应用允许管理的模型 key 列表；构造时不访问数据库或外部网关。
   */
  constructor(readonly kernel: Kernel, readonly keys: readonly string[]) {}
  /**
   * 要求真实登录用户和模型管理能力；指定 key 时进一步验证其格式与应用声明范围。
   */
  private need(ctx: Ctx, key?: string): void {
    if (ctx.actor?.kind !== 'user' || !ctx.userId) throw cageError('UNAUTHENTICATED');
    if (!ctx.capabilities.has(MODEL_CAPABILITY)) throw cageError('FORBIDDEN', { capability: MODEL_CAPABILITY });
    if (key !== undefined) this.known(key);
  }
  /**
   * 拒绝格式非法或应用未声明的模型别名，防止管理接口创建运行时不会使用的任意配置。
   */
  private known(key: string): void { parse(modelKeySchema, key); if (!this.keys.includes(key)) throw cageError('NOT_FOUND'); }
  /**
   * 读取当前租户配置，并按应用声明 key 返回完整列表；未配置项也以默认 DTO 展示，密文永不返回。
   */
  async list(ctx: Ctx): Promise<AiModelConfig[]> {
    this.need(ctx);
    const rows = await this.kernel.app.selectFrom('sys.ai_model').selectAll().where('tenant_id', '=', ctx.tenantId).execute();
    return this.keys.map(key => dto(key, rows.find(r => r.key === key)));
  }
  /**
   * 验证并规范化服务地址，在租户/别名事务锁下比较版本后保存配置。
   * 首次配置或更换地址必须提供新 API Key，因为密文与地址绑定；不更换凭据时沿用原密文。Responses 压缩只允许对应协议。
   * 版本递增、密文写入与 before/after 脱敏审计共同提交；旧版本返回 CONFLICT，不自动覆盖他人修改。
   */
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
  /**
   * 读取当前租户的已声明且已启用模型记录；缺失或停用给出管理配置提示，不静默回退其他网关。
   */
  private async configured(tenantId: string, key: string): Promise<any> {
    this.known(key);
    const row = await this.kernel.app.selectFrom('sys.ai_model').selectAll().where('tenant_id', '=', tenantId).where('key', '=', key).executeTakeFirst();
    if (!row?.enabled) throw cageError('DOMAIN_ERROR', { message: '模型尚未配置或已停用，请在系统管理中启用' });
    return row;
  }
  /**
   * 用单条配置快照创建协议 provider，并把密钥解密延迟到实际请求。
   * 托管模型固定使用 prod 环境及每秒 2 次限额，独立于 ERP 等连接器的 fake 阶段；路径兼容填入已有 Chat/Responses 端点。
   * Responses 接续键绑定租户、别名和配置版本，防止更改地址、模型或凭据后复用旧远端状态。
   */
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
  /**
   * 读取一次最新配置并返回固定快照 provider；运行时可用同一快照规划预算和执行请求。
   */
  async resolve(tenantId: string, key: string): Promise<ModelProvider> {
    return this.provider(tenantId, key, await this.configured(tenantId, key));
  }
  /**
   * 每个模型步进解析当前租户配置后执行 generate；已开始的请求继续使用其原快照，不中途切换凭据或地址。
   */
  async generate(tenantId: string, key: string, request: ModelRequest): Promise<ModelResult> {
    // 每个模型步进读取最新配置；已发出的请求保持原配置快照，避免跨地址串用凭据。
    return (await this.resolve(tenantId, key)).generate(request);
  }
  /**
   * 以固定 Reply OK 提示、无工具和最多 64 输出 Token 探测已保存配置，20 秒中止。
   * 只返回稳定结果、配置版本和延迟毫秒并记录审计；连通成功不证明业务质量、工具调用或完整 Responses 接续能力。
   */
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
/**
 * 声明一个稳定模型别名，构造阶段不读取密钥、不外呼。
 * 运行时 bind 后用可信 tenantId 解析租户配置；未绑定或缺少可信运行上下文直接失败，不能让模型请求任意指定其他租户。
 */
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
