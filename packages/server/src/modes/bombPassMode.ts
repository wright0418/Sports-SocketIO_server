import {
  BombJumpPayloadSchema,
  BombPassPayloadSchema,
  ErrorCode,
  PlatformError,
  type EventEnvelope,
  type GameModeMetadata,
  type MatchResult,
  type ParticipantResult,
  type PlayerScoreEntry,
  type PlayerState,
  type TeamState,
} from '@edusports/shared';
import type {
  GameModeServerModule,
  ModeContext,
  ModeEventOutcome,
  ModeTickOutcome,
} from './types.js';

interface BombPlayerTrack {
  playerId: string;
  displayName: string;
  teamId: string | null;
  jumpCount: number;
  rpm: number;
  passesCompleted: number;
  eliminated: boolean;
  eliminatedAt: number | null;
  eliminationOrder: number | null;
}

export const BOMB_PASS_METADATA: GameModeMetadata = {
  modeId: 'bomb-pass',
  name: '定時傳炸彈',
  version: '1.0.0',
  developerId: 'edusports',
  protocolVersion: '1.0',
  minPlayers: 2,
  maxPlayers: 16,
  teamMode: 'individual',
  requiredDevices: ['BLE_ROPE'],
  supportedFeatures: ['server-authoritative-state', 'real-time-events', 'elimination'],
  scoringType: 'survival',
  defaultConfig: {
    durationMs: 90000,
    fuseDurationMs: 12000,
    jumpsRequiredToPass: 5,
  },
  allowedOrigins: ['*'],
  offlineEventPolicy: 'REJECT_ALL',
};

export class BombPassModeModule implements GameModeServerModule {
  readonly metadata = BOMB_PASS_METADATA;

  private matchId = '';
  private roomId = '';
  private startedAt = 0;
  private endsAt = 0;
  private fuseDurationMs = 12000;
  private jumpsRequiredToPass = 5;

  private tracks = new Map<string, BombPlayerTrack>();
  private aliveOrder: string[] = [];
  private eliminatedOrder: string[] = [];
  private bombHolderPlayerId: string | null = null;
  private bombExplodeAtServerTime: number | null = null;
  private currentHolderJumps = 0;
  private roundNumber = 0;

