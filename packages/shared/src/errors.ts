export const ErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  CLIENT_NOT_REGISTERED: 'CLIENT_NOT_REGISTERED',
  LOCAL_PLAYER_LIMIT_EXCEEDED: 'LOCAL_PLAYER_LIMIT_EXCEEDED',
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
  PLAYER_NOT_OWNED: 'PLAYER_NOT_OWNED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_INVALID_STATE: 'ROOM_INVALID_STATE',
  NOT_ROOM_OWNER: 'NOT_ROOM_OWNER',
  GAME_MODE_NOT_FOUND: 'GAME_MODE_NOT_FOUND',
  INSUFFICIENT_PLAYERS: 'INSUFFICIENT_PLAYERS',
  PLAYERS_NOT_READY: 'PLAYERS_NOT_READY',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  MATCH_NOT_PLAYING: 'MATCH_NOT_PLAYING',
  SPECTATOR_CANNOT_EMIT: 'SPECTATOR_CANNOT_EMIT',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  INVALID_SEQUENCE: 'INVALID_SEQUENCE',
  INVALID_GAME_ACTION: 'INVALID_GAME_ACTION',
  OFFLINE_REPLAY_REJECTED: 'OFFLINE_REPLAY_REJECTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AckError {
  code: ErrorCodeType;
  message: string;
  details?: unknown;
}

export type AckResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: AckError };

export function ok<T>(data: T): AckResponse<T> {
  return { ok: true, data };
}

export function fail(
  code: ErrorCodeType,
  message: string,
  details?: unknown,
): AckResponse<never> {
  return {
    ok: false,
    error: details !== undefined ? { code, message, details } : { code, message },
  };
}

export class PlatformError extends Error {
  readonly code: ErrorCodeType;
  readonly details?: unknown;

  constructor(code: ErrorCodeType, message: string, details?: unknown) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.details = details;
  }

  toAck(): AckResponse<never> {
    return fail(this.code, this.message, this.details);
  }
}
