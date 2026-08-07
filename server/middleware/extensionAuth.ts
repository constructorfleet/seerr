import type { ExtensionPermissionRequest } from '@server/lib/extensions/permissions';
import { hasExtensionPermission } from '@server/lib/extensions/permissions';
import type { Permission } from '@server/lib/permissions';

export interface ExtensionAuthOptions {
  /**
   * An extension permission — namespaced `<extensionId>:<key>`, or a bare key
   * when `extensionId` is given — or the name of a core `Permission`. This is
   * what an extension writes in its route options, where a number would be
   * indistinguishable from a bitmask.
   */
  permission?: string | string[];
  /** A core `Permission`, for callers that already have the enum in scope. */
  core?: Permission | Permission[];
  /** Namespaces a bare `permission` key. */
  extensionId?: string;
  /**
   * Whether every requirement must hold (`'and'`, the default) or any one of
   * them (`'or'`). Applies across `permission` and `core` together.
   */
  type?: 'and' | 'or';
}

/**
 * `isAuthenticated` for extension routes.
 *
 * Same contract as `server/middleware/auth.ts`: 403 with `{ status, error }` when
 * the user is absent or unauthorized, `next()` otherwise. The difference is that
 * resolution is asynchronous — extension permissions are rows, not bits on
 * `req.user` — so the check cannot reuse `req.user.hasPermission`.
 *
 * `createExtensionRouter` mounts this in front of each registered extension
 * route.
 */
export const isExtensionAuthenticated = (
  options: ExtensionAuthOptions = {}
): Middleware => {
  const requested: ExtensionPermissionRequest[] = [
    ...toArray<string>(options.permission),
    ...toArray<Permission>(options.core),
  ];

  const authMiddleware: Middleware = async (req, res, next) => {
    if (!req.user) {
      return forbid(res);
    }

    const allowed = await hasExtensionPermission(req.user.id, requested, {
      type: options.type ?? 'and',
      ...(options.extensionId ? { extensionId: options.extensionId } : {}),
    });

    if (!allowed) {
      return forbid(res);
    }

    next();
  };

  return authMiddleware;
};

function forbid(res: Parameters<Middleware>[1]): void {
  res.status(403).json({
    status: 403,
    error: 'You do not have permission to access this endpoint',
  });
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}