  validatePayload(eventType: string, payload: unknown): Record<string, unknown> {
    if (eventType === 'bomb:jump') {
      const parsed = BombJumpPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new PlatformError(
          ErrorCode.INVALID_PAYLOAD,
          'Invalid bomb:jump payload',
          parsed.error.flatten(),
        );
      }
      return parsed.data;
    }
    if (eventType === 'bomb:pass') {
      const parsed = BombPassPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new PlatformError(
          ErrorCode.INVALID_PAYLOAD,
          'Invalid bomb:pass payload',
          parsed.error.flatten(),
        );
      }
      return parsed.data;
    }
    throw new PlatformError(
      ErrorCode.INVALID_PAYLOAD,
      `Unsupported eventType "${eventType}" for mode "${this.metadata.modeId}"`,
    );
  }

  initialize(context: ModeContext): void {
    this.matchId = context.matchId;
    this.roomId = context.roomId;
    this.startedAt = context.startedAt;
    this.endsAt = context.endsAt;

    const cfg = context.config;
    if (typeof cfg.fuseDurationMs === 'number' && cfg.fuseDurationMs >= 1000) {
      this.fuseDurationMs = cfg.fuseDurationMs;
    }
    if (typeof cfg.jumpsRequiredToPass === 'number' && cfg.jumpsRequiredToPass >= 1) {
      this.jumpsRequiredToPass = cfg.jumpsRequiredToPass;
    }

    this.tracks.clear();
    this.aliveOrder = [];
    this.eliminatedOrder = [];

    for (const player of context.players) {
      this.playerJoined(player);
    }
  }

  playerJoined(player: PlayerState): void {
    if (this.tracks.has(player.playerId)) return;
    this.tracks.set(player.playerId, {
      playerId: player.playerId,
      displayName: player.displayName,
      teamId: player.teamId,
      jumpCount: 0,
      rpm: 0,
      passesCompleted: 0,
      eliminated: false,
      eliminatedAt: null,
      eliminationOrder: null,
    });
    this.aliveOrder.push(player.playerId);
  }

  playerLeft(playerId: string): ModeEventOutcome | void {
    const track = this.tracks.get(playerId);
    if (!track || track.eliminated) return;

    const now = Date.now();
    this.eliminatePlayer(playerId, now);

    if (this.aliveOrder.length <= 1) {
      return {
        accepted: true,
        stateChanged: true,
        scoreChanged: true,
        matchShouldFinish: { reason: 'LAST_SURVIVOR' },
      };
    }

    if (this.bombHolderPlayerId === playerId) {
      this.assignBombToNext(now);
    }

    return {
      accepted: true,
      stateChanged: true,
      scoreChanged: true,
    };
  }

  playerReady(_playerId: string, _ready: boolean): void {
    // Handled by RoomManager
  }

  start(serverNow: number): void {
    this.startedAt = serverNow;
    this.roundNumber = 1;
    this.currentHolderJumps = 0;
    this.bombHolderPlayerId = this.aliveOrder[0] ?? null;
    this.bombExplodeAtServerTime =
      this.bombHolderPlayerId !== null ? serverNow + this.fuseDurationMs : null;
  }

  handleEvent(envelope: EventEnvelope, serverNow: number): ModeEventOutcome {
    if (envelope.isOfflineReplay) {
      throw new PlatformError(
        ErrorCode.OFFLINE_REPLAY_REJECTED,
        'bomb-pass does not accept offline replayed events',
      );
    }

    const track = this.tracks.get(envelope.playerId);
    if (!track) {
      throw new PlatformError(
        ErrorCode.PLAYER_NOT_FOUND,
        `Player ${envelope.playerId} is not in match`,
      );
    }
    if (track.eliminated) {
      throw new PlatformError(
        ErrorCode.INVALID_GAME_ACTION,
        'Eliminated player cannot send game actions',
      );
    }

    if (envelope.eventType === 'bomb:jump') {
      const data = this.validatePayload('bomb:jump', envelope.payload) as {
        deltaJumps: number;
        rpm: number;
      };
      track.jumpCount += data.deltaJumps;
      track.rpm = data.rpm ?? track.rpm;
      if (this.bombHolderPlayerId === envelope.playerId) {
        this.currentHolderJumps += data.deltaJumps;
      }
      return {
        accepted: true,
        stateChanged: this.bombHolderPlayerId === envelope.playerId,
        scoreChanged: true,
      };
    }

    if (envelope.eventType === 'bomb:pass') {
      const data = this.validatePayload('bomb:pass', envelope.payload) as {
        targetPlayerId?: string;
      };
      if (this.bombHolderPlayerId !== envelope.playerId) {
        throw new PlatformError(
          ErrorCode.INVALID_GAME_ACTION,
          'Only the current bomb holder can pass the bomb',
        );
      }
      if (this.currentHolderJumps < this.jumpsRequiredToPass) {
        throw new PlatformError(
          ErrorCode.INVALID_GAME_ACTION,
          `Need ${this.jumpsRequiredToPass} jumps before passing (currently ${this.currentHolderJumps})`,
        );
      }

      const nextHolder = this.pickPassTarget(envelope.playerId, data.targetPlayerId);
      if (!nextHolder) {
        throw new PlatformError(
          ErrorCode.INVALID_GAME_ACTION,
          'No eligible alive player to receive the bomb',
        );
      }

      track.passesCompleted += 1;
      const previousHolder = envelope.playerId;
      this.bombHolderPlayerId = nextHolder;
      this.currentHolderJumps = 0;
      this.roundNumber += 1;
      this.bombExplodeAtServerTime = serverNow + this.fuseDurationMs;

      return {
        accepted: true,
        stateChanged: true,
        scoreChanged: true,
        broadcastEvent: {
          eventType: 'bomb:passed',
          payload: {
            fromPlayerId: previousHolder,
            toPlayerId: nextHolder,
            roundNumber: this.roundNumber,
            bombExplodeAtServerTime: this.bombExplodeAtServerTime,
          },
        },
      };
    }

    throw new PlatformError(
      ErrorCode.INVALID_PAYLOAD,
      `Unsupported eventType "${envelope.eventType}"`,
    );
  }

  tick(serverNow: number): ModeTickOutcome {
    if (
      this.bombHolderPlayerId &&
      this.bombExplodeAtServerTime !== null &&
      serverNow >= this.bombExplodeAtServerTime
    ) {
      const explodedPlayerId = this.bombHolderPlayerId;
      this.eliminatePlayer(explodedPlayerId, serverNow);

      if (this.aliveOrder.length <= 1) {
        this.bombHolderPlayerId = null;
        this.bombExplodeAtServerTime = null;
        return {
          stateChanged: true,
          scoreChanged: true,
          broadcastEvent: {
            eventType: 'bomb:exploded',
            payload: {
              eliminatedPlayerId: explodedPlayerId,
              remainingPlayerIds: [...this.aliveOrder],
            },
          },
          matchShouldFinish: { reason: 'LAST_SURVIVOR' },
        };
      }

      this.assignBombToNext(serverNow);
      return {
        stateChanged: true,
        scoreChanged: true,
        broadcastEvent: {
          eventType: 'bomb:exploded',
          payload: {
            eliminatedPlayerId: explodedPlayerId,
            nextHolderPlayerId: this.bombHolderPlayerId,
            bombExplodeAtServerTime: this.bombExplodeAtServerTime,
            roundNumber: this.roundNumber,
          },
        },
      };
    }

    if (this.endsAt > 0 && serverNow >= this.endsAt) {
      return {
        stateChanged: false,
        scoreChanged: false,
        matchShouldFinish: { reason: 'TIME_UP' },
      };
    }

    return { stateChanged: false, scoreChanged: false };
  }

  getState(): {
    scores: PlayerScoreEntry[];
    teams: TeamState[];
    modeState: Record<string, unknown>;
  } {
    return {
      scores: this.computeScores(Date.now()),
      teams: [],
      modeState: {
        bombHolderPlayerId: this.bombHolderPlayerId,
        bombExplodeAtServerTime: this.bombExplodeAtServerTime,
        fuseDurationMs: this.fuseDurationMs,
        jumpsRequiredToPass: this.jumpsRequiredToPass,
        currentHolderJumps: this.currentHolderJumps,
        alivePlayerIds: [...this.aliveOrder],
        eliminatedPlayerIds: [...this.eliminatedOrder],
        roundNumber: this.roundNumber,
      },
    };
  }

  finish(serverNow: number, reason: string): MatchResult {
    const scores = this.computeScores(serverNow);
    const winners = scores.filter((s) => !s.eliminated);
    const winnerIds =
      winners.length > 0
        ? winners.filter((s) => s.rank === 1).map((s) => s.playerId)
        : scores.filter((s) => s.rank === 1).map((s) => s.playerId);

    const isDraw = winnerIds.length > 1;

    const participants: ParticipantResult[] = scores.map((s) => {
      const track = this.tracks.get(s.playerId)!;
      const isWinner = winnerIds.includes(s.playerId);
      return {
        playerId: s.playerId,
        displayName: s.displayName,
        teamId: s.teamId,
        finalScore: s.score,
        jumpCount: s.jumpCount,
        rank: s.rank,
        outcome: isWinner ? (isDraw ? 'DRAW' : 'WIN') : 'LOSE',
        details: {
          eliminated: track.eliminated,
          passesCompleted: track.passesCompleted,
        },
      };
    });

    return {
      matchId: this.matchId,
      roomId: this.roomId,
      gameModeId: this.metadata.modeId,
      startedAt: this.startedAt,
      endedAt: serverNow,
      reason,
      winnerPlayerIds: winnerIds,
      winnerTeamIds: [],
      participants,
      finalState: this.getState().modeState,
    };
  }

  recover(_playerId: string): Record<string, unknown> {
    return this.getState().modeState;
  }

  private eliminatePlayer(playerId: string, serverNow: number): void {
    const track = this.tracks.get(playerId);
    if (!track || track.eliminated) return;
    track.eliminated = true;
    track.eliminatedAt = serverNow;
    this.eliminatedOrder.push(playerId);
    track.eliminationOrder = this.eliminatedOrder.length;
    this.aliveOrder = this.aliveOrder.filter((id) => id !== playerId);
  }

  private assignBombToNext(serverNow: number): void {
    this.bombHolderPlayerId = this.aliveOrder[0] ?? null;
    this.currentHolderJumps = 0;
    this.roundNumber += 1;
    this.bombExplodeAtServerTime =
      this.bombHolderPlayerId !== null ? serverNow + this.fuseDurationMs : null;
  }

  private pickPassTarget(
    currentHolderId: string,
    requestedTargetId?: string,
  ): string | null {
    if (
      requestedTargetId &&
      requestedTargetId !== currentHolderId &&
      this.aliveOrder.includes(requestedTargetId)
    ) {
      return requestedTargetId;
    }
    const idx = this.aliveOrder.indexOf(currentHolderId);
    if (this.aliveOrder.length <= 1) return null;
    const nextIdx = (idx + 1) % this.aliveOrder.length;
    return this.aliveOrder[nextIdx] ?? null;
  }

  private computeScores(now: number): PlayerScoreEntry[] {
    const entries = Array.from(this.tracks.values()).map((t) => {
      const survivedMs = (t.eliminatedAt ?? now) - (this.startedAt || now);
      const survivalBonus = t.eliminated ? 0 : 10000;
      const score =
        survivalBonus +
        Math.max(0, Math.floor(survivedMs / 100)) +
        t.passesCompleted * 50;
      return { track: t, score };
    });

    entries.sort((a, b) => {
      if (a.track.eliminated !== b.track.eliminated) {
        return a.track.eliminated ? 1 : -1;
      }
      if (
        a.track.eliminationOrder !== null &&
        b.track.eliminationOrder !== null &&
        a.track.eliminationOrder !== b.track.eliminationOrder
      ) {
        return b.track.eliminationOrder - a.track.eliminationOrder;
      }
      return b.score - a.score;
    });

    let rank = 1;
    return entries.map((entry, idx) => {
      if (idx > 0) {
        const prev = entries[idx - 1];
        if (
          entry.track.eliminated !== prev.track.eliminated ||
          entry.score < prev.score
        ) {
          rank = idx + 1;
        }
      }
      return {
        playerId: entry.track.playerId,
        displayName: entry.track.displayName,
        teamId: entry.track.teamId,
        score: entry.score,
        jumpCount: entry.track.jumpCount,
        rpm: entry.track.rpm,
        energy: 0,
        rank,
        eliminated: entry.track.eliminated,
      };
    });
  }
}
