/**
 * auth 模块的公开导出边界，向 app 提供登录页面。
 * 其他模块通过这个入口组合页面，不依赖内部页面文件路径；具体读取与交互留在实现文件。
 */
export { LoginPage } from './pages/login-page';
