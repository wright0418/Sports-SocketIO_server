import express, { type Express } from 'express';
import cors from 'cors';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ErrorCode } from '@edusports/shared';
import type { ServerConfig } from '../config/index.js';
import { issueSessionToken } from '../auth/jwt.js';
import type { PersistenceService } from '../db/persistence.js';
import type { GameModeRegistry } from '../modes/registry.js';
import type { RoomManager } from '../managers/RoomManager.js';
import type { MatchManager } from '../managers/MatchManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AuthSessionBodySchema = z.object({
  clientInstanceId: z.string().min(1).max(128).optional(),
  allowedModeIds: z.array(z.string().min(1).max(64)).optional(),
  modeId: z.string().min(1).max(64).optional(),
});

export function createHttpApp(deps: {
  config: ServerConfig;
  modeRegistry: GameModeRegistry;
  roomManager: RoomManager;
  matchManager: MatchManager;
  persistence: PersistenceService;
}): Express {
  const app = express();

  app.use(
    cors({
      origin: deps.config.corsOrigin === '*' ? true : deps.config.corsOrigin.split(','),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'healthy',
      serverNow: Date.now(),
      maxLocalPlayersPerClient: deps.config.maxLocalPlayersPerClient,
    });
  });

  router.post('/api/auth/session', (req, res) => {
    const parsed = AuthSessionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: {
          code: ErrorCode.INVALID_PAYLOAD,
          message: 'Invalid auth session request body',
          details: parsed.error.flatten(),
        },
      });
      return;
    }

    const clientInstanceId =
      parsed.data.clientInstanceId ?? `client-${randomUUID().slice(0, 12)}`;
    const allowedModeIds =
      parsed.data.allowedModeIds ??
      (parsed.data.modeId ? [parsed.data.modeId] : ['*']);
    const origin =
      typeof req.headers.origin === 'string' ? req.headers.origin : '*';

    const issued = issueSessionToken(
      deps.config.jwtSecret,
      deps.config.jwtExpiresInSeconds,
      {
        clientInstanceId,
        allowedModeIds,
        origin,
      },
    );

    res.json({
      ok: true,
      clientInstanceId,
      token: issued.token,
      expiresAt: issued.expiresAt,
      maxLocalPlayers: deps.config.maxLocalPlayersPerClient,
      serverNow: Date.now(),
    });
  });

  router.get('/api/modes', (_req, res) => {
    res.json({
      ok: true,
      modes: deps.modeRegistry.listMetadata(),
    });
  });

  router.get('/api/rooms', (_req, res) => {
    res.json({
      ok: true,
      rooms: deps.roomManager.listPublicRooms(),
    });
  });

  router.get('/api/rooms/:codeOrId', (req, res) => {
    const room = deps.roomManager.getRoom(req.params.codeOrId);
    if (!room) {
      res.status(404).json({
        ok: false,
        error: {
          code: ErrorCode.ROOM_NOT_FOUND,
          message: `Room "${req.params.codeOrId}" not found`,
        },
      });
      return;
    }
    res.json({
      ok: true,
      room: deps.roomManager.toSnapshot(room),
    });
  });

  router.get('/api/matches/:matchId', async (req, res) => {
    const inMem = deps.matchManager.getFinishedResult(req.params.matchId);
    if (inMem) {
      res.json({ ok: true, result: inMem });
      return;
    }

    try {
      const record = await deps.persistence.getMatchRecord(req.params.matchId);
      if (!record) {
        res.status(404).json({
          ok: false,
          error: {
            code: ErrorCode.MATCH_NOT_FOUND,
            message: `Match "${req.params.matchId}" not found`,
          },
        });
        return;
      }
      res.json({ ok: true, record });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : 'Database query failed',
        },
      });
    }
  });

  // Static hosting for SDK bundle and test-client HTML game (supports root and sub-path hosting)
  const sdkDistDir = path.resolve(__dirname, '../../../sdk/dist');
  const testClientDir = path.resolve(__dirname, '../../../test-client');
  router.use('/sdk', express.static(sdkDistDir));
  router.use('/test-client/sdk', express.static(sdkDistDir));
  router.use('/test-client', express.static(testClientDir));
  router.use('/', express.static(testClientDir));

  // Support both Caddy handle_path (stripped) and handle (unstripped) subpath forwarding
  app.use('/games-server', (req, res, next) => {
    if (req.originalUrl === '/games-server') {
      res.redirect(301, '/games-server/');
      return;
    }
    next();
  }, router);

  app.use('/sports-server', (req, res, next) => {
    if (req.originalUrl === '/sports-server') {
      res.redirect(301, '/sports-server/');
      return;
    }
    next();
  }, router);

  app.use('/', router);

  return app;
}
