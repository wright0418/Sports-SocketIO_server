import type {
  EventEnvelope,
  GameModeMetadata,
  MatchResult,
  PlayerScoreEntry,
  PlayerState,
  TeamState,
} from '@edusports/shared';

export interface ModeContext {
  matchId: string;
  roomId: string;
  config: Record<string, unknown>;
  players: PlayerState[];
  teams: TeamState[];
  startedAt: number;
  endsAt: number;
}

export interface ModeEventOutcome {
  accepted: boolean;
  stateChanged: boolean;
  scoreChanged: boolean;
  broadcastEvent?: {
    eventType: string;
    payload: Record<string, unknown>;
  };
  matchShouldFinish?: {
    reason: string;
  };
}

export interface ModeTickOutcome {
  stateChanged: boolean;
  scoreChanged: boolean;
  broadcastEvent?: {
    eventType: string;
    payload: Record<string, unknown>;
  };
  matchShouldFinish?: {
    reason: string;
  };
}

export interface GameModeServerModule {
  readonly metadata: GameModeMetadata;
  validatePayload(eventType: string, payload: unknown): Record<string, unknown>;
  initialize(context: ModeContext): void;
  playerJoined(player: PlayerState): void;
  playerLeft(playerId: string): ModeEventOutcome | void;
  playerReady(playerId: string, ready: boolean): void;
  start(serverNow: number): void;
  handleEvent(
    envelope: EventEnvelope,
    serverNow: number,
    offlineWindowMs?: number,
  ): ModeEventOutcome;
  tick(serverNow: number): ModeTickOutcome;
  getState(): {
    scores: PlayerScoreEntry[];
    teams: TeamState[];
    modeState: Record<string, unknown>;
  };
  finish(serverNow: number, reason: string): MatchResult;
  recover(playerId: string): Record<string, unknown>;
}
