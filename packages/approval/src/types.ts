// 审批适配接口：不管最后用审批引擎还是代码内封闭路由（待决策 D4），都实现同一个接口。
// 引擎只给结论，结论由桥接代码转成命令调用。
import type { ApprovalEngine } from '@yss123/cage-kernel/worker';

/** 引擎交给桥接层的业务结论；结果不会直接更新业务表，必须解析到绑定命令重新校验。 */
export interface ApprovalOutcome {
  process: string;
  tenantId: string;
  /** 单据 id */
  businessKey: string;
  outcome: 'approved' | 'rejected' | 'returned';
  /** 最后一位审批人：结论命令以流程身份执行，代表这个人（职责分离、额度按他判断） */
  lastApprover?: string;
  /** 审批所针对的单据提交版本；提供时命令拒绝把旧审批结论应用到已变化的对象。 */
  expectedVersion?: number;
}

/** 外部引擎适配约定；调用方负责可信回调来源，桥接层负责重新核对结论命令及真人权限。 */
export interface ApprovalAdapter extends ApprovalEngine {
  /** 注册流程结束回调 */
  onCompleted(cb: (r: ApprovalOutcome) => Promise<void>): void;
}

export type { ApprovalEngine };
