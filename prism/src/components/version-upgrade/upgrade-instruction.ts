/**
 * What to tell the user about upgrading.
 *
 * Prism is deployed as a tar package and upgraded by unpacking a newer one, so
 * there is exactly one correct answer and it does not depend on how this copy
 * was installed. The git-checkout branch (`git pull`) went away with the rest of
 * the git surface, and `POST /api/system/update` — the endpoint behind the
 * in-app "Update Now" button — went with it, so nothing can self-update.
 *
 * The command lives here, not in i18n. A command line is not prose and does not
 * translate; keeping ten copies of one only meant ten chances to drift. The
 * string shown for `npm` installs used to be
 * `npm install -g @cloudcli-ai/cloudcli@latest`, inherited from upstream and
 * left in ten translation files where nobody looks for a shell command. Running
 * it installs a different product over the top of this one.
 */
export type UpgradeInstruction = {
  /** Command the user is invited to copy and run by hand. */
  command: string;
};

export function upgradeInstruction(): UpgradeInstruction {
  return { command: 'tar -xzf prism-<version>.tar.gz && npm ci && npm run build' };
}
