export const PROTOCOL_VERSION = '1.0' as const;

export const RoomState = {
  WAITING: 'WAITING',
  READY: 'READY',
  STARTING: 'STARTING',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
  CLOSED: 'CLOSED',
} as const;

export type RoomStateType = (typeof RoomState)[keyof typeof RoomState];

export const MatchState = {
  CREATED: 'CREATED',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
  ABORTED: 'ABORTED',
} as const;

export type MatchStateType = (typeof MatchState)[keyof typeof MatchState];

export const PlayerRole = {
  PLAYER: 'PLAYER',
  SPECTATOR: 'SPECTATOR',
} as const;

export type PlayerRoleType = (typeof PlayerRole)[keyof typeof PlayerRole];

export const ConnectionStatus = {
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
} as const;

export type ConnectionStatusType =
  (typeof ConnectionStatus)[keyof typeof ConnectionStatus];

export const DeviceConnectionStatus = {
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type DeviceConnectionStatusType =
  (typeof DeviceConnectionStatus)[keyof typeof DeviceConnectionStatus];

export type OfflineEventPolicy = 'ALLOW_WITH_RATE_LIMIT' | 'REJECT_ALL';

export type EventCategory = 'critical' | 'telemetry';

export interface GameModeMetadata {
  modeId: string;
  name: string;
  version: string;
  developerId: string;
  protocolVersion: string;
  minPlayers: number;
  maxPlayers: number;
  teamMode: 'individual' | 'team' | 'coop' | 'hybrid';
  requiredDevices: string[];
  supportedFeatures: string[];
  scoringType: string;
  defaultConfig: Record<string, unknown>;
  allowedOrigins: string[];
  clientEntryUrl?: string;
  offlineEventPolicy: OfflineEventPolicy;
}

export interface DeviceState {
  deviceId: string;
  deviceType: string;
  connectionStatus: DeviceConnectionStatusType;
  assignedPlayerId: string | null;
  localClientId: string;
  lastDataTimestamp: number;
}

export interface PlayerState {
  playerId: string;
  clientInstanceId: string;
  displayName: string;
  role: PlayerRoleType;
  teamId: string | null;
  deviceId: string | null;
  ready: boolean;
  connectionStatus: ConnectionStatusType;
  disconnectedAt: number | null;
  joinedAt: number;
}

export interface TeamState {
  teamId: string;
  name: string;
  playerIds: string[];
  score: number;
}

export interface RoomSnapshot {
  roomId: string;
  roomCode: string;
  gameModeId: string;
  ownerClientInstanceId: string;
  ownerPlayerId: string | null;
  status: RoomStateType;
  maxPlayers: number;
  players: PlayerState[];
  teams: TeamState[];
  activeMatchId: string | null;
  config: Record<string, unknown>;
  createdAt: number;
}

export interface PlayerScoreEntry {
  playerId: string;
  displayName: string;
  teamId: string | null;
  score: number;
  jumpCount: number;
  rpm: number;
  energy: number;
  rank: number;
  eliminated?: boolean;
}

export interface MatchSnapshot {
  matchId: string;
  roomId: string;
  gameModeId: string;
  status: MatchStateType;
  stateVersion: number;
  serverNow: number;
  countdownEndsAt: number | null;
  startedAt: number | null;
  endsAt: number | null;
  scores: PlayerScoreEntry[];
  teams: TeamState[];
  modeState: Record<string, unknown>;
}

export interface ParticipantResult {
  playerId: string;
  displayName: string;
  teamId: string | null;
  finalScore: number;
  jumpCount: number;
  rank: number;
  outcome: 'WIN' | 'LOSE' | 'DRAW' | 'COMPLETED';
  details?: Record<string, unknown>;
}

export interface MatchResult {
  matchId: string;
  roomId: string;
  gameModeId: string;
  startedAt: number;
  endedAt: number;
  reason: string;
  winnerPlayerIds: string[];
  winnerTeamIds: string[];
  participants: ParticipantResult[];
  finalState: Record<string, unknown>;
}

export const ClientEvents = {
  CLIENT_REGISTER: 'client:register',
  CLIENT_HEARTBEAT: 'client:heartbeat',
  PLAYER_JOIN: 'player:join',
  PLAYER_LEAVE: 'player:leave',
  PLAYER_READY: 'player:ready',
  DEVICE_STATUS: 'device:status',
  ROOM_CREATE: 'room:create',
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  ROOM_RESET: 'room:reset',
  MATCH_REQUEST_START: 'match:request_start',
  GAME_EVENT: 'game:event',
  GAME_STATE_REQUEST: 'game:state_request',
} as const;

export const ServerEvents = {
  CLIENT_REGISTERED: 'client:registered',
  ROOM_UPDATED: 'room:updated',
  PLAYER_JOINED: 'player:joined',
  PLAYER_LEFT: 'player:left',
  PLAYER_DISCONNECTED: 'player:disconnected',
  PLAYER_RECONNECTED: 'player:reconnected',
  DEVICE_UPDATED: 'device:updated',
  MATCH_COUNTDOWN: 'match:countdown',
  MATCH_START: 'match:start',
  GAME_EVENT: 'game:event',
  GAME_STATE: 'game:state',
  SCORE_BROADCAST: 'score:broadcast',
  MATCH_FINISH: 'match:finish',
  MATCH_RESULT: 'match:result',
  SERVER_ERROR: 'server:error',
} as const;

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  protocolVersion: string;
  eventId: string;
  eventType: string;
  category: EventCategory;
  matchId: string;
  roomId: string;
  playerId: string;
  clientInstanceId: string;
  sequence: number;
  clientTimestamp: number;
  isOfflineReplay?: boolean;
  payload: TPayload;
}
