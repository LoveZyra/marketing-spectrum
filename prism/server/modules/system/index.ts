// System endpoints (health/ready) and session usage endpoints
// (fork-point, token-usage) moved out of server/index.js. The composition
// root injects startup facts (install mode, version) and mounts each router
// at the app root in the original order. The self-update endpoint was removed
// with the git surface: Prism is upgraded by unpacking a new tar.
export { createSystemPublicRouter } from './system.routes.js';
export { createUsageRouter } from './usage.routes.js';
export { writeLocalServerMarker, removeLocalServerMarker } from './services/local-server-marker.service.js';
