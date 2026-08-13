import { appConfigDb, projectsDb, userDb } from '@/modules/database/index.js';
import { listRootUsernames } from '@/shared/root-users.js';

/**
 * Flag key. Its presence — not its value — is what stops the backfill running
 * a second time.
 */
const BACKFILL_FLAG = 'projects_owner_backfilled';

export type BackfillOutcome =
  | { status: 'already_done' }
  | { status: 'no_root_account' }
  | { status: 'backfilled'; rootUserId: number; rootUsername: string; projectsAssigned: number };

/**
 * Hands every pre-existing project to the root account, once.
 *
 * This deliberately does not live in `migrations.ts`. Migrations run before
 * anyone can log in, and the root account named by `PRISM_ROOT_USERS` may not
 * be registered yet — a migration-time UPDATE would either find no root and
 * silently do nothing forever, or need its own retry mechanism. Instead this
 * runs on every boot and gives up quietly until the root account exists.
 *
 * The flag is written exactly once. That matters: without it, a project that
 * root later makes public (`owner_user_id = NULL`) would be clawed back on the
 * next restart, and "make this public" would look like it silently failed.
 */
export function backfillProjectOwners(env: NodeJS.ProcessEnv = process.env): BackfillOutcome {
  if (appConfigDb.get(BACKFILL_FLAG)) {
    return { status: 'already_done' };
  }

  for (const username of listRootUsernames(env)) {
    const rootUserId = userDb.findIdByUsername(username);
    if (rootUserId === undefined) continue;

    const projectsAssigned = projectsDb.assignUnownedProjectsTo(rootUserId);
    appConfigDb.set(BACKFILL_FLAG, new Date().toISOString());

    console.log(
      `[Owners] Backfilled ${projectsAssigned} project(s) to root user "${username}" (id ${rootUserId})`,
    );
    return { status: 'backfilled', rootUserId, rootUsername: username, projectsAssigned };
  }

  // No configured root has registered yet. Try again next boot — and say so,
  // because a silent skip here looks exactly like a broken migration later.
  console.log(
    '[Owners] Project owner backfill skipped: no account from PRISM_ROOT_USERS exists yet',
  );
  return { status: 'no_root_account' };
}
