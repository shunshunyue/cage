/**
 * 供列表、详情和路由守卫复用的页面级状态组件。
 * 将服务端可确认的错误与可恢复操作对应，保留返回链接；不泄露范围外记录是否真实存在。
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CageQueryError } from '@app/contracts';
import './page-state.css';

/** 页面级状态保留导航入口，详情直达失败时也能回到列表，而不是出现空白页。 */
/**
 * 渲染标题、说明、返回链接和可选附加操作。
 * props.title/description 为调用方提供的当前状态；to 是业务返回地址，label 缺省为返回列表。
 * children 可放重试按钮；组件只呈现内容，不自行读取数据或推断错误。
 */
export function PageState({
  title,
  description,
  to,
  label = '返回列表',
  children,
}: {
  title: string;
  description: string;
  to: string;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <section className="route-state" aria-labelledby="route-state-title">
      <span className="route-state-mark" aria-hidden="true">
        ↗
      </span>
      <h1 id="route-state-title">{title}</h1>
      <p>{description}</p>
      <Link className="route-link" to={to}>
        {label}
      </Link>
      {children}
    </section>
  );
}

/** 按服务端错误区分权限、范围/不存在和服务故障；不从 URL 推断记录是否存在。 */
/**
 * 将查询异常映射为页面状态。CageQueryError 的 FORBIDDEN 与 NOT_FOUND 不展示重试按钮，其他错误允许调用 retry。
 * props.error 为实际查询异常；to/label 决定退出路径，retry 由页面绑定 refetch。
 * NOT_FOUND 同时涵盖记录不存在与不在可访问范围，不能据此向用户确认数据库中有无此记录。
 */
export function QueryFailure({
  error,
  to,
  label,
  retry,
}: {
  error: Error;
  to: string;
  label?: string;
  retry: () => void;
}) {
  const code = error instanceof CageQueryError ? error.result.code : undefined;
  const title = code === 'FORBIDDEN' ? '暂无访问权限' : code === 'NOT_FOUND' ? '记录不可用' : '暂时无法读取';
  const description =
    code === 'FORBIDDEN'
      ? '当前账号没有访问此页面所需的权限，请联系管理员。'
      : code === 'NOT_FOUND'
        ? '记录不存在，或不在你当前可访问的数据范围内。'
        : code === 'UNAUTHENTICATED'
          ? '登录已过期，请重新登录后继续。'
          : '请检查网络或稍后重新尝试。';
  return (
    <PageState title={title} description={description} to={to} label={label}>
      {code !== 'FORBIDDEN' && code !== 'NOT_FOUND' && <button onClick={retry}>重新读取</button>}
    </PageState>
  );
}
