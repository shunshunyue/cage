// 审批适配接口：不管最后用审批引擎还是代码内封闭路由（待决策 D4），都实现同一个接口。
// 引擎只给结论，结论由桥接代码转成命令调用。
import type { ApprovalEngine } from '@yss123/cage-kernel/worker';

export interface ApprovalOutcome {
  process: string;
  tenantId: string;
  /** 单据 id */
  businessKey: string;
  outcome: 'approved' | 'rejected';
  /** 最后一位审批人：结论命令以流程身份执行，代表这个人（职责分离、额度按他判断） */
  lastApprover: string;
}

export interface ApprovalAdapter extends ApprovalEngine {
  /** 注册流程结束回调 */
  onCompleted(cb: (r: ApprovalOutcome) => Promise<void>): void;
}

export type { ApprovalEngine };
