// 硬约束组合子：在加载之后、handler 之前执行（第 6 关）。代码定边界，阈值可以来自授权数据。
import type { CapabilityParams, Ctx, MaybePromise } from '../types.js';

export type ConstraintResult = { ok: true } | { ok: false; message: string };

export const ok = (): ConstraintResult => ({ ok: true });
export const violation = (message: string): ConstraintResult => ({ ok: false, message });

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

export interface Constraint<_A = any> {
  /** 约束名，出现在本体图和报错里 */
  readonly name: string;
  /** 用到的字段，抽取器据此画 uses 边，影响分析能找到它 */
  readonly fields?: readonly string[];
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
        return who && cur[field] === who ? violation(`操作人不能是 ${field} 记录的人（职责分离）`) : ok();
      },
    });
  },
};

/** 额度：字段值不得超过操作人在该能力点上的 ceiling 参数；多角色取最大值 */
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
