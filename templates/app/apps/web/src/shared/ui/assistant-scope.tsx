/**
 * 工作台助理的页面上下文注册层：保持一个面板实例，同时按导航身份切换页面语义。
 * 页面只提交显式可见内容与草稿；工具发现、授权和数据读取仍由客户端及服务端完成。
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { can, type PageContextInput } from '@yss123/cage-client';
import { AssistantPanel } from './assistant-panel';

/**
 * 页面提供给助理的上下文与展示配置，不授予模型任何新能力。
 */
export interface AssistantPageOptions {
  /**
   * 当前页面的显式语义快照；未保存输入应置于 draft，不能冒充数据库事实。
   */
  context: PageContextInput;
  /**
   * 初次打开面板时可点击的建议问题，只是输入文案，不自动执行操作。
   */
  suggestions: string[];
  /**
   * 可选字段中文名表，用于确认预览；缺失时按字段键显示。
   */
  fieldLabels?: Record<string, string>;
  /**
   * 可选完整命令名到展示名映射，不改变服务端实际调用的命令。
   */
  commandLabels?: Record<string, string>;
}
/**
 * owner 标识注册者；options 为 null 表示释放自己的上下文，不能删除另一个页面的新注册。
 */
type RegisterPage = (owner: symbol, options: AssistantPageOptions | null) => void;
const Registration = createContext<RegisterPage | null>(null);

/** 应用壳只挂载一个助理，切页和收起都不卸载正在进行的对话。 */
/**
 * 在应用壳包裹 children，并渲染单个 AssistantPanel。
 * pageKey 是本次导航身份，fallback 是页面尚未注册时的安全兜底上下文。
 * 注册结果仅在 pageKey 匹配时使用；切页立即采用 fallback，避免加载期间将旧单据带入新问题。
 */
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
/**
 * 页面通过此无 UI 组件登记 options。序列化内容变化后在 layout effect 中重新注册，卸载时释放本 owner。
 * Symbol owner 防止旧页面的清理覆盖新页面注册；应放在 AssistantScope 内使用。
 */
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
