/**
 * 提供命令 handler 之前执行的硬约束协议与职责分离、额度、二次认证组合子。
 * 流水线在读取当前对象后传入可信 ctx 和受限元数据，约束只判断是否允许继续；最终字段与不变量校验仍在 handler 后进行，约束通过不等于命令必然提交。
 */
// 硬约束组合子：在加载之后、handler 之前执行（第 6 关）。代码定边界，阈值可以来自授权数据。
import type { CapabilityParams, Ctx, MaybePromise } from '../types.js';

/** 预期拒绝用失败结果表达；内部故障可抛异常，不能被伪装成约束通过。 */
export type ConstraintResult = { /** 判别本条约束是否通过；false 分支必须提供拒绝说明，不代表底层异常已被吞掉。 */ ok: true } | { /** 判别本条约束是否通过；false 分支必须提供拒绝说明，不代表底层异常已被吞掉。 */ ok: false; /** 业务拒绝说明，可能进入诊断；不要拼入不应公开的敏感数据。 */ message: string };

/**
 * 构造明确的约束通过结果；仅表示当前规则通过，不授予能力或跳过后续规则。
 */
export const ok = (): ConstraintResult => ({ ok: true });
/**
 * 构造预期业务拒绝结果并保留说明，流水线据此抛约束失败、回滚命令。
 * 说明可能进入业务诊断，避免拼入密钥或无权公开的明文。
 */
export const violation = (message: string): ConstraintResult => ({ ok: false, message });

/**
 * 框架为当前约束提供的命令能力名、当前租户能力查询和范围读取工具。
 * 不暴露任意数据库写入；自定义约束应把所用业务字段记入 fields 以支持影响分析。
 */
export interface ConstraintMeta {
  /** 正在执行的命令的能力点，例如 PurchaseOrder.approve */
  capability: string;
  /** 取某人的能力（额度类约束用） */
  capabilitiesOf(userId: string): Promise<Map<string, CapabilityParams>>;
  /** 按当前主体的范围读取一条记录（框架内置约束用，例如防提权检查要看被分配的角色） */
  load(aggregate: string, id: string): Promise<Record<string, any> | null>;
  /** 能力目录 */
  catalog(): string[];
}

/**
 * 命令加载记录后、handler 前执行的守卫；current 是当前记录，input 尚未成为持久状态。
 * fields 为静态依赖证据，check 才是实际判断。约束通过不代表随后 handler 或不变量一定成功。
 */
export interface Constraint<_A = any> {
  /** 约束名，出现在本体图和报错里 */
  readonly name: string;
  /** 用到的字段，抽取器据此画 uses 边，影响分析能找到它 */
  readonly fields?: readonly string[];
  /**
   * 接收当前快照、可信身份、已解析输入和框架元数据，返回同步或异步 ConstraintResult。
   * 返回 ok:false 表示业务拒绝，抛异常表示依赖/实现故障；不得把失败吞成 ok，也不在检查中提交业务副作用。
   */
  readonly check: (current: any, ctx: Ctx, input: any, meta: ConstraintMeta) => MaybePromise<ConstraintResult>;
}

/** 职责分离：操作人（或系统身份代表的真人）不能是该字段记录的人，例如提单人不能审批 */
export const sod = {
  notSameAs(field: string): Constraint {
    return Object.freeze({
      name: `sod.notSameAs(${field})`,
      fields: [field],
      check: (cur: any, ctx: Ctx) => {
        const who = ctx.onBehalfOf ?? ctx.userId;
        if (!who) return violation('职责分离需要可核验的操作人身份');
        return who && cur[field] === who ? violation(`操作人不能是 ${field} 记录的人（职责分离）`) : ok();
      },
    });
  },
};

/** 额度：字段值不得超过操作人在该能力点上的 ceiling 参数；多角色取最大值 */
/**
 * 审批等系统身份优先读取 onBehalfOf 真人当前能力参数，避免流程本身的能力集合绕过额度。
 * 未配置参数即拒绝；金额字符串在此转成 Number 比较，业务仍需在字段/handler 中保证值合法。
 */
export function ceiling(field: string, param = 'ceiling'): Constraint {
  return Object.freeze({
    name: `ceiling(${field})`,
    fields: [field],
    check: async (cur: any, ctx: Ctx, _input: any, meta: ConstraintMeta) => {
      const caps = ctx.onBehalfOf ? await meta.capabilitiesOf(ctx.onBehalfOf) : ctx.capabilities;
      const limit = caps.get(meta.capability)?.[param];
      if (limit === undefined || limit === null) return violation(`没有为 ${meta.capability} 设置额度 ${param}`);
      return Number(cur[field]) <= Number(limit) ? ok() : violation(`${field}=${cur[field]} 超过额度 ${limit}`);
    },
  });
}

/** 二次认证：最近 maxAgeSec 秒内完成过二次认证 */
/** maxAgeSec 单位为秒，ctx.stepUpAt 单位为毫秒；缺失认证证据时返回拒绝而非跳过。 */
export function stepUp(maxAgeSec = 300): Constraint {
  return Object.freeze({
    name: 'stepUp',
    check: (_cur: any, ctx: Ctx) =>
      ctx.stepUpAt && Date.now() - ctx.stepUpAt <= maxAgeSec * 1000 ? ok() : violation('需要二次认证'),
  });
}

/** 自定义约束（仍然是一个纯函数，必须写清楚用到哪些字段） */
export function constraint(name: string, fields: string[], check: Constraint['check']): Constraint {
  return Object.freeze({ name, fields, check });
}
