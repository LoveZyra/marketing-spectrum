/**
 * Platform mode (VITE_IS_PLATFORM=true): an external proxy in front of Prism
 * handles authentication, so the client skips its own login and token headers.
 */
export const IS_PLATFORM = import.meta.env.VITE_IS_PLATFORM === 'true';

/**
 * Placeholder project for shells opened without a real project (e.g. the
 * provider login modal), so the shell still has the project fields it needs.
 *
 * `projectId` is the sentinel 'default' because it matches no project row in
 * the database; any API call routed through this placeholder must tolerate a
 * missing match.
 */
export const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: IS_PLATFORM ? '/workspace' : '',
  path: IS_PLATFORM ? '/workspace' : '',
};