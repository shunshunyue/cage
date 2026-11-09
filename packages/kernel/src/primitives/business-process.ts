/**
 * 定义面向业务人员与 agent 阅读的流程板块、阶段和连线，并引用真实可执行声明作为证据。
 * 注册表和 CLI 检查说明与实现关系，图工作台据此展示中文流程；该阅读规格不调度命令、创建审批人、授予权限或自动产生事件关系。
 */
// 业务流程是可检查的阅读规格。它引用已有声明，不调度命令，也不授予执行权限。
import { BUSINESS_PROCESS, INBOUND, OUTBOUND, brandOf } from '../brands.js';
import { declError } from '../errors.js';
import type { AnyAggregate } from './aggregate.js';
import type { AnyCommand } from './command.js';
import type { AnyEvent } from './event.js';
import type { AnyQuery, AnyReaction, Approval, Job } from './flow.js';

/** 使用对象引用，让注册表能发现未导出的实现，避免字符串随重命名悄悄失效。 */
export type BusinessAction = AnyCommand | AnyEvent | AnyReaction | AnyQuery | Approval | Job
  | { /** 入站连接器声明品牌；真实协议校验和命令调用由连接器实现。 */ readonly [INBOUND]: true } | { /** 出站连接器声明品牌；业务流程说明只引用它，不在此发起外部请求。 */ readonly [OUTBOUND]: true };

/** 面向业务阅读的一个阶段；action 是主证据，details 和 related 补充实现与对象联系。 */
export interface BusinessStage {
  /**
   * 阶段中文名称，必须非空，用于流程阅读卡片。
   */
  readonly title: string;
  /**
   * 阶段具体业务职责及边界说明，必须非空；不能只靠标题替代。
   */
  readonly description: string;
  /** 业务职责说明；不替代角色授权或审批选人。 */
  readonly actor?: string;
  /**
   * 可选显示/结构种类：action 操作、decision 决策、end 结束；end 禁止后续连线。
   */
  readonly kind?: 'action' | 'decision' | 'end';
  /**
   * 该阶段的主要真实声明引用，必须属于允许的命令/事件/反应/查询/审批/任务/连接器类型。
   */
  readonly action: BusinessAction;
  /**
   * 可选补充实现声明列表，构造后规范化为空或冻结列表；不是按列表自动调度的步骤。
   */
  readonly details?: readonly BusinessAction[];
  /**
   * 可选关联业务对象及标签/via 证据，说明阶段与其他聚合的联系；CLI 继续核对真实声明关系。
   */
  readonly related?: readonly {
    /** 关联的实际聚合声明，不接受仅有表名的字符串。 */
    readonly object: AnyAggregate;
    /** 该关联在此阶段的业务意义，必须非空。 */
    readonly label: string;
    /** 这份实际声明负责关联；CLI 继续核对它与阶段、对象之间的关系。 */
    readonly via: BusinessAction;
  }[];
}

/** 可视化阶段连线；mode 描述业务推进方式，不会创建运行时自动触发器。 */
export interface BusinessTransition<S extends string = string> {
  /**
   * 起点阶段 key，必须存在于 stages，不允许从 end 节点继续。
   */
  readonly from: S;
  /**
   * 终点阶段 key，必须存在于 stages。
   */
  readonly to: S;
  /**
   * 业务推进方式的阅读说明：人工触发、自动推进或等待；不创建运行时触发器。
   */
  readonly mode: 'manual' | 'automatic' | 'wait';
  /**
   * 连线的业务条件/动作说明，必须非空；不能代替实际命令约束。
   */
  readonly label: string;
  /** 次要路径按需展开；审批通过/驳回等主要分支应保持可见。 */
  readonly branch?: boolean;
}

/** 将已有可执行声明组织成中文业务流程；保持对象引用以便检查代码与说明的一致性。 */
export interface BusinessProcess {
  /**
   * 业务流程阅读规格品牌标记，供注册表和图谱识别。
   */
  readonly [BUSINESS_PROCESS]: true;
  /**
   * 稳定流程标识，使用小写短横线格式；区别于中文标题。
   */
  readonly name: string;
  /**
   * 流程中文名称，必须非空。
   */
  readonly title: string;
  /**
   * 完整流程的职责及边界说明，必须非空。
   */
  readonly description: string;
  /**
   * 所属业务板块元数据：id 为稳定小写短横线标识，title/description 为非空中文名称与说明。
   */
  readonly area: { /** 稳定业务板块标识，使用小写短横线格式。 */ readonly id: string; /** 业务板块中文名称，必须非空。 */ readonly title: string; /** 板块职责与边界说明，必须非空。 */ readonly description: string };
  /**
   * 主业务对象的实际聚合声明引用，不接受仅有名称的自造对象。
   */
  readonly subject: AnyAggregate;
  /**
   * 入口阶段 key，必须存在于 stages，不自动执行其 action。
   */
  readonly entry: string;
  /**
   * 阶段 key 到阅读规格的冻结映射，每个阶段必须有有效名称、说明和真实声明证据。
   */
  readonly stages: Readonly<Record<string, BusinessStage>>;
  /**
   * 阶段连线冻结列表，重复边和不存在阶段会在构造时拒绝；实际可执行依赖由 CLI 继续验证。
   */
  readonly transitions: readonly BusinessTransition[];
}

