/**
 * MCP servers Prism writes and removes on its own.
 *
 * Shared rather than duplicated because the two sides disagreed. The backend
 * registers `prism-browser` when the Browser tab is enabled; the settings UI
 * decided what was managed with `name.startsWith('cloudcli-')`, the pre-rename
 * spelling. So the server Prism manages rendered as an ordinary user entry,
 * with Edit and Delete buttons — and deleting it there left the Browser toggle
 * switched on with nothing behind it, which is the exact desync the read-only
 * treatment exists to prevent.
 *
 * A name a user typed is theirs to edit. Matching on the exact set rather than
 * on a `prism-` prefix keeps it that way: someone who names their own server
 * `prism-notes` still owns it.
 */

/** The name the browser-use MCP server is currently registered under. */
export const MANAGED_MCP_SERVER_NAME = 'prism-browser';

/**
 * Names it was registered under before. `registerAgentMcp()` removes each of
 * these before adding the current one, so an upgraded install ends up with a
 * single entry rather than several aimed at the same endpoint — but a config
 * written by an older build still carries one until that cleanup runs, and it
 * is no more user-owned than the current name.
 */
export const LEGACY_MANAGED_MCP_SERVER_NAMES = ['cloudcli-browser-use', 'cloudcli-browser'];

const MANAGED_NAMES = new Set([MANAGED_MCP_SERVER_NAME, ...LEGACY_MANAGED_MCP_SERVER_NAMES]);

/**
 * Whether Prism owns this MCP server entry, as opposed to the user.
 *
 * @param {string | undefined | null} name
 * @returns {boolean}
 */
export function isManagedMcpServerName(name) {
  return typeof name === 'string' && MANAGED_NAMES.has(name);
}
