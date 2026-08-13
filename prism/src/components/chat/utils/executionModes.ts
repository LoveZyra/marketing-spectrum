import type { PermissionMode } from '../types/types';

/**
 * The execution-mode gears shown in the composer.
 *
 * These are a *presentation* of the provider's permission modes, not a
 * replacement for them: each gear maps 1:1 onto a mode the server already
 * understands, so nothing new travels over the wire. What changes is that the
 * chip used to cycle blindly through five values with only a colour and a
 * two-word label to tell them apart — you had to click through the whole ring
 * to find out what the options were, and two of them (`bypassPermissions`,
 * `acceptEdits`) hand real authority to the agent.
 *
 * Per-tool confirmation is untouched and stays the backstop. A gear decides
 * what is allowed *without* asking; anything outside that still prompts.
 */
export type ExecutionModeMeta = {
  mode: PermissionMode;
  /** i18n key under `chat:permissionModes`. */
  labelKey: string;
  /** i18n key under `chat:executionModes`, one line on what it actually does. */
  descriptionKey: string;
  /** Tailwind classes for the chip when this gear is active. */
  chipClassName: string;
  /** Tailwind classes for the status dot. */
  dotClassName: string;
};

export const EXECUTION_MODES: ExecutionModeMeta[] = [
  {
    mode: 'default',
    labelKey: 'permissionModes.default',
    descriptionKey: 'executionModes.default',
    chipClassName: 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted',
    dotClassName: 'bg-muted-foreground',
  },
  {
    mode: 'plan',
    labelKey: 'permissionModes.plan',
    descriptionKey: 'executionModes.plan',
    chipClassName: 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10',
    dotClassName: 'bg-primary',
  },
  {
    mode: 'acceptEdits',
    labelKey: 'permissionModes.acceptEdits',
    descriptionKey: 'executionModes.acceptEdits',
    chipClassName:
      'border-green-300/60 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-600/40 dark:bg-green-900/15 dark:text-green-300 dark:hover:bg-green-900/25',
    dotClassName: 'bg-green-500',
  },
  {
    mode: 'auto',
    labelKey: 'permissionModes.auto',
    descriptionKey: 'executionModes.auto',
    chipClassName:
      'border-blue-300/60 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-600/40 dark:bg-blue-900/15 dark:text-blue-300 dark:hover:bg-blue-900/25',
    dotClassName: 'bg-blue-500',
  },
  {
    mode: 'bypassPermissions',
    labelKey: 'permissionModes.bypassPermissions',
    descriptionKey: 'executionModes.bypassPermissions',
    chipClassName:
      'border-orange-300/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25',
    dotClassName: 'bg-orange-500',
  },
];

const DEFAULT_META = EXECUTION_MODES[0];

/** Look up a gear's presentation. Unknown modes fall back to the default gear. */
export function executionModeMeta(mode: PermissionMode | string): ExecutionModeMeta {
  return EXECUTION_MODES.find((entry) => entry.mode === mode) ?? DEFAULT_META;
}

/**
 * The gears to offer, in a fixed order, filtered to what the provider supports.
 *
 * Ordered least- to most-permissive rather than in whatever order the provider
 * capabilities endpoint happens to return them, so the list reads as an
 * escalation and the dangerous end is always in the same place.
 */
export function orderedExecutionModes(available: readonly (PermissionMode | string)[]): ExecutionModeMeta[] {
  const supported = EXECUTION_MODES.filter((entry) => available.includes(entry.mode));
  return supported.length > 0 ? supported : [DEFAULT_META];
}
