/**
 * purchase 模块的公开入口，对 app 暴露采购列表和独立详情页。
 * 外部组合通过本入口导入，页面、组件与内部 helper 的组织由模块自行维护。
 */
// 模块公开入口：应用壳只需要页面，不依赖内部表单与本地状态。
export { PurchaseOrdersPage } from './pages/purchase-orders-page';
export { PurchaseOrderDetailPage } from './pages/purchase-order-detail-page';
