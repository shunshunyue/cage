/**
 * 业务操作结果的可关闭提示，内容和关闭状态由页面或 useCommand 持有。
 */
import type { ReactNode } from 'react';

/** 通用提示容器只负责呈现；提示文案和关闭后的业务行为由调用页面决定。 */
/**
 * 呈现 children 消息并在关闭按钮点击时调用 onClose。
 * 仅关闭提示，不回滚已经提交的命令，也不取消正在运行的任务。
 */
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
