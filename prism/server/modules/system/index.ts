// System endpoints (health/ready/update) and session usage endpoints
// (fork-point, token-usage) moved out of server/index.js. The composition
// root injects auth middleware and startup facts (install mode, version,
// app root) and mounts each router at the app root in the original order.
export { createSystemPublicRouter, createSystemUpdateRouter } from './system.routes.js';
export { createUsageRouter } from './usage.routes.js';
export { writeLocalServerMarker, removeLocalServerMarker } from './services/local-server-marker.service.js';
