import type { ReactNode } from 'react';

/** 通用提示容器只负责呈现；提示文案和关闭后的业务行为由调用页面决定。 */
export function Notice({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div role="status" className="notice">
      {children}
      <button onClick={onClose} aria-label="关闭提示">
        ×
      </button>
    </div>
  );
}
