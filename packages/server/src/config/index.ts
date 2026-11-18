import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresInSeconds: number;
  maxLocalPlayersPerClient: number;
  disconnectGracePeriodMs: number;
  corsOrigin: string;
  scoreBroadcastIntervalMs: number;
  snapshotIntervalMs: number;
  eventFlushIntervalMs: number;
  matchTickIntervalMs: number;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 3100),
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://edusports:edusports_pass@127.0.0.1:5432/edusports',
    jwtSecret: process.env.JWT_SECRET ?? 'edusports-phase1-dev-secret-key-2026',
    jwtExpiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 7200),
    maxLocalPlayersPerClient: Number(
      process.env.MAX_LOCAL_PLAYERS_PER_CLIENT ?? 6,
    ),
    disconnectGracePeriodMs: Number(
      process.env.DISCONNECT_GRACE_PERIOD_MS ?? 30000,
    ),
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
    scoreBroadcastIntervalMs: 250,
    snapshotIntervalMs: 5000,
    eventFlushIntervalMs: 500,
    matchTickIntervalMs: 100,
    ...overrides,
  };
}
