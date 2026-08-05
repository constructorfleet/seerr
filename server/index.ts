import csurf from '@dr.pogodin/csurf';
import PlexAPI from '@server/api/plexapi';
import dataSource, { getRepository, isPgsql } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { startJobs } from '@server/job/schedule';
import {
  activateDiscoveredExtensions,
  discoverExtensionsForBoot,
} from '@server/lib/extensions/boot';
import { loadExtensionEnabledResolver } from '@server/lib/extensions/settings';
import notificationManager from '@server/lib/notifications';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import checkOverseerrMerge from '@server/lib/overseerrMerge';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import clearCookies from '@server/middleware/clearcookies';
import routes from '@server/routes';
import avatarproxy from '@server/routes/avatarproxy';
import { createExtensionRouter } from '@server/routes/extension';
import {
  SHARED_MODULE_BASE_PATH,
  createExtensionSharedRouter,
} from '@server/routes/extensionShared';
import imageproxy from '@server/routes/imageproxy';
import { setExtensionRegistry } from '@server/routes/settings/extensions';
import { appDataPermissions } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import createCustomProxyAgent, {
  setForceIpv4First,
} from '@server/utils/customProxyAgent';
import { initializeDnsCache } from '@server/utils/dnsCache';
import restartFlag from '@server/utils/restartFlag';
import { getClientIp } from '@supercharge/request-ip';
import { TypeormStore } from 'connect-typeorm/out';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import type { Store } from 'express-session';
import session from 'express-session';
import fs from 'fs/promises';
import yaml from 'js-yaml';
import next from 'next';
import path from 'path';
import swaggerUi from 'swagger-ui-express';

const API_SPEC_PATH = path.join(__dirname, '../seerr-api.yml');

logger.info(`Starting Seerr version ${getAppVersion()}`);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

if (!appDataPermissions()) {
  logger.error(
    'Something went wrong while checking config folder! Please ensure the config folder is set up properly.\nhttps://docs.seerr.dev/getting-started'
  );
}

