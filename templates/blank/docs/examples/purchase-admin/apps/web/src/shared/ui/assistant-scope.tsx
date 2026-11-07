import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { can, type PageContextInput } from '@yss123/cage-client';
import { AssistantPanel } from './assistant-panel';

export interface AssistantPageOptions {
  context: PageContextInput;
  suggestions: string[];
  fieldLabels?: Record<string, string>;
  commandLabels?: Record<string, string>;
}
type RegisterPage = (owner: symbol, options: AssistantPageOptions | null) => void;
const Registration = createContext<RegisterPage | null>(null);

/** 应用壳只挂载一个助理，切页和收起都不卸载正在进行的对话。 */
export function AssistantScope({ pageKey, fallback, children }: {
  pageKey: string; fallback: AssistantPageOptions; children: ReactNode;
}) {
  const [registered, setRegistered] = useState<{ owner: symbol; pageKey: string; options: AssistantPageOptions } | null>(null);
  const register = useCallback<RegisterPage>((owner, options) => {
    setRegistered(previous => options ? { owner, pageKey, options } : previous?.owner === owner ? null : previous);
  }, [pageKey]);
  // 切页的同一次渲染立即弃用旧页面信息，避免新页面加载时携带上一张单据。
  const current = registered?.pageKey === pageKey ? registered.options : fallback;
  return <Registration.Provider value={register}>
    {children}
    {can('Sys.ai.use') && <AssistantPanel {...current} pageKey={pageKey} />}
  </Registration.Provider>;
}

/** 页面仅声明自己的语义上下文；不渲染第二个面板，也不读取其他业务模块。 */
export function AssistantPage(options: AssistantPageOptions) {
  const register = useContext(Registration);
  const owner = useMemo(() => Symbol('assistant-page'), []);
  const serialized = JSON.stringify(options);
  useLayoutEffect(() => {
    if (!register) return;
    register(owner, JSON.parse(serialized));
    return () => register(owner, null);
  }, [register, owner, serialized]);
  return null;
}
