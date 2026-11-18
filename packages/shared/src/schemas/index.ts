import { z } from 'zod';
import { PROTOCOL_VERSION } from '../types/index.js';

export const EventCategorySchema = z.enum(['critical', 'telemetry']);

export const EventEnvelopeSchema = z.object({
  protocolVersion: z.string().default(PROTOCOL_VERSION),
  eventId: z.string().uuid(),
  eventType: z.string().min(1).max(128),
  category: EventCategorySchema.default('critical'),
  matchId: z.string().min(1).max(128),
  roomId: z.string().min(1).max(128),
  playerId: z.string().min(1).max(128),
  clientInstanceId: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
  clientTimestamp: z.number().int().nonnegative(),
  isOfflineReplay: z.boolean().optional().default(false),
  payload: z.record(z.unknown()),
});

export const ClientRegisterSchema = z.object({
  clientInstanceId: z.string().min(1).max(128),
  sdkVersion: z.string().min(1).max(32).optional().default('2.0.0'),
  modeId: z.string().min(1).max(64).optional(),
});

export const ClientHeartbeatSchema = z.object({
  t0: z.number().nonnegative(),
});

export const PlayerJoinSchema = z.object({
  playerId: z.string().min(1).max(128).optional(),
  displayName: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(128).nullable().optional(),
  teamId: z.string().min(1).max(64).nullable().optional(),
});

export const PlayerLeaveSchema = z.object({
  playerId: z.string().min(1).max(128),
});

export const PlayerReadySchema = z.object({
  playerId: z.string().min(1).max(128),
  ready: z.boolean(),
});

export const DeviceStatusSchema = z.object({
  deviceId: z.string().min(1).max(128),
  deviceType: z.string().min(1).max(64).default('BLE_ROPE'),
  connectionStatus: z.enum(['CONNECTED', 'DISCONNECTED', 'UNKNOWN']),
  assignedPlayerId: z.string().min(1).max(128).nullable().optional(),
  lastDataTimestamp: z.number().nonnegative().optional(),
});

export const RoomCreateSchema = z.object({
  gameModeId: z.string().min(1).max(64),
  maxPlayers: z.number().int().min(1).max(64).optional(),
  config: z.record(z.unknown()).optional(),
  playerIds: z.array(z.string().min(1).max(128)).optional(),
});

export const RoomJoinSchema = z.object({
  roomCodeOrId: z.string().min(1).max(64),
  asSpectator: z.boolean().optional().default(false),
  playerIds: z.array(z.string().min(1).max(128)).optional(),
});

export const RoomLeaveSchema = z.object({
  roomId: z.string().min(1).max(128).optional(),
});

export const RoomResetSchema = z.object({
  roomId: z.string().min(1).max(128),
  gameModeId: z.string().min(1).max(64).optional(),
  config: z.record(z.unknown()).optional(),
});

export const MatchRequestStartSchema = z.object({
  roomId: z.string().min(1).max(128),
  countdownMs: z.number().int().min(0).max(15000).optional(),
});

export const GameStateRequestSchema = z.object({
  roomId: z.string().min(1).max(128).optional(),
  matchId: z.string().min(1).max(128).optional(),
});

// Mode-specific event payloads
export const MultiplayerTickPayloadSchema = z.object({
  totalJumps: z.number().int().nonnegative(),
  deltaJumps: z.number().int().nonnegative().optional(),
  rpm: z.number().nonnegative().max(600),
  energy: z.number().nonnegative().optional().default(0),
});

export const BombJumpPayloadSchema = z.object({
  deltaJumps: z.number().int().positive().max(100),
  rpm: z.number().nonnegative().max(600).optional().default(0),
});

export const BombPassPayloadSchema = z.object({
  targetPlayerId: z.string().min(1).max(128).optional(),
});
