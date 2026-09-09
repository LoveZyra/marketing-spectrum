import { safeJsonParse } from '../../../lib/utils.js';
import type { PermissionGrantResult } from '../types/types.js';

import { CLAUDE_SETTINGS_KEY, getClaudeSettings, safeLocalStorage } from './chatStorage';

export function buildClaudeToolPermissionEntry(toolName?: string, toolInput?: unknown) {
  if (!toolName) return null;
  if (toolName !== 'Bash') return toolName;

  const parsed = safeJsonParse(toolInput);
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  if (!command) return toolName;

  /**
   * fj:只按**第一段**子命令生成条目。
   *
   * 服务端现在要求每一段都命中前缀(见 claude-sdk 的 `matchesToolPermission`),
   * 所以从 `git status; rm -rf x` 生成 `Bash(git status:*)` 是对的 —— 下次再来
   * 一条带 `rm` 的复合命令,它那一段不命中,确认框照样弹。
   *
   * 反过来,如果这里按整串生成,条目会长成 `Bash(git:*)` 之类过宽的形状,
   * 用户以为自己只批准了一条命令。
   */
  const firstSegment = command.split(/[;&|\n]/)[0]?.trim() || command;
  const tokens = firstSegment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return toolName;

  if (tokens[0] === 'git' && tokens[1]) {
    return `Bash(${tokens[0]} ${tokens[1]}:*)`;
  }
  return `Bash(${tokens[0]}:*)`;
}

export function formatToolInputForDisplay(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function grantClaudeToolPermission(entry: string | null): PermissionGrantResult {
  if (!entry) return { success: false };

  const settings = getClaudeSettings();
  const alreadyAllowed = settings.allowedTools.includes(entry);
  const nextAllowed = alreadyAllowed ? settings.allowedTools : [...settings.allowedTools, entry];
  const nextDisallowed = settings.disallowedTools.filter((tool) => tool !== entry);
  const updatedSettings = {
    ...settings,
    allowedTools: nextAllowed,
    disallowedTools: nextDisallowed,
    lastUpdated: new Date().toISOString(),
  };

  safeLocalStorage.setItem(CLAUDE_SETTINGS_KEY, JSON.stringify(updatedSettings));
  return { success: true, alreadyAllowed, updatedSettings };
}
