/**
 * 验证采购 Web 登录回跳地址的纯函数边界。
 * 合法站内路径保留查询与锚点，外站、登录循环和服务端保留入口被拒绝。
 * 本套件不启动路由器或浏览器，不能代替深链接、刷新及前进后退的实际验收。
 */
// 模板的登录回跳属于应用基础设施；这里验证实际行为，不通过源码字符串推断导航正确。
import { expect, it } from 'vitest';
import { loginReturnTo } from '../../../examples/purchase-admin/apps/web/src/shared/lib/navigation.js';

it('登录后保留原页面、查询条件和锚点', () => {
  const target = '/procurement/orders/abc?section=items&page=2#delivery';
  expect(loginReturnTo(`?returnTo=${encodeURIComponent(target)}`, '/workspace')).toBe(target);
  expect(loginReturnTo('', '/workspace')).toBe('/workspace');
});

it('登录回跳拒绝外部地址、登录循环和服务端保留入口', () => {
  for (const target of [
    'https://example.com/',
    '//example.com/',
    '/\\example.com/',
    '/login?returnTo=/login',
    '/x/../api/me',
    '/admin/',
    '/auth/callback',
    '/hooks/erp',
    '/assets/missing.js',
  ]) {
    expect(loginReturnTo(`?returnTo=${encodeURIComponent(target)}`, '/workspace')).toBe('/workspace');
  }
});
