// 登录与工作台共用的品牌组件；只呈现，不读取模块或会话。
import { Link } from 'react-router-dom';
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
