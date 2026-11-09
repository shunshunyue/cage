/**
 * 采购工作台首页，提供采购、审批和库存的固定业务入口，不伪造业务统计。
 * 实际记录与待办在对应页面通过生成契约读取，系统管理由独立页面负责。
 */
import { Link } from 'react-router-dom';
import { PageHeading } from '../../../shared/ui/page-heading';
import { AssistantPage } from '../../../shared/ui/assistant-scope';

// 工作台展示实际配置的业务入口，不制造演示统计；访问权限由目标路由及接口检查。
/**
 * 渲染导航卡片，链接进入各模块独立 URL。
 * 本页不按能力隐藏卡片，进入页面后仍需通过路由守卫和服务端检查。
 */
export function HomePage() {
  return (
    <>
      <AssistantPage context={{ page: { id: 'workspace', title: '采购工作台', kind: 'dashboard', route: '/workspace' },
        visibleContent: [{ id: 'workspace-entries', text: '工作台提供采购单、审批待办和库存台账入口。' }],
      }} suggestions={['我有哪些待处理的审批？', '了解采购单的完整处理流程', '汇总本月我能查看的采购金额']} />
      <PageHeading
        eyebrow="WORKSPACE"
        title="采购工作台"
        description="从采购、审批到库存，每个页面都有可以收藏和分享的地址。"
      />
      <section className="entry-grid">
        <Link to="/procurement/orders">
          <small>01 / PROCUREMENT</small>
          <h2>采购单 ↗</h2>
          <p>查看单据、新建采购与跟踪处理进度。</p>
        </Link>
        <Link to="/approvals">
          <small>02 / APPROVALS</small>
          <h2>审批待办 ↗</h2>
          <p>处理分配给你的任务，直接打开关联单据。</p>
        </Link>
        <Link to="/inventory">
          <small>03 / INVENTORY</small>
          <h2>库存台账 ↗</h2>
          <p>查看物料与登记数量。</p>
        </Link>
      </section>
    </>
  );
}
