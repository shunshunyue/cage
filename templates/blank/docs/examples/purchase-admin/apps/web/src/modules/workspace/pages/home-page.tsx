import { Link } from 'react-router-dom';
import { PageHeading } from '../../../shared/ui/page-heading';

// 工作台只展示真实可访问的业务入口，不制造演示统计；业务页面各自按 URL 独立加载。
export function HomePage() {
  return (
    <>
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
