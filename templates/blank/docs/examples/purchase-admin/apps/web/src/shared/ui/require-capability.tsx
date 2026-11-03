import type { ReactNode } from 'react';
import { useCan } from '@app/contracts';
import { PageState } from './page-state';

/** 直接输入 URL 也给出权限提示；真正的授权和数据范围仍由后端接口强制执行。 */
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
