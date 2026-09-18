// Project file CRUD + file-tree endpoints (moved out of server/index.js).
// The composition root injects auth middleware and mounts the router at the
// app root, preserving the original route order and auth semantics.
export { createFilesRouter } from './files.routes.js';
// 直传下载:**不带登录态**的那两条,单独一个工厂,挂在 /api/downloads 下。
// 分开导出不是洁癖 —— 它们连 authenticateToken 的注入口都不留,谁在读这个
// barrel 都能一眼看出"这一个是无认证面"。
export { createFileDownloadRouter } from './files.routes.js';
// ei:会话产出通道要和项目文件接口用**同一套**内联安全判定 —— 两边对
// "什么类型允许 inline 渲染"的答案必须一致,否则加固就有缺口。
export { isInlineSafeContentType } from './files.routes.js';
export { getFileTree, getFileTreeMaxEntries } from './services/file-tree.service.js';
export { validatePathInProject, validateFilename } from './services/path-validation.service.js';
