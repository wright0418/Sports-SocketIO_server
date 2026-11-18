import {
  ErrorCode,
  MultiplayerTickPayloadSchema,
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

interface MultiplayerPlayerTrack {
  playerId: string;
  displayName: string;
  teamId: string | null;
  jumpCount: number;
  rpm: number;
  energy: number;
  score: number;
  lastAcceptedAt: number;
}

export const MULTIPLAYER_METADATA: GameModeMetadata = {
  modeId: 'multiplayer',
  name: '一般多人對戰',
  version: '1.0.0',
  developerId: 'edusports',
  protocolVersion: '1.0',
  minPlayers: 1,
  maxPlayers: 24,
  teamMode: 'hybrid',
  requiredDevices: ['BLE_ROPE'],
  supportedFeatures: ['score-sync', 'ranking', 'team-score', 'offline-replay-limited'],
  scoringType: 'jump_count',
  defaultConfig: {
    durationMs: 60000,
    maxJumpsPerSecond: 12,
    scorePerJump: 10,
  },
  allowedOrigins: ['*'],
  offlineEventPolicy: 'ALLOW_WITH_RATE_LIMIT',
};

export class MultiplayerModeModule implements GameModeServerModule {
  readonly metadata = MULTIPLAYER_METADATA;

  private matchId = '';
  private roomId = '';
  private startedAt = 0;
  private endsAt = 0;
  private maxJumpsPerSecond = 12;
  private scorePerJump = 10;
  private tracks = new Map<string, MultiplayerPlayerTrack>();
  private teams = new Map<string, TeamState>();

  validatePayload(eventType: string, payload: unknown): Record<string, unknown> {
    if (eventType !== 'jump:tick') {
      throw new PlatformError(
        ErrorCode.INVALID_PAYLOAD,
        `Unsupported eventType "${eventType}" for mode "${this.metadata.modeId}"`,
      );
    }
    const parsed = MultiplayerTickPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new PlatformError(
        ErrorCode.INVALID_PAYLOAD,
        'Invalid jump:tick payload',
        parsed.error.flatten(),
      );
    }
    return parsed.data;
  }

  initialize(context: ModeContext): void {
    this.matchId = context.matchId;
    this.roomId = context.roomId;
    this.startedAt = context.startedAt;
    this.endsAt = context.endsAt;

    const cfg = context.config;
    if (typeof cfg.maxJumpsPerSecond === 'number' && cfg.maxJumpsPerSecond > 0) {
      this.maxJumpsPerSecond = cfg.maxJumpsPerSecond;
    }
    if (typeof cfg.scorePerJump === 'number' && cfg.scorePerJump > 0) {
      this.scorePerJump = cfg.scorePerJump;
    }

    this.tracks.clear();
    for (const player of context.players) {
      this.playerJoined(player);
    }

    this.teams.clear();
    for (const team of context.teams) {
      this.teams.set(team.teamId, { ...team, score: 0 });
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
      energy: 0,
      score: 0,
      lastAcceptedAt: this.startedAt || Date.now(),
    });
  }

  playerLeft(_playerId: string): void {
    // Keep participant track so final match record preserves progress
  }

  playerReady(_playerId: string, _ready: boolean): void {
    // Ready state handled by RoomManager prior to start
  }

  start(serverNow: number): void {
    this.startedAt = serverNow;
    for (const track of this.tracks.values()) {
      track.lastAcceptedAt = serverNow;
    }
  }

  handleEvent(
    envelope: EventEnvelope,
    serverNow: number,
    offlineWindowMs = 0,
  ): ModeEventOutcome {
    const track = this.tracks.get(envelope.playerId);
    if (!track) {
      throw new PlatformError(
        ErrorCode.PLAYER_NOT_FOUND,
        `Player ${envelope.playerId} is not part of this match`,
      );
    }

    const data = this.validatePayload(envelope.eventType, envelope.payload) as {
      totalJumps: number;
      deltaJumps?: number;
      rpm: number;
      energy: number;
    };

    const delta =
      data.deltaJumps !== undefined
        ? data.deltaJumps
        : Math.max(0, data.totalJumps - track.jumpCount);

    // Rate validation: allow small physical burst buffer (+10) plus elapsed/offline window
    const effectiveWindowMs = envelope.isOfflineReplay
      ? Math.max(offlineWindowMs, serverNow - track.lastAcceptedAt)
      : Math.max(1000, serverNow - track.lastAcceptedAt);
    const maxAllowedDelta =
      Math.ceil((effectiveWindowMs / 1000) * this.maxJumpsPerSecond) + 10;

    if (delta > maxAllowedDelta) {
      throw new PlatformError(
        ErrorCode.INVALID_GAME_ACTION,
        `Jump delta ${delta} exceeds rate limit (${maxAllowedDelta} allowed in ${effectiveWindowMs}ms)`,
      );
    }

    track.jumpCount += delta;
    track.rpm = data.rpm;
    track.energy = data.energy ?? track.energy;
    track.score = track.jumpCount * this.scorePerJump;
    track.lastAcceptedAt = serverNow;

    this.recomputeTeamScores();

    return {
      accepted: true,
      stateChanged: true,
      scoreChanged: true,
    };
  }

  tick(serverNow: number): ModeTickOutcome {
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
    const scores = this.computeRankedScores();
    return {
      scores,
      teams: Array.from(this.teams.values()),
      modeState: {
        scorePerJump: this.scorePerJump,
        maxJumpsPerSecond: this.maxJumpsPerSecond,
      },
    };
  }

  finish(serverNow: number, reason: string): MatchResult {
    const scores = this.computeRankedScores();
    const topScore = scores[0]?.score ?? 0;
    const winners = scores.filter((s) => s.score === topScore && topScore > 0);
    const isDraw = winners.length > 1;

    const participants: ParticipantResult[] = scores.map((s) => {
      let outcome: ParticipantResult['outcome'] = 'COMPLETED';
      if (scores.length > 1) {
        if (s.score === topScore && topScore > 0) {
          outcome = isDraw ? 'DRAW' : 'WIN';
        } else {
          outcome = 'LOSE';
        }
      }
      return {
        playerId: s.playerId,
        displayName: s.displayName,
        teamId: s.teamId,
        finalScore: s.score,
        jumpCount: s.jumpCount,
        rank: s.rank,
        outcome,
        details: { rpm: s.rpm, energy: s.energy },
      };
    });

    const teams = Array.from(this.teams.values());
    const topTeamScore = teams.reduce((m, t) => Math.max(m, t.score), 0);
    const winnerTeamIds =
      topTeamScore > 0
        ? teams.filter((t) => t.score === topTeamScore).map((t) => t.teamId)
        : [];

    return {
      matchId: this.matchId,
      roomId: this.roomId,
      gameModeId: this.metadata.modeId,
      startedAt: this.startedAt,
      endedAt: serverNow,
      reason,
      winnerPlayerIds: winners.map((w) => w.playerId),
      winnerTeamIds,
      participants,
      finalState: this.getState().modeState,
    };
  }

  recover(_playerId: string): Record<string, unknown> {
    return this.getState().modeState;
  }

  private recomputeTeamScores(): void {
    for (const team of this.teams.values()) {
      team.score = 0;
    }
    for (const track of this.tracks.values()) {
      if (track.teamId && this.teams.has(track.teamId)) {
        this.teams.get(track.teamId)!.score += track.score;
      }
    }
  }

  private computeRankedScores(): PlayerScoreEntry[] {
    const sorted = Array.from(this.tracks.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.jumpCount - a.jumpCount;
    });

    let currentRank = 1;
    return sorted.map((track, idx) => {
      if (idx > 0 && track.score < sorted[idx - 1].score) {
        currentRank = idx + 1;
      }
      return {
        playerId: track.playerId,
        displayName: track.displayName,
        teamId: track.teamId,
        score: track.score,
        jumpCount: track.jumpCount,
        rpm: track.rpm,
        energy: track.energy,
        rank: currentRank,
      };
    });
  }
}
