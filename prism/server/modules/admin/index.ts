// Root-only account administration (approval panel backend) plus the one-shot
// startup backfill that hands pre-existing projects to the root account.
export { createAdminRouter } from './admin.routes.js';
export { backfillProjectOwners } from './project-owner-backfill.js';