/**
 * 校验流程阅读规格的标识、说明、阶段引用、连线和结束节点，再冻结所有容器。
 * 这里只证明规格内部引用成立；阶段间真实事件/命令关系由 CLI 图规则继续验证。
 * 不执行 action，也不因 actor 文案自动授予权限或选择审批人。
 */
export function businessProcess<const S extends Record<string, BusinessStage>>(
  name: string,
  def: Omit<BusinessProcess, typeof BUSINESS_PROCESS | 'name' | 'stages' | 'entry' | 'transitions'> & {
    /** 以稳定阶段 key 定义具体阶段，泛型据此约束入口和连线。 */
    stages: S;
    /** 入口必须是 stages 的已有 key，构造时再次校验实际存在。 */
    entry: keyof S & string;
    /** 连接已有阶段的阅读规格，起终点类型受 stages 限定，不自动生成运行时事件关系。 */
    transitions: readonly BusinessTransition<keyof S & string>[];
  },
): BusinessProcess {
  const invalid = (reason: string): never => { throw declError('CAGE-BIZ-001', `${name}：${reason}`); };
  const identifier = (value: string) => /^[a-z][a-z0-9-]*$/.test(value);
  const text = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (!identifier(name) || !identifier(def.area.id)) invalid('流程与板块标识须使用小写短横线格式');
  if (brandOf(def.subject) !== 'AGGREGATE') invalid('主业务对象必须引用实际聚合声明');
  if (![def.title, def.description, def.area.title, def.area.description].every(text)) invalid('请填写流程及业务板块的名称和说明');
  if (!Object.hasOwn(def.stages, def.entry)) invalid('入口阶段不存在');
  const stages: Record<string, BusinessStage> = {};
  const actionKinds = new Set(['COMMAND', 'EVENT', 'REACTION', 'QUERY', 'APPROVAL', 'JOB', 'INBOUND', 'OUTBOUND']);
  for (const [id, stage] of Object.entries(def.stages)) {
    if (!identifier(id) || !text(stage.title) || !text(stage.description)) invalid(`阶段 ${id} 需要有效标识、名称和说明`);
    if (stage.kind && !['action', 'decision', 'end'].includes(stage.kind)) invalid(`阶段 ${id} 的类型无效`);
    for (const action of [stage.action, ...(stage.details ?? []), ...(stage.related ?? []).map(r => r.via)]) {
      if (!actionKinds.has(brandOf(action) ?? '')) invalid(`阶段 ${id} 必须引用实际业务操作、审批或自动处理声明`);
    }
    for (const relation of stage.related ?? []) {
      if (brandOf(relation.object) !== 'AGGREGATE' || !text(relation.label)) invalid(`阶段 ${id} 的关联需要业务对象和说明`);
    }
    stages[id] = Object.freeze({ ...stage,
      details: Object.freeze([...(stage.details ?? [])]),
      related: Object.freeze((stage.related ?? []).map(r => Object.freeze({ ...r }))),
    });
  }
  const seen = new Set<string>();
  for (const edge of def.transitions) {
    if (!Object.hasOwn(stages, edge.from) || !Object.hasOwn(stages, edge.to)) invalid(`连线 ${edge.from} → ${edge.to} 引用了不存在的阶段`);
    if (!['manual', 'automatic', 'wait'].includes(edge.mode) || !text(edge.label)) invalid('每条连线需要执行方式和业务说明');
    const key = `${edge.from}>${edge.to}:${edge.mode}:${edge.label}`;
    if (seen.has(key)) invalid(`重复连线：${edge.from} → ${edge.to}`);
    seen.add(key);
    if (stages[edge.from].kind === 'end') invalid(`结束阶段 ${edge.from} 不能有后续连线`);
  }
  return Object.freeze({ ...def, [BUSINESS_PROCESS]: true as const, name,
    area: Object.freeze({ ...def.area }), stages: Object.freeze(stages),
    transitions: Object.freeze(def.transitions.map(edge => Object.freeze({ ...edge }))),
  });
}
