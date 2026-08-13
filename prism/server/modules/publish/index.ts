// Static page publishing: authenticated management under /api/projects, and an
// unauthenticated read route at /p/:token/* mounted outside the API gate.
export { createPublishRouter } from './publish.routes.js';
export { createPublishPublicRouter } from './publish-public.routes.js';
// Re-exported for the preview module, which serves files under the same MIME
// whitelist and path-normalization rules.
export {
  PREVIEW_PAGE_CSP,
  PUBLISHED_PAGE_CSP,
  contentTypeFor,
  injectBaseHref,
  isHtml,
  normalizePublicSubPath,
  publicBaseHref,
} from './services/publish.service.js';
