/**
 * 业务路由的界面能力守卫，根据当前 SDK 能力快照决定渲染页面还是无权限提示。
 * 服务端对请求独立授权；缓存中的能力只影响界面入口，不增加数据可见范围。
 */
import type { ReactNode } from 'react';
import { useCan } from '@app/contracts';
import { PageState } from './page-state';

/** 直接输入 URL 也给出权限提示；真正的授权和数据范围仍由后端接口强制执行。 */
/**
 * 检查 capability 对应的页面入口权限，允许时渲染 children，否则提供回到 home 的链接。
 * 需放在已恢复会话的路由内，避免把尚未加载的能力列表当作最终账号权限。
 */
export function RequireCapability({
  capability,
  children,
  home,
}: {
  capability: Parameters<typeof useCan>[0];
  children: ReactNode;
  home: string;
}) {
  const allowed = useCan(capability);
  return allowed ? (
    children
  ) : (
    <PageState
      title="暂无访问权限"
      description="当前账号没有访问此页面所需的权限，请联系管理员。"
      to={home}
      label="返回工作台"
    />
  );
}
