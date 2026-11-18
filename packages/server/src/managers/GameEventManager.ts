import {
  ErrorCode,
  EventEnvelopeSchema,
  MatchState,
  PlatformError,
  PlayerRole,
  type EventEnvelope,
} from '@edusports/shared';
import type { PersistenceService } from '../db/persistence.js';
import type { GameModeServerModule, ModeEventOutcome } from '../modes/types.js';
import type { PlayerManager } from './PlayerManager.js';
import type { RoomRecord } from './RoomManager.js';

export interface ActiveMatchContext {
  matchId: string;
  room: RoomRecord;
  mode: GameModeServerModule;
  status: string;
  seenEventIds: Set<string>;
  lastSequenceByPlayer: Map<string, number>;
  playerDisconnectWindowMs: Map<string, number>;
}

export class GameEventManager {
  constructor(
    private readonly playerManager: PlayerManager,
    private readonly persistence: PersistenceService,
  ) {}

  validateAndProcess(
    authenticatedClientInstanceId: string,
    rawEnvelope: unknown,
    match: ActiveMatchContext | undefined,
    serverNow: number,
  ): { envelope: EventEnvelope; outcome: ModeEventOutcome } {
    // 1. Parse Envelope Schema
    const parsed = EventEnvelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      throw new PlatformError(
        ErrorCode.INVALID_PAYLOAD,
        'Invalid game event envelope',
        parsed.error.flatten(),
      );
    }
    const envelope = parsed.data as EventEnvelope;

    // 2. Verify clientInstanceId matches authenticated socket
    if (envelope.clientInstanceId !== authenticatedClientInstanceId) {
      throw new PlatformError(
        ErrorCode.UNAUTHORIZED,
        'Envelope clientInstanceId does not match authenticated connection',
      );
    }

    // 3. Verify playerId belongs to this clientInstanceId
    this.playerManager.assertPlayerOwned(
      authenticatedClientInstanceId,
      envelope.playerId,
    );

    // 4. Verify match exists and is PLAYING
    if (!match || match.matchId !== envelope.matchId) {
      throw new PlatformError(
        ErrorCode.MATCH_NOT_FOUND,
        `Match "${envelope.matchId}" not found or inactive`,
      );
    }
    if (match.status !== MatchState.PLAYING) {
      throw new PlatformError(
        ErrorCode.MATCH_NOT_PLAYING,
        `Cannot accept game events while match is "${match.status}"`,
      );
    }
    if (match.room.roomId !== envelope.roomId) {
      throw new PlatformError(
        ErrorCode.ROOM_NOT_FOUND,
        'Envelope roomId does not match active match room',
      );
    }

    // 5. Verify sender is an active PLAYER (not SPECTATOR)
    const roomPlayer = match.room.players.get(envelope.playerId);
    if (!roomPlayer) {
      throw new PlatformError(
        ErrorCode.PLAYER_NOT_FOUND,
        `Player "${envelope.playerId}" is not in room "${envelope.roomId}"`,
      );
    }
    if (roomPlayer.role === PlayerRole.SPECTATOR) {
      throw new PlatformError(
        ErrorCode.SPECTATOR_CANNOT_EMIT,
        'Spectators cannot emit game events',
      );
    }

    // 6. Deduplicate eventId
    if (match.seenEventIds.has(envelope.eventId)) {
      throw new PlatformError(
        ErrorCode.DUPLICATE_EVENT,
        `Duplicate eventId "${envelope.eventId}"`,
      );
    }

    // 7. Enforce per-(matchId, playerId) monotonic sequence
    const lastSeq = match.lastSequenceByPlayer.get(envelope.playerId) ?? 0;
    if (envelope.sequence <= lastSeq) {
      throw new PlatformError(
        ErrorCode.INVALID_SEQUENCE,
        `Invalid sequence ${envelope.sequence}; expected > ${lastSeq}`,
      );
    }

    // 8. Offline replay policy check & mode handler
    if (
      envelope.isOfflineReplay &&
      match.mode.metadata.offlineEventPolicy === 'REJECT_ALL'
    ) {
      throw new PlatformError(
        ErrorCode.OFFLINE_REPLAY_REJECTED,
        `Mode "${match.mode.metadata.modeId}" rejects offline replayed events`,
      );
    }

    const offlineWindowMs =
      match.playerDisconnectWindowMs.get(envelope.playerId) ?? 0;
    const outcome = match.mode.handleEvent(envelope, serverNow, offlineWindowMs);

    // Record accepted eventId & sequence only after validation succeeds
    match.seenEventIds.add(envelope.eventId);
    match.lastSequenceByPlayer.set(envelope.playerId, envelope.sequence);
    if (envelope.isOfflineReplay) {
      match.playerDisconnectWindowMs.delete(envelope.playerId);
    }

    // Persist critical events via 500ms batch queue
    if (envelope.category === 'critical') {
      this.persistence.enqueueCriticalEvent({
        matchId: envelope.matchId,
        playerId: envelope.playerId,
        eventId: envelope.eventId,
        sequence: envelope.sequence,
        eventType: envelope.eventType,
        payload: envelope.payload,
        serverTimestamp: new Date(serverNow),
      });
    }

    return { envelope, outcome };
  }
}
