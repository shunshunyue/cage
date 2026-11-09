/**
 * 业务页公共标题区，统一标题、说明与右侧操作的布局，不包含查询和权限逻辑。
 */
import type { ReactNode } from 'react';

/** 统一页面标题的排版；不读取路由或业务状态，避免共享 UI 反向依赖某项业务。 */
/**
 * 展示 eyebrow 分类文字、title 主标题、description 说明和 children 操作区。
 * 操作按钮及其 can 检查由使用页面提供；此组件不会替调用方判断权限。
 */
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
