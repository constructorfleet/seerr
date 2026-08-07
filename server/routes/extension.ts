import { containedPath } from '@server/lib/extensions/paths';
import type {
  ExtensionPanel,
  ExtensionRegistry,
  ExtensionRoute,
} from '@server/lib/extensions/registry';
import { EXTENSION_ROUTE_OPEN } from '@server/lib/extensions/types';
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
    const panels = registry.panelsFor(entry.id);

    // Deliberately not `if (!routes.length) continue`: an extension that
    // provides only panels registers no routes, and still needs its bundles
    // served.
    if (!routes.length && !panels.length) {
      continue;
    }

    const extensionRouter = Router();

    // Before the extension's own routes, so `/ui` is reserved: an extension
    // cannot shadow its own panel bundles with a route of that name.
    if (panels.length) {
      extensionRouter.use('/ui', createPanelRouter(entry.id, panels));
    }

    extensionRouter.use(createRouterFor(entry.id, routes));

    router.use(`/${entry.id}`, extensionRouter);
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

/**
 * Serves each declared panel's pre-built ESM bundle at `/ui/<slug>.mjs`.
 *
 * Bundles are addressed by **slug**, never by the path a request supplies. The
 * slug indexes into what the manifest declared, and the file path comes from
 * that declaration — so a request cannot name a file at all, and path traversal
 * is not a case to filter but a shape that cannot be expressed. The other files
 * an extension ships are likewise unreachable, which matters because an
 * extension directory holds its server code and its `node_modules`.
 *
 * The entry path is still re-checked against the extension directory: the
 * manifest schema rejects `..` at parse time, but this route should not be
 * relying on that as its only defense against an arbitrary file read.
 *
 * That re-check is `realpath`-based and happens per request rather than once at
 * mount time, because the string arithmetic it replaced could not see a symlink,
 * and because a bundle may be replaced on disk after boot — a reinstall does
 * exactly that. The file served is the resolved path the check returned, so no
 * symlink can be swapped in between checking and reading.
 */
function createPanelRouter(
  extensionId: string,
  panels: ExtensionPanel[]
): Router {
  const router = Router();

  for (const panel of panels) {
    // A panel's bundle is gated by the same permission as the panel itself. With
    // no declared permission this still requires a signed-in user, since
    // `checkUser` only populates `req.user` and never rejects.
    router.get(
      `/${panel.slug}.mjs`,
      isExtensionAuthenticated({
        extensionId,
        ...(panel.permission ? { permission: panel.permission } : {}),
      }),
      async (_req, res) => {
        const resolved = await containedPath({
          target: panel.entryPath,
          root: panel.directory,
          extensionId,
          what: `the "${panel.slug}" panel bundle`,
        });

        if (!resolved) {
          res.status(404).json({ status: 404, error: 'Not found' });
          return;
        }

        res.type('application/javascript; charset=utf-8');
        res.sendFile(resolved, (e) => {
          if (!e || res.headersSent) {
            return;
          }

          // A declared entry missing from disk is a broken install rather than a
          // bad request, so it is logged — but answered as a 404 like any other
          // unavailable bundle.
          logger.error('Panel bundle could not be served', {
            label: 'Extensions',
            extensionId,
            slug: panel.slug,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          res.status(404).json({ status: 404, error: 'Not found' });
        });
      }
    );
  }

  router.use((_req, res) => {
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

  // Fail closed. `permission` is required by the SDK type, but an extension is
  // plain JavaScript at runtime and may have been built against an older SDK, so
  // an absent gate is refused here rather than trusted to the type system. Only
  // the explicit sentinel opens a route to every signed-in user.
  if (!route.options?.permission) {
    logger.error(
      'Refusing to mount an extension route with no declared permission',
      {
        label: 'Extensions',
        extensionId,
        method: route.method,
        path: route.path,
        hint: `Pass a permission key, or "${EXTENSION_ROUTE_OPEN}" for a route any signed-in user may reach.`,
      }
    );
    return;
  }

  if (route.options.permission === EXTENSION_ROUTE_OPEN) {
    // `checkUser` populates `req.user` but never rejects, so an explicitly open
    // route still needs something that turns an anonymous request into a 403.
    handlers.push(isExtensionAuthenticated({ extensionId }));
  } else {
    handlers.push(
      isExtensionAuthenticated({
        permission: route.options.permission,
        extensionId,
      })
    );
  }

  for (const part of ['body', 'params', 'query'] as const) {
    if (route.options[part]) {
      handlers.push(validatePart(extensionId, route, part));
    }
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
 * Validates one part of the request against the route's schema, replacing it with
 * the parsed output so a handler sees coerced values and applied defaults.
 *
 * `query` and `params` matter as much as `body` here: these routes never reach the
 * OpenAPI validator, so a `GET` route — which has no body to declare a schema for
 * — otherwise has no supported way to validate its input at all.
 */
function validatePart(
  extensionId: string,
  route: ExtensionRoute,
  part: 'body' | 'params' | 'query'
): Middleware {
  const schema = route.options[part];

  return (req, res, next) => {
    if (!schema) {
      return next();
    }

    const result = schema.safeParse(req[part]);

    if (!result.success) {
      logger.debug('Extension route input validation failed', {
        label: 'Extensions',
        extensionId,
        method: route.method,
        path: route.path,
        part,
      });

      res.status(400).json({
        status: 400,
        message: `Request ${part} validation failed`,
        errors: issuesOf(result.error),
      });
      return;
    }

    // `defineProperty` rather than assignment: Express 5 exposes `query` as a
    // getter-only prototype property, so `req.query = ...` throws.
    Object.defineProperty(req, part, {
      value: result.data,
      configurable: true,
      enumerable: true,
      writable: true,
    });

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
