// Root-only administration router (account review, quotas, status panels) plus the
// one-shot startup backfill that hands unowned projects to the root account.
export { createAdminRouter } from './admin.routes.js';
export { backfillProjectOwners } from './project-owner-backfill.js';
