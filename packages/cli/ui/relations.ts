import { kinds, nodeLabel, type GraphModel, type ViewEdge, type ViewNode } from './model.js';

/** 解释来自已抽取的声明，不借连线猜测运行结果。尤其要区分“允许读取”、
 * “声明依赖”和“事件触发”，否则图谱很容易被误读为一张执行时序图。 */
export interface RelationExplanation {
  label: string;
  category: string;
  why: string;
  purpose: string;
  direction: string;
  evidence: string[];
  source: ViewNode;
}

// 只读取路由 JSON 中与字段有关的结构，浏览器无需加载审批引擎。
interface RouteStep {
  kind: 'step';
  title: string;
  approver: { kind: string; field?: string };
}
interface RouteWhen {
  kind: 'when';
  cond: { field: string; op: string; value: unknown };
  steps: RouteStep[];
}

export function explainEdge(
  edge: ViewEdge,
  model: GraphModel,
  labels: Record<string, string> = {},
): RelationExplanation {
  const from = model.nodes.find((n) => n.key === edge.from)!;
  const to = model.nodes.find((n) => n.key === edge.to)!;
  const a = nodeLabel(from, labels),
    b = nodeLabel(to, labels);
  const field = to.id.slice(to.id.indexOf('.') + 1);
  const resource = (id: string) => labels[`resource:${id}`] ?? id;
  const result = (
    label: string,
    category: string,
    why: string,
    purpose: string,
    evidence: string[],
    source = from,
  ): RelationExplanation => ({
    label,
    category,
    why,
    purpose,
    evidence,
    source,
    direction: `“${a}” → “${b}”：${label}。`,
  });
  switch (edge.kind) {
    case 'field':
      return result(
        '包含字段',
        '数据结构',
        `“${a}”的字段声明中包含“${b}”。`,
        '说明业务对象由哪些数据组成；调整字段时，可以继续沿线查看受影响的查询、审批和事件。',
        [`${from.id}.fields.${field}`],
      );
    case 'refs':
      return result(
        '引用对象',
        '数据关联',
        `“${a}”声明为引用“${b}”的字段，保存所关联对象的标识。`,
        `用于理解这条数据关联到哪个${kinds[to.kind].label}。例如部门字段关联部门对象；具体查询仍受数据范围约束。这条线本身不执行查询。`,
        [`${from.id}: ref(${JSON.stringify(to.id)})`],
      );
    case 'ownership':
      return result(
        `拥有${kinds[to.kind].label}`,
        '视图归属 · 虚线',
        `“${b}”的标识位于“${from.id}.”之下，页面据此将它归入“${a}”。`,
        '帮助整理同一业务对象的命令、状态和能力点。这是页面推导的归属，不是抽取器声明的依赖，也不会触发命令。',
        [`${to.id} → 所属聚合 ${from.id}`],
      );
    case 'transition': {
      const command = model.nodes.find((n) => n.kind === 'command' && n.id === edge.via)!;
      const name = nodeLabel(command, labels);
      const stays = edge.from === edge.to;
      return result(
        stays ? '保持状态' : '迁移状态',
        '状态变化',
        `“${name}”声明${stays ? `在“${a}”状态执行后保持原状态` : `从“${a}”进入“${b}”`}。`,
        `用于检查业务生命周期是否完整。只有命令通过权限、约束并成功提交，${stays ? '操作才生效' : '状态才改变'}。`,
        [
          `命令：${command.id}`,
          `from: ${JSON.stringify(command.attrs.from)}`,
          `to: ${JSON.stringify(command.attrs.to)}`,
        ],
        command,
      );
    }
    case 'reads':
    case 'queries':
      return result(
        '读取数据',
        '读取依赖',
        `“${a}”在 reads 中声明读取“${b}”${edge.alias ? `，使用别名 ${edge.alias}` : ''}。`,
        '明确可读取的业务对象，并让影响分析找到依赖方；实际读取通过安全视图，受权限和数据范围约束。箭头指向数据来源，不表示先执行它。',
        [`${from.id}.reads${edge.alias ? `.${edge.alias}` : ''} → ${to.id}`],
      );
    case 'emits':
      return result(
        '产生事件',
        '事件协作',
        `“${a}”的 emits 中声明了“${b}”事件。`,
        '命令成功执行时按声明生成事件，连接后续反应、审批或外部同步；事务失败时不能当作已经发生。',
        [`${from.id}.emits → ${to.id}`],
      );
    case 'uses': {
      const as = edge.as ?? '';
      if (as === '可路由字段')
        return result(
          '允许审批读取',
          '审批可用字段',
          `“${a}”把“${b}”列入 routable，允许该字段作为审批流程变量。`,
          '明确审批可以拿到哪些业务数据。这里只表示允许使用；是否真的参与分支或审批选人，要查看审批路由的字段关系。',
          [`${from.id}.routable 包含 ${field}`],
        );
      if (as === '路由条件') {
        // fieldsUsed 同时包含 when 条件和 deptLeader 选人字段，不能一律解释成条件判断。
        const nodes = from.attrs.nodes as (RouteStep | RouteWhen)[];
        const conditions = nodes.filter((n): n is RouteWhen => n.kind === 'when' && n.cond.field === field);
        const steps = nodes
          .flatMap((n) => (n.kind === 'step' ? [n] : n.steps))
          .filter((s) => s.approver.kind === 'deptLeader' && s.approver.field === field);
        const operators: Record<string, string> = {
          gt: '大于',
          gte: '大于等于',
          lt: '小于',
          lte: '小于等于',
          eq: '等于',
          ne: '不等于',
          in: '属于',
        };
        const reasons = [
          ...steps.map((s) => `“${s.title}”步骤根据“${b}”找到对应部门的负责人`),
          ...conditions.map(
            (n) =>
              `当“${b}”${operators[n.cond.op]} ${JSON.stringify(n.cond.value)} 时，加入${n.steps.map((s) => `“${s.title}”`).join('、')}步骤`,
          ),
        ];
        return result(
          steps.length && conditions.length ? '选人和分支依据' : steps.length ? '确定审批人' : '判断审批分支',
          '审批路由依赖',
          `${reasons.join('；')}。`,
          '字段值会影响审批人或需要经过的审批步骤；修改字段含义时，应一起检查这些路由配置。',
          [
            ...steps.map((s) => `${s.title}: approver.deptLeader(${JSON.stringify(field)})`),
            ...conditions.map(
              (n) => `when(${n.cond.op}(${JSON.stringify(field)}, ${JSON.stringify(n.cond.value)}))`,
            ),
          ],
        );
      }
      if (as === '事件载荷')
        return result(
          '携带字段',
          '事件数据依赖',
          `“${a}”的默认事件载荷按同名字段从业务对象取“${b}”。`,
          '订阅方可以用事件中的这份数据处理后续业务；字段变更需要检查事件及订阅方的数据约定。箭头指向载荷的数据来源。',
          [`事件 ${from.id} 的同名字段 ${field} ← ${to.id}`],
        );
      if (as === '查询')
        return result(
          '查询使用字段',
          '查询字段线索',
          `抽取器在“${a}”的 SQL 或查询构造函数文本中匹配到了“${b}”的字段名。`,
          '提供检查查询依赖的线索。这里基于字段名文本匹配，可能匹配到注释或同名内容；实际筛选、分组或计算用途请核对查询声明。',
          [`${from.id}: SQL / build 文本匹配 ${field}`],
        );
      if (as === '出站映射')
        return result(
          '映射外发字段',
          '外部同步数据',
          `“${a}”的 fields 声明包含“${b}”对应的字段名；抽取器将它关联到发出事件的聚合中同名字段。`,
          '用于核对外发字段范围和字段变更的同步影响；具体取值及转换由事件载荷与 map 函数决定。',
          [`${from.id}.fields 包含 ${field}`, `同名聚合字段：${to.id}`],
        );
      if (as.startsWith('约束 ')) {
        const rule = as.slice(3);
        const purpose = rule.startsWith('ceiling(')
          ? `用于校验“${b}”是否超出调用人的审批额度。`
          : rule.startsWith('sod.notSameAs(')
            ? `用于校验调用人与“${b}”记录的人不同，避免同一人完成需要分离的职责。`
            : `该约束读取“${b}”执行命令前的业务检查；字段变更时应一起复核约束。`;
        return result('执行约束检查', '命令校验依赖', `“${a}”声明的约束 ${rule} 使用“${b}”。`, purpose, [
          `${from.id}.constraints → ${rule}`,
          `约束 fields 包含 ${field}`,
        ]);
      }
      return result('使用字段', '字段依赖', `“${a}”声明使用“${b}”。`, '用于追踪字段变更的影响范围。', [
        as || edge.kind,
      ]);
    }
    case 'triggers': {
      const label =
        to.kind === 'approval' ? '启动审批' : to.kind === 'outbound' ? '触发外部同步' : '触发反应';
      return result(
        label,
        '事件触发',
        `“${b}”订阅“${a}”作为${to.kind === 'approval' ? '启动' : '触发'}事件。`,
        to.kind === 'approval'
          ? '事件发生后启动对应审批流程，生成流程中的审批任务。'
          : to.kind === 'outbound'
            ? '事件发生后由 worker 处理外部推送，失败按投递策略重试。'
            : `事件发生后执行订阅的反应${to.attrs.tx === 'same' ? '，该反应与原命令处于同一事务' : '；执行方式由反应的事务声明决定'}。`,
        [`${to.id}.${to.kind === 'approval' ? 'start' : 'event'} → ${from.id}`],
        to,
      );
    }
    case 'targets': {
      if (to.kind === 'connector')
        return result(
          '调用外部系统',
          '连接器调用',
          `“${a}”声明通过“${b}”执行操作 ${labels[`operation:${from.attrs.operation}`] ?? from.attrs.operation}。`,
          '由连接器统一处理地址与字段白名单、密钥、限流和超时，让外部同步保持可管控。',
          [`${from.id}.connector → ${to.id}`, `operation: ${from.attrs.operation}`],
        );
      if (from.kind === 'outbound')
        return result(
          '成功后回写',
          '同步成功回调',
          `“${a}”的 onSuccess 绑定“${b}”。`,
          '外部操作成功后调用该命令，将返回结果按映射写回业务；失败时不执行成功回写。',
          [`${from.id}.onSuccess → ${to.id}`],
        );
      if (from.kind === 'inbound')
        return result(
          '回调转为命令',
          '外部回调',
          `“${a}”将接收的外部回调映射到“${b}”。`,
          '外部回调通过验签和数据校验后，使用业务命令处理，统一遵守状态和业务约束。',
          [`${from.id}.command → ${to.id}`],
        );
      const resources = [
        edge.acquires ? `获取“${resource(edge.acquires)}”` : '',
        edge.releases ? `释放“${resource(edge.releases)}”` : '',
      ].filter(Boolean);
      return result(
        '调用业务命令',
        '反应调用',
        `“${a}”把事件映射后交给“${b}”处理。`,
        `将后续业务操作交给受约束的命令执行。${resources.length ? `此声明还标记${resources.join('、')}，用于检查资源获取与释放是否成对。` : ''}`,
        [`${from.id}.command → ${to.id}`, ...resources],
      );
    }
    case 'binds': {
      if (from.kind === 'route')
        return result(
          '定义审批步骤',
          '流程配置',
          `“${a}”与“${b}”使用同一流程标识 ${from.attrs.process}。`,
          '这份路由定义流程里的审批步骤、选人方式和条件分支，供代码内审批引擎使用。',
          [`process: ${from.attrs.process}`],
        );
      const approved = from.attrs.onApproved === to.id;
      const rejected = from.attrs.onRejected === to.id;
      const outcome = approved && rejected ? '结束' : approved ? '通过' : '驳回';
      return result(
        `${outcome}后执行`,
        '审批结论回写',
        `“${a}”${outcome}时绑定执行“${b}”。`,
        '将审批结论交给业务命令推进单据状态，并统一执行权限和业务约束。',
        [
          approved ? `${from.id}.onApproved → ${to.id}` : '',
          rejected ? `${from.id}.onRejected → ${to.id}` : '',
        ].filter(Boolean),
      );
    }
    case 'calls':
      return result(
        '允许调用命令',
        '任务调用范围',
        `“${a}”在 calls 中声明可以调用“${b}”。`,
        '明确任务能执行哪些业务写入，并支持影响分析。每次任务是否实际调用该命令，取决于 run 中的业务逻辑。',
        [`${from.id}.calls → ${to.id}`],
      );
  }
}
