/**
 * 浏览器审批任务协议：只包含 DTO 和输入类型，由 CageClient 复用会话、CSRF 与错误处理发送请求。
 * 不依赖后端审批包；任务策略仅控制入口展示，服务端才决定归属、权限、版本及可执行状态。
 */
/** 当前用户的待办摘要；业务变量仅为声明白名单，不能把它当完整单据。 */
export interface ApprovalTask {
  /** 任务与实例 UUID；同一单据重提会创建新实例。 */
  id: string; instanceId: string;
  /** 流程标识、聚合名和单据 UUID。 */
  process: string; aggregate: string; businessKey: string;
  /** 零基步骤索引、标题及 pending/waiting/approved/rejected/returned/skipped/cancelled 状态；waiting 只能查看。 */
  step: number; title: string; status: string;
  /** 并行组/分支路径；主线为空，兼容旧服务端时可缺省，不把节点索引当作实际执行顺序。 */
  branchPath?: { parallel: string; branch: string }[];
  /** routable 历史变量（始终去隐藏/掩码）及 UTC 创建时间；明文另走业务读取接口。 */
  vars: Record<string, unknown>; createdAt: string;
  /** 当前节点总办理截止时间（UTC）；null 表示本轮未配置时限，加签、转办和领取不重置。 */
  dueAt: string | null;
  /** 任务版本，与业务对象的 version 独立。 */
  revision: number;
  /** 候选任务领取前为 null；领取成功后才可决定。 */
  assigneeId: string | null;
  /** 直接分配或可领取候选池；不是额外的权限授予。 */
  assignment: 'direct' | 'candidate';
  /** 发起本次加签的原任务；原票及旧版加签可能为 null。 */
  parentTaskId: string | null;
  /** 加签相对父票的顺序；null 表示原票或旧记录。 */
  signPosition: 'parallel' | 'before' | 'after' | null;
  /** 该实例开放的加签位置，旧并行政策仅 parallel；额外票仍不能再次加签。 */
  signPositions: readonly ('parallel' | 'before' | 'after')[];
  /** 委派原负责人；无委派责任时为 null。 */
  ownerId: string | null;
  /** pending 只能归还，resolved 为已归还；null 为未委派。 */
  delegation: 'pending' | 'resolved' | null;
  /** 路由原始待办或追加的前后/并行必签待办。 */
  taskKind: 'original' | 'additional';
  /** 节点快照开放的操作；未开放默认 false，加签待办不能再加签。 */
  actions: { transfer?: boolean; delegate?: boolean; addSign?: boolean };
}
/** 所有任务流转必须携带读取到的任务版本及原因，失败后重新读取，不自动重放写入。 */
interface TaskActionBase {
  /** 当前待办 revision，过期返回 CONFLICT。 */
  expectedRevision: number;
  /** 1–1000 字的共享操作说明，不放凭据或不应向单据读者披露的敏感信息。 */
  reason: string;
}
/** 领取/释放需 candidate 声明；转办/委派/加签需 actions 开放。加签默认 parallel，before/after 由服务端阶段依赖控制。 */
export type ApprovalTaskAction = TaskActionBase & (
  | { action: 'transfer' | 'delegate'; targetUserId: string }
  | { action: 'resolve' | 'claim' | 'unclaim' }
  | { action: 'addSign'; userIds: string[]; placement?: 'parallel' | 'before' | 'after' }
);
/** 服务端已提交的任务操作回执；不表示审批流程已经结束。 */
export interface ApprovalTaskActionResult {
  /** 原任务 ID 及更新后的版本。 */
  taskId: string; revision: number;
  /** 本次创建的加签任务 ID，其他操作为空。 */
  createdTaskIds: string[];
}
/** 按业务对象 read/范围授权的人工操作历史；迁移前发生的动作没有补录记录。 */
export interface ApprovalTaskHistory {
  /** 顺序递增的操作记录；bigint ID 用字符串避免精度丢失。 */
  items: {
    /** 记录 ID、实例 UUID；流程取消等实例动作 taskId 为 null。 */
    id: string; instanceId: string; taskId: string | null;
    /** 真人 UUID；系统取消为 null。 */
    actorId: string | null;
    /** 操作类型、共享意见、结构化目标及版本信息、UTC 时间。 */
    action: string; reason: string | null; details: Record<string, unknown>; createdAt: string;
  }[];
  /** 下一页 after 值，null 表示本次查询时已到末尾。 */
  nextCursor: string | null;
}

/** 本人站内流程提醒；只包含当前授权且仍与本人有关的任务，不包含整份单据或候选名单。 */
export interface ApprovalNotice {
  /** bigint 用十进制字符串传输；实例、任务均为 UUID。 */
  id: string; instanceId: string; taskId: string;
  /** 流程、聚合及单据标识，供应用自己的路由定位对象。 */
  process: string; aggregate: string; businessKey: string;
  /** 零基节点序号与提交时保存的节点标题。 */
  step: number; title: string;
  /** 临期、超时或申请人主动催办；提醒不会自动执行审批决定。 */
  kind: 'due_soon' | 'overdue' | 'urge';
  /** 催办人和原因；自动提醒为空。原因只应填写可以向当前审批参与者披露的内容。 */
  actorId: string | null; reason: string | null;
  /** UTC 时间；readAt=null 为未读，dueAt=null 为没有办理时限。 */
  createdAt: string; readAt: string | null; dueAt: string | null;
}

/** 提醒以稳定记录游标分页；当前权限变化会过滤记录，空页仍可能有下一页。 */
export interface ApprovalNotices {
  /** 本页授权可见记录。 */
  items: ApprovalNotice[];
  /** 继续读取时传作 after；null 表示已遍历到当前末尾。 */
  nextCursor: string | null;
}

/** 当前本人发起、仍在运行且显式开放催办的流程；申请人身份来自实例冻结的路由字段。 */
export interface ApprovalRequest {
  /** 实例 UUID；重提后的新轮次使用新 UUID，不能从旧页面催办新轮次。 */
  id: string;
  /** 流程、聚合及单据 UUID。 */
  process: string; aggregate: string; businessKey: string;
  /** 当前零基节点及标题；提交催办时传 expectedStep，服务端仍会锁定并复核。 */
  currentStep: number; title: string;
  /** 完整活跃节点集合；并行催办需传 expectedSteps，旧服务端可能省略。 */
  currentSteps?: number[];
  /** 每条分支当前环节与独立截止时间；dueAt 摘要为这些环节中最早截止时间。 */
  activeSteps?: { step: number; title: string; dueAt: string | null; branchPath: { parallel: string; branch: string }[] }[];
  /** 节点总时限与最早再次催办时间；null 分别表示未设时限、尚未催办。 */
  dueAt: string | null; nextUrgeAt: string | null;
}
