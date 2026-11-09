/**
 * 登录页与工作台复用的品牌组件，只负责显示品牌及首页链接。
 * 依赖 Router 的 Link 导航，不读取会话、不决定用户权限，也不导入具体业务模块。
 */
// 登录与工作台共用的品牌组件；只呈现，不读取模块或会话。
import { Link } from 'react-router-dom';
/**
 * 渲染可访问名称完整的首页链接；未登录时目标页面仍由 app 的会话守卫处理。
 */
export function Brand() {
  return (
    <Link className="brand" to="/workspace" aria-label="Cage 工作台首页">
      <span className="brand-mark">C</span>
      <span>
        Cage<span className="brand-dot">.</span>
      </span>
    </Link>
  );
}
