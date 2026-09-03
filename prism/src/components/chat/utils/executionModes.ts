import { FilePenLine, ListChecks, ShieldCheck, ShieldOff, WandSparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
  /**
   * ee:每档一个图标,替掉芯片上的色点 —— 底栏最窄时芯片只剩图标,色点分不清
   * 五档,图标能。与「默认」的盾形成一对的是「无限制」的划掉的盾。
   */
  Icon: LucideIcon;
  /** 图标颜色(与 dotClassName 同一套语义:默认灰、有授权绿、无限制前景色)。 */
  iconClassName: string;
};

/**
 * 设计语言:单一绿色强调,权限档不再一档一色。区分交给文字标签与点的形态:
 * default = 弱化灰点;plan/acceptEdits/auto = 绿点(有授权在身);
 * bypassPermissions = 前景色实点 + 描边加重(最高权限,视觉上最"重")。
 */
export const EXECUTION_MODES: ExecutionModeMeta[] = [
  {
    mode: 'default',
    labelKey: 'permissionModes.default',
    descriptionKey: 'executionModes.default',
    chipClassName: 'border-border text-card-foreground hover:border-border-strong',
    dotClassName: 'bg-muted-foreground',
    Icon: ShieldCheck,
    iconClassName: 'text-muted-foreground',
  },
  {
    mode: 'plan',
    labelKey: 'permissionModes.plan',
    descriptionKey: 'executionModes.plan',
    chipClassName: 'border-primary/30 text-foreground hover:bg-primary/8 dark:text-primary',
    dotClassName: 'bg-primary',
    Icon: ListChecks,
    iconClassName: 'text-primary',
  },
  {
    mode: 'acceptEdits',
    labelKey: 'permissionModes.acceptEdits',
    descriptionKey: 'executionModes.acceptEdits',
    chipClassName: 'border-primary/30 text-foreground hover:bg-primary/8 dark:text-primary',
    dotClassName: 'bg-primary',
    Icon: FilePenLine,
    iconClassName: 'text-primary',
  },
  {
    mode: 'auto',
    labelKey: 'permissionModes.auto',
    descriptionKey: 'executionModes.auto',
    chipClassName: 'border-primary/30 text-foreground hover:bg-primary/8 dark:text-primary',
    dotClassName: 'bg-primary',
    Icon: WandSparkles,
    iconClassName: 'text-primary',
  },
  {
    mode: 'bypassPermissions',
    labelKey: 'permissionModes.bypassPermissions',
    descriptionKey: 'executionModes.bypassPermissions',
    chipClassName: 'border-border-strong font-semibold text-foreground hover:bg-card',
    dotClassName: 'bg-foreground',
    Icon: ShieldOff,
    iconClassName: 'text-foreground',
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
