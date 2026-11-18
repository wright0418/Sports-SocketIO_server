import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  MatchState,
  PlatformError,
  RoomState,
  ServerEvents,
  type MatchResult,
  type MatchSnapshot,
  type MatchStateType,
  type RoomSnapshot,
} from '@edusports/shared';
import type { Server as SocketIOServer } from 'socket.io';
import type { PersistenceService } from '../db/persistence.js';
import type { GameModeRegistry } from '../modes/registry.js';
import type { GameModeServerModule } from '../modes/types.js';
import type {
  ActiveMatchContext,
  GameEventManager,
} from './GameEventManager.js';
import type { RoomManager, RoomRecord } from './RoomManager.js';

interface ManagedMatch extends ActiveMatchContext {
  status: MatchStateType;
  stateVersion: number;
  countdownEndsAt: number | null;
  startedAt: number | null;
  endsAt: number | null;
  countdownTimer: NodeJS.Timeout | null;
  lastScoreBroadcastAt: number;
  lastSnapshotPersistedAt: number;
  scoreDirty: boolean;
}

const MAX_FINISHED_RESULTS_CACHE = 200;

export class MatchManager {
  private readonly activeMatches = new Map<string, ManagedMatch>();
  private readonly finishedResults = new Map<string, MatchResult>();
  private tickLoopTimer: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(
    private readonly io: SocketIOServer,
    private readonly roomManager: RoomManager,
    private readonly modeRegistry: GameModeRegistry,
    private readonly eventManager: GameEventManager,
    private readonly persistence: PersistenceService,
    private readonly options: {
      tickIntervalMs: number;
      scoreBroadcastIntervalMs: number;
      snapshotIntervalMs: number;
    },
  ) {}

  startTickLoop(): void {
    if (this.tickLoopTimer) return;
    this.tickLoopTimer = setInterval(() => {
      void this.processTicks();
    }, this.options.tickIntervalMs);
    this.tickLoopTimer.unref();
  }

  stopTickLoop(): void {
    if (this.tickLoopTimer) {
      clearInterval(this.tickLoopTimer);
      this.tickLoopTimer = null;
    }
    for (const m of this.activeMatches.values()) {
      if (m.countdownTimer) {
        clearTimeout(m.countdownTimer);
        m.countdownTimer = null;
      }
    }
  }

