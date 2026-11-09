/**
 * 空白业务项目的工作台首页，解释尚未添加业务模块并提供真实成员目录和管理入口。
 * 不注册采购演示、不制造统计；客户业务应建立相邻模块，再经 app 接入导航。
 */
// 空白工作台模块：新增业务时建立相邻模块，由 app 导航接入，不在本页堆全部业务。
import { useCan } from '@app/contracts';
import { Link } from 'react-router-dom';

/**
 * 根据 User.read 的界面能力展示组织相关入口，其余区域显示业务空状态。
 * 拥有读取能力不等于获得全部管理权限；系统管理仍按具体操作检查能力。
 */
export function HomePage() {
  const canManage = useCan('User.read');
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">你的工作空间</p>
          <h1>工作台</h1>
          <p className="muted">业务从这里开始，逐步长成你需要的样子。</p>
        </div>
        <span className="project-tag">空白业务项目</span>
      </div>
      {canManage && (
        <p className="directory-intro">
          <Link className="record-link" to="/directory/users">
            打开成员目录 ↗
          </Link>
          <span>查看真实组织成员，也可作为新增业务列表与详情页的参考。</span>
        </p>
      )}
      <section className="empty-state" aria-labelledby="empty-title">
        <div className="empty-illustration" aria-hidden="true">
          <div className="sheet sheet-back" />
          <div className="sheet sheet-front">
            <span />
            <span />
            <span />
            <b>+</b>
          </div>
        </div>
        <p className="eyebrow">准备好，开始新的业务</p>
        <h2 id="empty-title">这里还没有业务模块</h2>
        <p>
          添加你的第一个业务对象和页面后，
          <br />
          这里就会成为团队日常工作的地方。
        </p>
        {canManage && (
          <a className="primary manage-link" href="/admin/">
            配置用户与权限<span aria-hidden="true">↗</span>
          </a>
        )}
      </section>
      <footer className="workspace-footer">
        <span>Cage · 让业务有序发生</span>
        <span>属于你的业务，由你定义</span>
      </footer>
    </>
  );
}
