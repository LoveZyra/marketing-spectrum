import type { InstallMode } from '../../hooks/useVersionCheck';

/**
 * What to tell the user about upgrading, given how this copy was installed.
 *
 * Extracted so the rule can be asserted rather than read. The command shown
 * here is one the user is invited to copy and paste, so getting it wrong is not
 * a cosmetic bug: the string that used to be shown for `npm` installs was
 * `npm install -g @cloudcli-ai/cloudcli@latest`, inherited from upstream and
 * left in ten translation files where nobody looks for a shell command. Running
 * it installs a different product over the top of this one.
 *
 * The commands live here, not in i18n. A command line is not prose and does not
 * translate; keeping ten copies of one only meant ten chances to drift.
 */
export type UpgradeInstruction = {
  /** Command to run by hand, or null when there is no correct one to offer. */
  command: string | null;
  /**
   * Whether the in-app "Update Now" button should be shown.
   *
   * Must match what `POST /api/system/update` will actually accept, which is
   * `isPlatform || installMode === 'git'`. Showing the button any wider offers
   * an action the backend rejects; any narrower hides one that works.
   */
  canSelfUpdate: boolean;
};

export function upgradeInstruction(installMode: InstallMode, isPlatform: boolean): UpgradeInstruction {
  if (isPlatform) {
    return { command: 'npm run update:platform', canSelfUpdate: true };
  }

  if (installMode === 'git') {
    return { command: 'git checkout main && git pull && npm install', canSelfUpdate: true };
  }

  // No `.git` directory, and Prism is not published to a registry, so there is
  // no command that upgrades this copy in place. Saying so is more use than a
  // command that appears to work.
  return { command: null, canSelfUpdate: false };
}
