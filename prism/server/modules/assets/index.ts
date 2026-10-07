// Routers mounted by server/index.js: /api/assets (chat image upload, and serving
// from the global ~/.prism/assets folder) and /api/attachments (per-user usage).
export { default as assetsRoutes } from './assets.routes.js';
export { default as attachmentUsageRoutes } from '@/modules/assets/attachment-usage.routes.js';
