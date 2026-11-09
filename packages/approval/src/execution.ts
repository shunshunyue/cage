/**
 * 结构化审批执行计划：把顺序、条件和 AND 并行声明编译成有界无环依赖，供原生引擎调度。
 * 计划随既有 steps JSON 一起持久保存；节点记录的唯一键和实例行锁负责执行幂等，不创建第二套连接或任务系统。
 * 条件只在启动时求值，旧快照没有 execution 时保持相邻顺序；本模块不支持循环、任意跳转或在途迁移。
 */
import { declError } from '@yss123/cage-kernel';
import { evalCondition, type ApprovalStep, type RouteNode } from './route.js';

/** 节点所属并行分支的展示路径；按外层到内层排列，名称来自声明，不携带选人或 AI 提示词。 */
export interface BranchLocation {
  /** 所属并行组的标题。 */
  parallel: string;
  /** 该组内唯一的分支标题。 */
  branch: string;
}

/** 与人工/AI 步骤一起存入实例快照的内部执行元数据；索引只在本实例内有效。 */
export interface StepExecution {
  /** 计划格式版本，便于今后明确识别兼容边界。 */
  schema: 1;
  /** 所有前驱必须 approved 才能创建本节点；空数组表示启动入口。 */
  dependsOn: number[];
  /** 分支归属；普通主线节点为空数组。 */
  branchPath: BranchLocation[];
  /** 完整路由声明的内容指纹，绑定启动时版本，不是可迁移版本号。 */
  definitionVersion: string;
}

/** 旧快照没有元数据时按原顺序解释；新快照既保存执行政策，也保存已解析的依赖关系。 */
export type ExecutableStep = ApprovalStep & { execution?: StepExecution };

/**
 * 遍历声明并检查结构预算，返回所有叶子步骤及条件字段；用于构建期校验，不能按本次变量跳过非法配置。
 * 最多 128 个叶子、512 个声明节点、8 层容器，每组 2–16 个具名分支；预算同时限制循环对象和恶意深嵌套。
 */
export function inspectRoute(nodes: readonly RouteNode[]): { steps: ApprovalStep[]; fields: string[] } {
  const steps: ApprovalStep[] = [], fields = new Set<string>();
  let count = 0;
  const visit = (items: readonly RouteNode[], depth: number): void => {
    if (depth > 8 || !Array.isArray(items) || !items.length) throw declError('CAGE-APPR-006', '审批容器不能为空，嵌套最多8层');
    for (const item of items as readonly RouteNode[]) {
      if (++count > 512) throw declError('CAGE-APPR-006', '审批声明最多512个结构节点');
      if (item.kind === 'when') { fields.add(item.cond.field); visit(item.steps, depth + 1); }
      else if (item.kind === 'parallel') {
        if (!item.title?.trim() || item.branches.length < 2 || item.branches.length > 16 ||
          new Set(item.branches.map(branch => branch.title)).size !== item.branches.length)
          throw declError('CAGE-APPR-006', '并行组需标题及2–16个名称不重复的分支');
        for (const branch of item.branches) {
          if (branch.kind !== 'branch' || !branch.title?.trim()) throw declError('CAGE-APPR-006', '并行分支必须有标题');
          visit(branch.nodes, depth + 1);
        }
      } else if (item.kind === 'step' || item.kind === 'ai') {
        steps.push(item);
        if (steps.length > 128) throw declError('CAGE-APPR-006', '审批路由最多128个办理节点');
      } else throw declError('CAGE-APPR-006', '审批包含未知节点类型');
    }
  };
  visit(nodes, 0);
  return { steps, fields: [...fields] };
}

/**
 * 将结构化声明编译为拓扑有序的节点快照；每条分支继承入口依赖，后续节点等待所有分支末端。
 * 条件为空的分支直接贡献入口依赖，因此不会产生永久等不到的汇合；整个路由为空时明确拒绝启动。
 * 不修改声明、不访问数据库；调用方将返回结果与实例同事务保存。
 */
export function compileSteps(nodes: readonly RouteNode[], vars: Record<string, unknown>, definitionVersion: string): ExecutableStep[] {
  const out: ExecutableStep[] = [];
  const sequence = (items: readonly RouteNode[], predecessors: number[], branchPath: BranchLocation[]): number[] => {
    let tail = predecessors;
    for (const node of items) {
      if (node.kind === 'when') {
        if (evalCondition(node.cond, vars)) tail = sequence(node.steps, tail, branchPath);
      } else if (node.kind === 'parallel') {
        // 各分支从同一前驱集合出发，不能让前一个分支的末端成为后一个分支的入口。
        const incoming = tail;
        tail = [...new Set(node.branches.flatMap(branch => sequence(branch.nodes, incoming,
          [...branchPath, { parallel: node.title, branch: branch.title }])))];
      } else {
        const index = out.length;
        out.push({ ...node, execution: { schema: 1, dependsOn: [...tail], branchPath: [...branchPath], definitionVersion } });
        tail = [index];
      }
    }
    return tail;
  };
  sequence(nodes, [], []);
  if (!out.length) throw declError('CAGE-APPR-006', '审批条件未展开出任何办理节点');
  return out;
}

/** 解析当前实例节点的前驱；无新元数据的历史顺序实例仍只等待前一个步骤，不根据当前代码重算。 */
export function dependencies(steps: readonly ExecutableStep[], index: number): readonly number[] {
  return steps[index].execution?.dependsOn ?? (index === 0 ? [] : [index - 1]);
}

/** 活跃状态包含 AI 排队/运行/人工接管和可诊断失败；只有 approved 能满足后继依赖。 */
export const ACTIVE_STEP_STATUSES = ['queued', 'running', 'waiting_manual', 'failed'] as const;