app
  .prepare()
  .then(async () => {
    // Run Overseerr to Seerr migration
    await checkOverseerrMerge();

    // Extension discovery must precede `initialize()`: TypeORM builds entity
    // metadata during initialization and `entityMetadatas` is readonly
    // afterwards, so an extension entity injected later never gets a table.
    // Never throws — a broken extension is quarantined inside the registry.
    //
    // `isEnabled` reads `settings.json` directly rather than through
    // `getSettings()`, which is not loaded until further down.
    const extensions = await discoverExtensionsForBoot({
      dataSource,
      isEnabled: await loadExtensionEnabledResolver(),
    });

    const dbConnection = dataSource.isInitialized
      ? dataSource
      : await dataSource.initialize();

    // Run migrations in production
    if (process.env.NODE_ENV === 'production') {
      if (isPgsql) {
        await dbConnection.runMigrations();
      } else {
        await dbConnection.query('PRAGMA foreign_keys=OFF');
        await dbConnection.runMigrations();
        await dbConnection.query('PRAGMA foreign_keys=ON');
      }
    }

    // Load Settings
    const settings = await getSettings().load();
    restartFlag.initializeSettings(settings);

    initI18n();

    setForceIpv4First(settings.network.forceIpv4First);

    // Add DNS caching
    if (settings.network.dnsCache?.enabled) {
      initializeDnsCache({
        forceMinTtl: settings.network.dnsCache.forceMinTtl,
        forceMaxTtl: settings.network.dnsCache.forceMaxTtl,
      });
    }

    // Register HTTP proxy
    if (settings.network.proxy.enabled) {
      await createCustomProxyAgent(
        settings.network.proxy,
        settings.network.forceIpv4First
      );
    }

    // Migrate library types
    if (
      settings.plex.libraries.length > 1 &&
      !settings.plex.libraries[0].type
    ) {
      const userRepository = getRepository(User);
      const admin = await userRepository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });

      if (admin) {
        logger.info('Migrating Plex libraries to include media type', {
          label: 'Settings',
        });

        const plexapi = new PlexAPI({ plexToken: admin.plexToken });
        await plexapi.syncLibraries();
      }
    }

    // Register Notification Agents
    notificationManager.registerAgents([
      new DiscordAgent(),
      new EmailAgent(),
      new GotifyAgent(),
      new NtfyAgent(),
      new PushbulletAgent(),
      new PushoverAgent(),
      new SlackAgent(),
      new TelegramAgent(),
      new WebhookAgent(),
      new WebPushAgent(),
    ]);

    // Runs each extension's migrations and entry point, then wires what they
    // registered into permissions, the event bus and the job scheduler. After
    // `initialize()`, because the SDK hands out live repositories; after the
    // notification agents, because an extension may notify during setup. Never
    // throws: a failed extension is quarantined, never fatal.
    await activateDiscoveredExtensions(extensions, dbConnection);

    // Lets `/api/v1/settings/extensions` report what actually loaded, alongside
    // the persisted enable state. After activation, so the statuses it reads are
    // final.
    setExtensionRegistry(extensions);

    const userRepository = getRepository(User);
    const totalUsers = await userRepository.count();
    if (totalUsers > 0) {
      startJobs();
    } else {
      logger.info(
        `Skipping starting the scheduled jobs as we have no Plex/Jellyfin/Emby servers setup yet`,
        {
          label: 'Server',
        }
      );
    }

    // Bootstrap Discovery Sliders
    await DiscoverSlider.bootstrapSliders();

    const server = express();
    if (settings.network.trustProxy) {
      server.enable('trust proxy');
    }
    server.use(cookieParser());
    server.use(express.json());
    server.use(express.urlencoded({ extended: true }));
    server.use((req, _res, next) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(req, 'ip');
        if (descriptor?.writable === true) {
          Object.defineProperty(req, 'ip', {
            ...descriptor,
            value: getClientIp(req) ?? '',
          });
        }
      } catch (e) {
        logger.error('Failed to attach the ip to the request', {
          label: 'Middleware',
          message: (e as Error).message,
        });
      } finally {
        next();
      }
    });
    if (settings.network.csrfProtection) {
      server.use(
        csurf({
          cookie: {
            httpOnly: true,
            sameSite: true,
            secure: !dev,
            key: '_csrf',
            path: '/',
          },
        })
      );
      server.use((req, res, next) => {
        res.cookie('XSRF-TOKEN', req.csrfToken(), {
          sameSite: true,
          secure: !dev,
        });
        next();
      });
    }

    // Set up sessions
    const sessionRespository = getRepository(Session);
    server.use(
      '/api',
      session({
        secret: settings.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          maxAge: 1000 * 60 * 60 * 24 * 30,
          httpOnly: true,
          sameSite: settings.network.csrfProtection ? 'strict' : 'lax',
          secure: 'auto',
        },
        store: new TypeormStore({
          cleanupLimit: 2,
          ttl: 60 * 60 * 24 * 30,
        }).connect(sessionRespository) as Store,
      })
    );
    const apiSpecContent = await fs.readFile(API_SPEC_PATH, 'utf-8');
    const apiDocs = yaml.load(apiSpecContent) as Record<string, unknown>;
    server.use('/api-docs', swaggerUi.serve, swaggerUi.setup(apiDocs));

    /**
     * DO NOT MOVE THIS BELOW THE OpenApiValidator MIDDLEWARE.
     *
     * The validator is configured with `validateRequests: true` and no
     * `ignoreUndocumented`, so it rejects any path `seerr-api.yml` does not
     * document — verified against express-openapi-validator@5.6.2: the same
     * route returns 200 mounted before it and 404 mounted after. Extension paths
     * cannot be added to `seerr-api.yml`, because which extensions are installed
     * is not known until this boot discovered them a moment ago.
     *
     * Mounting an API router above the validator looks like an oversight, which
     * is exactly why this comment is here. See "Constraint 3" in
     * docs/specs/extension-system.md, and the regression test
     * "reaches an extension route that seerr-api.yml does not document" in
     * `server/routes/extension.test.ts`, which fails if this is reordered.
     *
     * The consequence is that extension routes get no request validation for
     * free: `createExtensionRouter` applies `checkUser`, the permission check and
     * the route's own zod body schema itself, since none of the middleware below
     * runs for them.
     */
    server.use('/api/v1/ext', createExtensionRouter(extensions));

    /**
     * DO NOT MOVE THIS BELOW THE OpenApiValidator MIDDLEWARE either, for the
     * same reason as the line above.
     *
     * These are the ESM shims that let a runtime-loaded panel's bare
     * `import 'react'` reach the host's own React instance. They are
     * deliberately *not* behind `checkUser`: the browser resolves an import map
     * with no credentials guarantee, and the shims are static re-export stubs
     * holding nothing secret. See `server/routes/extensionShared.ts`.
     */
    server.use(SHARED_MODULE_BASE_PATH, createExtensionSharedRouter());

    server.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
      })
    );
    /**
     * This is a workaround to convert dates to strings before they are validated by
     * OpenAPI validator. Otherwise, they are treated as objects instead of strings
     * and response validation will fail
     */
    server.use((_req, res, next) => {
      const original = res.json;
      res.json = function jsonp(json) {
        return original.call(this, JSON.parse(JSON.stringify(json)));
      };
      next();
    });
    server.use('/api/v1', routes);

    // Do not set cookies so CDNs can cache them
    server.use('/imageproxy', clearCookies, imageproxy);
    server.use('/avatarproxy', clearCookies, avatarproxy);

    server.get('*path', (req, res) => handle(req, res));
    server.use(
      (
        err: { status: number; message: string; errors: string[] },
        _req: Request,
        res: Response,
        // We must provide a next function for the function signature here even though its not used
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: NextFunction
      ) => {
        // format error
        res.status(err.status || 500).json({
          message: err.message,
          errors: err.errors,
        });
      }
    );

    const port = Number(process.env.PORT) || 5055;
    const host = process.env.HOST;
    let httpServer;
    if (host) {
      httpServer = server.listen(port, host, () => {
        logger.info(`Server ready on ${host} port ${port}`, {
          label: 'Server',
        });
      });
    } else {
      httpServer = server.listen(port, () => {
        logger.info(`Server ready on port ${port}`, {
          label: 'Server',
        });
      });
    }
    httpServer.on('error', (err) => {
      logger.error('Failed to start server', {
        label: 'Server',
        message: err.message,
      });
      process.exit(1);
    });
  })
  .catch((err) => {
    logger.error(err.stack);
    process.exit(1);
  });
