/**
 * directory 模块的公开导出边界，向 app 提供成员列表及独立详情页。
 * 其他模块通过这个入口组合页面，不依赖内部页面文件路径；具体读取与交互留在实现文件。
 */
// 空白模板利用已有组织模型演示列表/详情路由，不注册额外客户业务或演示数据。
export { UsersPage } from './pages/users-page';
export { UserDetailPage } from './pages/user-detail-page';
