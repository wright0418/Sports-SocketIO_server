import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { loadConfig, type ServerConfig } from './config/index.js';
import { createDbConnection, type DbConnection } from './db/index.js';
import { ensureDatabaseSchema } from './db/migrate.js';
import { PersistenceService } from './db/persistence.js';
import { createHttpApp } from './http/routes.js';
import { GameEventManager } from './managers/GameEventManager.js';
import { MatchManager } from './managers/MatchManager.js';
import { PlayerManager } from './managers/PlayerManager.js';
import { RoomManager } from './managers/RoomManager.js';
import { TeamManager } from './managers/TeamManager.js';
import { GameModeRegistry } from './modes/registry.js';
import { attachSocketGateway } from './socket/gateway.js';

export interface PlatformServer {
  config: ServerConfig;
  httpServer: http.Server;
  io: SocketIOServer;
  db: DbConnection;
  persistence: PersistenceService;
  modeRegistry: GameModeRegistry;
  playerManager: PlayerManager;
  roomManager: RoomManager;
  matchManager: MatchManager;
  start: () => Promise<number>;
  stop: () => Promise<void>;
}

export function createPlatformServer(
  overrides: Partial<ServerConfig> = {},
): PlatformServer {
  const config = loadConfig(overrides);
  const db = createDbConnection(config.databaseUrl);
  const persistence = new PersistenceService(db.db, config.eventFlushIntervalMs);
  const modeRegistry = new GameModeRegistry();
  const teamManager = new TeamManager();
  const playerManager = new PlayerManager(
    config.maxLocalPlayersPerClient,
    config.disconnectGracePeriodMs,
    persistence,
  );
  const roomManager = new RoomManager(
    modeRegistry,
    playerManager,
    teamManager,
    persistence,
  );

  const expressApp = createHttpApp({
    config,
    modeRegistry,
    roomManager,
    // matchManager will be bound right below via getter closure or object reference
    get matchManager() {
      return matchManager;
    },
    persistence,
  } as Parameters<typeof createHttpApp>[0]);

  const httpServer = http.createServer(expressApp);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
      credentials: true,
    },
  });

  const eventManager = new GameEventManager(playerManager, persistence);
  const matchManager = new MatchManager(
    io,
    roomManager,
    modeRegistry,
    eventManager,
    persistence,
    {
      tickIntervalMs: config.matchTickIntervalMs,
      scoreBroadcastIntervalMs: config.scoreBroadcastIntervalMs,
      snapshotIntervalMs: config.snapshotIntervalMs,
    },
  );

  attachSocketGateway({
    io,
    config,
    playerManager,
    roomManager,
    matchManager,
  });

  const start = async (): Promise<number> => {
    await ensureDatabaseSchema(db.pool);
    await persistence.seedGameModes(modeRegistry.listMetadata());
    persistence.start();
    matchManager.startTickLoop();

    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, () => resolve());
    });
    const addr = httpServer.address();
    return typeof addr === 'object' && addr ? addr.port : config.port;
  };

  const stop = async (): Promise<void> => {
    matchManager.stopTickLoop();
    playerManager.clearAllTimers();
    await persistence.stop();
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    await db.close();
  };

  return {
    config,
    httpServer,
    io,
    db,
    persistence,
    modeRegistry,
    playerManager,
    roomManager,
    matchManager,
    start,
    stop,
  };
}