  async requestStartMatch(
    clientInstanceId: string,
    roomId: string,
    countdownMs = 3000,
  ): Promise<{ matchId: string; room: RoomSnapshot; countdownMs: number }> {
    const { room, participants } = this.roomManager.validateStartConditions(
      clientInstanceId,
      roomId,
    );

    const mode = this.modeRegistry.createInstance(room.gameModeId);
    const matchId = `match-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const durationMs =
      typeof room.config.durationMs === 'number' && room.config.durationMs > 0
        ? room.config.durationMs
        : 60000;

    const startAtServerTime = now + countdownMs;
    const endsAt = startAtServerTime + durationMs;

    mode.initialize({
      matchId,
      roomId: room.roomId,
      config: room.config,
      players: participants,
      teams: room.teams,
      startedAt: startAtServerTime,
      endsAt,
    });

    const managed: ManagedMatch = {
      matchId,
      room,
      mode,
      status: countdownMs > 0 ? MatchState.COUNTDOWN : MatchState.PLAYING,
      stateVersion: 1,
      countdownEndsAt: countdownMs > 0 ? startAtServerTime : null,
      startedAt: countdownMs > 0 ? null : now,
      endsAt,
      countdownTimer: null,
      lastScoreBroadcastAt: 0,
      lastSnapshotPersistedAt: now,
      scoreDirty: false,
      seenEventIds: new Set<string>(),
      lastSequenceByPlayer: new Map<string, number>(),
      playerDisconnectWindowMs: new Map<string, number>(),
    };

    this.activeMatches.set(matchId, managed);

    const roomSnapshot = this.roomManager.setRoomMatchState(
      room.roomId,
      countdownMs > 0 ? RoomState.STARTING : RoomState.PLAYING,
      matchId,
    );

    const initialSnapshot = this.buildSnapshot(managed, now);
    await this.persistence.createMatch(initialSnapshot);
    await this.persistence.saveStateSnapshot(
      matchId,
      managed.stateVersion,
      initialSnapshot as unknown as Record<string, unknown>,
    );

    this.io.to(room.roomId).emit(ServerEvents.ROOM_UPDATED, roomSnapshot);

    if (countdownMs > 0) {
      this.io.to(room.roomId).emit(ServerEvents.MATCH_COUNTDOWN, {
        matchId,
        roomId: room.roomId,
        gameModeId: room.gameModeId,
        countdownMs,
        startAtServerTime,
        serverNow: now,
      });

      managed.countdownTimer = setTimeout(() => {
        this.beginPlaying(matchId).catch((err) => {
          console.error(`[MatchManager] Failed to begin playing match ${matchId}:`, err);
        });
      }, countdownMs);
      managed.countdownTimer.unref();
    } else {
      await this.beginPlaying(matchId);
    }

    return { matchId, room: roomSnapshot, countdownMs };
  }

  handleGameEvent(
    clientInstanceId: string,
    rawEnvelope: unknown,
  ): { matchId: string; accepted: boolean; stateVersion: number } {
    const now = Date.now();
    const candidateMatchId =
      typeof rawEnvelope === 'object' &&
      rawEnvelope !== null &&
      'matchId' in rawEnvelope
        ? String((rawEnvelope as { matchId: unknown }).matchId)
        : '';

    const match = this.activeMatches.get(candidateMatchId);
    const { envelope, outcome } = this.eventManager.validateAndProcess(
      clientInstanceId,
      rawEnvelope,
      match,
      now,
    );

    // match is guaranteed defined when validateAndProcess succeeds
    const active = match!;
    if (outcome.stateChanged || outcome.scoreChanged) {
      active.stateVersion += 1;
    }
    if (outcome.scoreChanged) {
      active.scoreDirty = true;
    }

    if (outcome.broadcastEvent) {
      this.io.to(active.room.roomId).emit(ServerEvents.GAME_EVENT, {
        matchId: active.matchId,
        roomId: active.room.roomId,
        eventType: outcome.broadcastEvent.eventType,
        payload: outcome.broadcastEvent.payload,
        serverTimestamp: now,
      });
    }

    if (outcome.stateChanged) {
      const snapshot = this.buildSnapshot(active, now);
      this.io.to(active.room.roomId).emit(ServerEvents.GAME_STATE, snapshot);
    }

    if (outcome.matchShouldFinish) {
      void this.finishMatch(active.matchId, outcome.matchShouldFinish.reason);
    }

    return {
      matchId: envelope.matchId,
      accepted: outcome.accepted,
      stateVersion: active.stateVersion,
    };
  }

  getStateSnapshot(params: {
    matchId?: string;
    roomId?: string;
  }): MatchSnapshot {
    let targetMatchId = params.matchId;
    if (!targetMatchId && params.roomId) {
      const room = this.roomManager.getRoomOrThrow(params.roomId);
      targetMatchId = room.activeMatchId ?? undefined;
    }

    if (targetMatchId) {
      const active = this.activeMatches.get(targetMatchId);
      if (active) {
        return this.buildSnapshot(active, Date.now());
      }
      const finished = this.finishedResults.get(targetMatchId);
      if (finished) {
        return {
          matchId: finished.matchId,
          roomId: finished.roomId,
          gameModeId: finished.gameModeId,
          status: MatchState.FINISHED,
          stateVersion: 0,
          serverNow: Date.now(),
          countdownEndsAt: null,
          startedAt: finished.startedAt,
          endsAt: finished.endedAt,
          scores: finished.participants.map((p) => ({
            playerId: p.playerId,
            displayName: p.displayName,
            teamId: p.teamId,
            score: p.finalScore,
            jumpCount: p.jumpCount,
            rpm: 0,
            energy: 0,
            rank: p.rank,
          })),
          teams: [],
          modeState: finished.finalState,
        };
      }
    }

    throw new PlatformError(
      ErrorCode.MATCH_NOT_FOUND,
      'No active match found for the requested room or matchId',
    );
  }

  recordPlayerDisconnectWindow(playerId: string, disconnectedDurationMs: number): void {
    if (disconnectedDurationMs <= 0) return;
    for (const match of this.activeMatches.values()) {
      if (match.room.players.has(playerId)) {
        const prev = match.playerDisconnectWindowMs.get(playerId) ?? 0;
        match.playerDisconnectWindowMs.set(playerId, prev + disconnectedDurationMs);
      }
    }
  }

  handlePermanentPlayerLeave(roomId: string, playerId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room?.activeMatchId) return;
    const match = this.activeMatches.get(room.activeMatchId);
    if (!match || match.status !== MatchState.PLAYING) return;

    const outcome = match.mode.playerLeft(playerId);
    if (!outcome) return;

    const now = Date.now();
    if (outcome.stateChanged) {
      match.stateVersion += 1;
      this.io
        .to(room.roomId)
        .emit(ServerEvents.GAME_STATE, this.buildSnapshot(match, now));
    }
    if (outcome.matchShouldFinish) {
      void this.finishMatch(match.matchId, outcome.matchShouldFinish.reason);
    }
  }

  getFinishedResult(matchId: string): MatchResult | undefined {
    return this.finishedResults.get(matchId);
  }

  async finishMatch(matchId: string, reason: string): Promise<MatchResult | null> {
    const match = this.activeMatches.get(matchId);
    if (!match || match.status === MatchState.FINISHED) {
      return this.finishedResults.get(matchId) ?? null;
    }

    if (match.countdownTimer) {
      clearTimeout(match.countdownTimer);
      match.countdownTimer = null;
    }

    const now = Date.now();
    match.status = MatchState.FINISHED;
    match.stateVersion += 1;

    const result = match.mode.finish(now, reason);
    this.finishedResults.set(matchId, result);
    if (this.finishedResults.size > MAX_FINISHED_RESULTS_CACHE) {
      const oldestKey = this.finishedResults.keys().next().value;
      if (oldestKey) this.finishedResults.delete(oldestKey);
    }
    this.activeMatches.delete(matchId);

    const finalSnapshot = this.buildSnapshot(match, now);
    await this.persistence.saveStateSnapshot(
      matchId,
      match.stateVersion,
      finalSnapshot as unknown as Record<string, unknown>,
    );
    await this.persistence.finishMatch(result);

    const roomSnapshot = this.roomManager.setRoomMatchState(
      match.room.roomId,
      RoomState.FINISHED,
      matchId,
    );

    this.io.to(match.room.roomId).emit(ServerEvents.MATCH_FINISH, {
      matchId,
      roomId: match.room.roomId,
      endedAt: now,
      reason,
    });
    this.io.to(match.room.roomId).emit(ServerEvents.MATCH_RESULT, result);
    this.io.to(match.room.roomId).emit(ServerEvents.ROOM_UPDATED, roomSnapshot);

    return result;
  }

  private async beginPlaying(matchId: string): Promise<void> {
    const match = this.activeMatches.get(matchId);
    if (!match || match.status === MatchState.FINISHED) return;

    const now = Date.now();
    match.countdownTimer = null;
    match.status = MatchState.PLAYING;
    match.startedAt = now;
    const durationMs =
      typeof match.room.config.durationMs === 'number' &&
      match.room.config.durationMs > 0
        ? match.room.config.durationMs
        : 60000;
    match.endsAt = now + durationMs;
    match.stateVersion += 1;

    match.mode.start(now);

    const roomSnapshot = this.roomManager.setRoomMatchState(
      match.room.roomId,
      RoomState.PLAYING,
      matchId,
    );
    await this.persistence.updateMatchStatus(matchId, MatchState.PLAYING, now);

    const snapshot = this.buildSnapshot(match, now);
    this.io.to(match.room.roomId).emit(ServerEvents.ROOM_UPDATED, roomSnapshot);
    this.io.to(match.room.roomId).emit(ServerEvents.MATCH_START, snapshot);
  }

  private async processTicks(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      const now = Date.now();
      for (const match of Array.from(this.activeMatches.values())) {
        if (match.status !== MatchState.PLAYING) continue;

        const tickOutcome = match.mode.tick(now);

        if (tickOutcome.stateChanged || tickOutcome.scoreChanged) {
          match.stateVersion += 1;
        }

        if (tickOutcome.broadcastEvent) {
          this.io.to(match.room.roomId).emit(ServerEvents.GAME_EVENT, {
            matchId: match.matchId,
            roomId: match.room.roomId,
            eventType: tickOutcome.broadcastEvent.eventType,
            payload: tickOutcome.broadcastEvent.payload,
            serverTimestamp: now,
          });
        }

        if (tickOutcome.stateChanged) {
          this.io
            .to(match.room.roomId)
            .emit(ServerEvents.GAME_STATE, this.buildSnapshot(match, now));
        }

        if (
          (match.scoreDirty || tickOutcome.scoreChanged) &&
          now - match.lastScoreBroadcastAt >= this.options.scoreBroadcastIntervalMs
        ) {
          match.lastScoreBroadcastAt = now;
          match.scoreDirty = false;
          const state = match.mode.getState();
          this.io.to(match.room.roomId).emit(ServerEvents.SCORE_BROADCAST, {
            matchId: match.matchId,
            roomId: match.room.roomId,
            serverNow: now,
            stateVersion: match.stateVersion,
            scores: state.scores,
            teams: state.teams,
          });
        }

        if (now - match.lastSnapshotPersistedAt >= this.options.snapshotIntervalMs) {
          match.lastSnapshotPersistedAt = now;
          const snap = this.buildSnapshot(match, now);
          void this.persistence
            .saveStateSnapshot(
              match.matchId,
              match.stateVersion,
              snap as unknown as Record<string, unknown>,
            )
            .catch(() => {});
        }

        if (tickOutcome.matchShouldFinish) {
          await this.finishMatch(match.matchId, tickOutcome.matchShouldFinish.reason);
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private buildSnapshot(match: ManagedMatch, serverNow: number): MatchSnapshot {
    const state = match.mode.getState();
    return {
      matchId: match.matchId,
      roomId: match.room.roomId,
      gameModeId: match.mode.metadata.modeId,
      status: match.status,
      stateVersion: match.stateVersion,
      serverNow,
      countdownEndsAt: match.countdownEndsAt,
      startedAt: match.startedAt,
      endsAt: match.endsAt,
      scores: state.scores,
      teams: state.teams,
      modeState: state.modeState,
    };
  }
}
