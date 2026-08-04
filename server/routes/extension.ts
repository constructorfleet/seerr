import type {
  ExtensionRegistry,
  ExtensionRoute,
} from '@server/lib/extensions/registry';
import logger from '@server/logger';
import { checkUser } from '@server/middleware/auth';
import { isExtensionAuthenticated } from '@server/middleware/extensionAuth';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { ZodError } from 'zod';

/**
 * Materializes the routes the loaded extensions registered, one sub-router per
 * extension mounted at its own id.
 *
 * The result is mounted at `/api/v1/ext` **ahead of the OpenAPI validator** —
 * see the comment at its mount site in `server/index.ts`, and Constraint 3 in
 * docs/specs/extension-system.md. Three consequences follow from that position
 * and are handled here rather than downstream:
 *
 * - `checkUser` is applied here. `server/routes/index.ts` applies it under
 *   `/api/v1`, which is mounted *after* the validator, so an extension route
 *   would otherwise see no `req.user` for `isExtensionAuthenticated` to check.
 * - Bodies are validated against the route's zod schema, because the validator
 *   never sees these paths and so validates nothing about them.
 * - Errors are answered here. The error middleware at the end of
 *   `server/index.ts` reports `err.message` verbatim, which for an arbitrary
 *   extension throw is neither safe to expose nor useful to a client.
 *
 * Only `active` extensions contribute: a quarantined one has no registrations to
 * mount, and requests to its namespace 404 like any other unknown extension.
 */
export function createExtensionRouter(registry: ExtensionRegistry): Router {
  const router = Router();

  router.use(checkUser);

  for (const entry of registry.active()) {
    const routes = registry.routesFor(entry.id);

    if (!routes.length) {
      continue;
    }

    router.use(`/${entry.id}`, createRouterFor(entry.id, routes));
  }

  // An unknown extension id, a disabled or quarantined one, and a path its
  // routes do not cover all land here. Answered explicitly because nothing
  // downstream of this mount point would: `/api/v1/ext/...` reaches the Next.js
  // catch-all otherwise and gets an HTML 404 in reply to an API call.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 404, error: 'Not found' });
  });

  return router;
}

function createRouterFor(
  extensionId: string,
  routes: ExtensionRoute[]
): Router {
  const router = Router();

  for (const route of routes) {
    mountRoute(router, extensionId, route);
  }

  return router;
}

function mountRoute(
  router: Router,
  extensionId: string,
  route: ExtensionRoute
): void {
  const routePath = normalizePath(route.path);

  if (routePath === undefined) {
    logger.warn('Skipping an extension route with an unusable path', {
      label: 'Extensions',
      extensionId,
      method: route.method,
      path: route.path,
    });
    return;
  }

  const handlers: ((
    req: Request,
    res: Response,
    next: NextFunction
  ) => unknown)[] = [];

  if (route.options.permission) {
    handlers.push(
      isExtensionAuthenticated({
        permission: route.options.permission,
        extensionId,
      })
    );
  }

  if (route.options.body) {
    handlers.push(validateBody(extensionId, route));
  }

  handlers.push(runHandler(extensionId, route));

  try {
    router[route.method](routePath, ...handlers);
  } catch (e) {
    // path-to-regexp rejects some path strings outright (a bare `*`, an
    // unbalanced group). One such route must not take down the extension's other
    // routes, and certainly not the boot that is mounting them.
    logger.error('Extension route could not be mounted', {
      label: 'Extensions',
      extensionId,
      method: route.method,
      path: route.path,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Validates `req.body` against the route's schema, replacing it with the parsed
 * output so a handler sees coerced values and applied defaults.
 */
function validateBody(extensionId: string, route: ExtensionRoute): Middleware {
  const schema = route.options.body;

  return (req, res, next) => {
    if (!schema) {
      return next();
    }

    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        status: 400,
        message: 'Request body validation failed',
        errors: issuesOf(result.error),
      });
      return;
    }

    req.body = result.data;
    next();
  };
}

/**
 * Runs an extension's handler with its failures contained.
 *
 * `void`-returning and promise-returning handlers are both supported, and both
 * kinds of failure become a 500: Express 5 forwards a rejected handler to the
 * error middleware, but the extension router sits ahead of the validator and
 * answers for itself (see {@link createExtensionRouter}), so the rejection is
 * caught here instead.
 */
function runHandler(extensionId: string, route: ExtensionRoute): Middleware {
  return async (req, res) => {
    try {
      await route.handler(req, res);
    } catch (e) {
      logger.error('Extension route handler failed', {
        label: 'Extensions',
        extensionId,
        method: route.method,
        path: route.path,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      // A handler that responded and *then* threw has already said something
      // useful; overwriting it would fail on sent headers anyway.
      if (!res.headersSent) {
        res.status(500).json({ status: 500, error: 'Something went wrong' });
      }
    }
  };
}

/**
 * The route path as Express should see it: leading slash added, `..` refused.
 *
 * A sub-router cannot match outside its own mount path, so `..` cannot actually
 * cross into another extension's namespace — it is refused because a path
 * containing it can only be a mistake, and one that looks like an escape attempt
 * is worth a log line rather than a silently dead route.
 */
function normalizePath(routePath: string): string | undefined {
  const withSlash = routePath.startsWith('/') ? routePath : `/${routePath}`;

  if (withSlash.split('/').includes('..')) {
    return undefined;
  }

  return withSlash;
}

function issuesOf(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
