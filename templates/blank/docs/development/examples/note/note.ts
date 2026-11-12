/**
 * 框架入门课的部门便笺声明，由学习者放入应用领域模块后从 domain 入口导出。
 * 聚合维护标题、归属和状态；命令仅描述业务变化，实际权限、事务与持久化由内核执行。
 * 本文件作为教材分发，不自动注册到空白应用；不存在文件、审批或外部 IO 副作用。
 */
import { aggregate, command, ref, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

/**
 * 部门便笺以标题和生命周期为一致性边界，通过部门与创建人字段支持安全读取。
 * 声明被 domain 导出后参与注册和生成；实际可见范围取决于角色授权，本声明不授予权限。
 * 所有命令结果均须满足非空标题不变量，归档保留记录并关闭修改入口。
 */
export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    /** 标题最多 120 字符；命令先去除两端空白，不变量拒绝空白标题。 */
    title: text(120).describe('便笺标题'),
    /** 内核新建时按当前主体填充的部门，用于服务端范围过滤。 */
    deptId: ref('Dept').describe('所属部门'),
    /** 内核新建时记录的创建人，可用于本人范围；不接受客户端指定。 */
    createdBy: ref('User').describe('创建人'),
  },
  // 机器状态用于命令和存储，业务名供图谱与上下文读取；普通注释不会替代 labels。
  states: states('active', 'archived', {
    terminal: ['archived'],
    labels: { active: '使用中', archived: '已归档' },
  }),
  scope: scope.deptSubtree('deptId'),
  invariants: { titleNotBlank: (record) => record.title.trim().length > 0 },
});

/**
 * 创建 active 便笺，输入只有去除两端空白后的标题，草稿直接作为业务结果返回。
 * 内核填写归属并执行 Note.create 授权、审计及事务；空标题、无能力或不合格范围会拒绝写入。
 * 不发布额外业务事件，也不接受客户端指定归属字段。
 */
export const createNote = command(Note, {
  name: 'create',
  description: '创建便笺',
  from: 'new',
  to: 'active',
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  handler: (draft) => draft,
});

/**
 * 修改 active 便笺标题；id 用于内核按范围锁定记录，页面另传已读取的 expectedVersion。
 * to: null 保留状态，返回值只包含标题变化；归档或版本冲突由内核拒绝，handler 不直接写库。
 */
export const updateNote = command(Note, {
  name: 'update',
  description: '修改便笺标题',
  from: 'active',
  to: null,
  input: z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(120) }),
  handler: (_draft, input) => ({ title: input.title }),
});

/**
 * 归档 active 便笺，输入沿用已有对象命令的默认 id，返回草稿以保留标题与归属。
 * 内核检查 Note.archive、范围与版本，再设置 archived；已有归档记录的修改和重复归档会拒绝。
 * 本动作不删除历史记录，不发布需 worker 处理的业务事件。
 */
export const archiveNote = command(Note, {
  name: 'archive',
  description: '归档便笺',
  from: 'active',
  to: 'archived',
  handler: (draft) => draft,
});
