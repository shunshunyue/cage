import type { ReactNode } from 'react';

/** 统一页面标题的排版；不读取路由或业务状态，避免共享 UI 反向依赖某项业务。 */
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>
          {title}
          <span className="title-dot">.</span>
        </h1>
        <p className="muted">{description}</p>
      </div>
      {children}
    </div>
  );
}
