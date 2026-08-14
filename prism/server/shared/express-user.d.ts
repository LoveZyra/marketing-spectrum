import type { Viewer } from './types.js';

/**
 * Teaches TypeScript that `authenticateToken` puts a user on the request.
 *
 * Without this every route that needs the caller writes
 * `(req as Request & { user?: { id?: number; username?: string } }).user`, and
 * each one invents its own shape — which is how one of them ended up reading
 * nothing at all. One declaration, and `req.user` is typed everywhere.
 *
 * Optional on purpose: routes mounted before the auth middleware, and the
 * platform-mode paths, genuinely have no user. Making it required would push
 * every call site into a non-null assertion, which is the same hole with more
 * ceremony.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id?: Viewer['userId'];
        username?: string;
        isRoot?: boolean;
      };
    }
  }
}

export {};
