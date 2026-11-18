import { eq, desc, sql } from 'drizzle-orm';
import type {
  DeviceState,
  GameModeMetadata,
  MatchResult,
  MatchSnapshot,
  RoomSnapshot,
  RoomStateType,
} from '@edusports/shared';
import type { Database } from './index.js';
import {
  clientInstances,
  devices,
  gameEvents,
  gameModes,
  gameStates,
  matches,
  matchParticipants,
  roomPlayers,
  rooms,
  users,
} from './schema.js';

export interface CriticalEventRecord {
  matchId: string;
  playerId: string;
  eventId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  serverTimestamp: Date;
}

export class PersistenceService {
  private eventQueue: CriticalEventRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(
    private readonly db: Database,
    private readonly flushIntervalMs = 500,
  ) {}

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flushEvents().catch((err) => {
        console.error('[Persistence] Periodic event flush failed:', err);
      });
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushEvents();
  }

  async seedGameModes(modes: GameModeMetadata[]): Promise<void> {
    for (const mode of modes) {
      await this.db
        .insert(gameModes)
        .values({
          modeId: mode.modeId,
          name: mode.name,
          version: mode.version,
          developerId: mode.developerId,
          protocolVersion: mode.protocolVersion,
          minPlayers: mode.minPlayers,
          maxPlayers: mode.maxPlayers,
          allowedOrigins: mode.allowedOrigins,
          clientEntryUrl: mode.clientEntryUrl ?? null,
          configuration: mode.defaultConfig,
          status: 'ACTIVE',
        })
        .onConflictDoUpdate({
          target: gameModes.modeId,
          set: {
            name: mode.name,
            version: mode.version,
            developerId: mode.developerId,
            protocolVersion: mode.protocolVersion,
            minPlayers: mode.minPlayers,
            maxPlayers: mode.maxPlayers,
            allowedOrigins: mode.allowedOrigins,
            clientEntryUrl: mode.clientEntryUrl ?? null,
            configuration: mode.defaultConfig,
            status: 'ACTIVE',
          },
        });
    }
  }

  async upsertClientInstance(
    clientInstanceId: string,
    status: string,
  ): Promise<void> {
    await this.db
      .insert(clientInstances)
      .values({
        clientInstanceId,
        status,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: clientInstances.clientInstanceId,
        set: {
          status,
          lastSeenAt: new Date(),
        },
      });
  }

  async upsertUser(
    playerId: string,
    displayName: string,
    status = 'ACTIVE',
  ): Promise<void> {
    await this.db
      .insert(users)
      .values({
        id: playerId,
        displayName,
        status,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          displayName,
          status,
        },
      });
  }

  async upsertDevice(device: DeviceState): Promise<void> {
    await this.db
      .insert(devices)
      .values({
        deviceId: device.deviceId,
        deviceType: device.deviceType,
        deviceStatus: device.connectionStatus,
        assignedPlayerId: device.assignedPlayerId,
        localClientId: device.localClientId,
        lastDataTimestamp: device.lastDataTimestamp,
      })
      .onConflictDoUpdate({
        target: devices.deviceId,
        set: {
          deviceType: device.deviceType,
          deviceStatus: device.connectionStatus,
          assignedPlayerId: device.assignedPlayerId,
          localClientId: device.localClientId,
          lastDataTimestamp: device.lastDataTimestamp,
        },
      });
  }

  async saveRoom(room: RoomSnapshot): Promise<void> {
    await this.db
      .insert(rooms)
      .values({
        id: room.roomId,
        roomCode: room.roomCode,
        gameModeId: room.gameModeId,
        ownerId: room.ownerClientInstanceId,
        status: room.status,
        maxPlayers: room.maxPlayers,
        createdAt: new Date(room.createdAt),
      })
      .onConflictDoUpdate({
        target: rooms.id,
        set: {
          gameModeId: room.gameModeId,
          ownerId: room.ownerClientInstanceId,
          status: room.status,
          maxPlayers: room.maxPlayers,
        },
      });
    await this.syncRoomPlayers(room);
  }

  async updateRoomStatus(
    roomId: string,
    status: RoomStateType,
    gameModeId?: string,
    ownerId?: string,
  ): Promise<void> {
    const patch: Partial<typeof rooms.$inferInsert> = { status };
    if (gameModeId) patch.gameModeId = gameModeId;
    if (ownerId) patch.ownerId = ownerId;
    await this.db.update(rooms).set(patch).where(eq(rooms.id, roomId));
  }

  async syncRoomPlayers(room: RoomSnapshot): Promise<void> {
    await this.db.delete(roomPlayers).where(eq(roomPlayers.roomId, room.roomId));
    if (room.players.length === 0) return;
    await this.db.insert(roomPlayers).values(
      room.players.map((p) => ({
        roomId: room.roomId,
        playerId: p.playerId,
        clientInstanceId: p.clientInstanceId,
        role: p.role,
        teamId: p.teamId,
        status: p.connectionStatus,
      })),
    );
  }

  async createMatch(snapshot: MatchSnapshot): Promise<void> {
    await this.db
      .insert(matches)
      .values({
        id: snapshot.matchId,
        roomId: snapshot.roomId,
        gameModeId: snapshot.gameModeId,
        status: snapshot.status,
        startedAt: snapshot.startedAt ? new Date(snapshot.startedAt) : null,
      })
      .onConflictDoUpdate({
        target: matches.id,
        set: {
          status: snapshot.status,
          startedAt: snapshot.startedAt ? new Date(snapshot.startedAt) : null,
        },
      });
  }

  async updateMatchStatus(
    matchId: string,
    status: string,
    startedAt?: number | null,
  ): Promise<void> {
    const patch: Partial<typeof matches.$inferInsert> = { status };
    if (startedAt !== undefined) {
      patch.startedAt = startedAt ? new Date(startedAt) : null;
    }
    await this.db.update(matches).set(patch).where(eq(matches.id, matchId));
  }

  async finishMatch(result: MatchResult): Promise<void> {
    await this.flushEvents();
    await this.db
      .update(matches)
      .set({
        status: 'FINISHED',
        startedAt: new Date(result.startedAt),
        endedAt: new Date(result.endedAt),
        result: result as unknown as Record<string, unknown>,
      })
      .where(eq(matches.id, result.matchId));

    if (result.participants.length > 0) {
      await this.db
        .insert(matchParticipants)
        .values(
          result.participants.map((p) => ({
            matchId: result.matchId,
            playerId: p.playerId,
            teamId: p.teamId,
            finalScore: p.finalScore,
            result: p as unknown as Record<string, unknown>,
          })),
        )
        .onConflictDoUpdate({
          target: [matchParticipants.matchId, matchParticipants.playerId],
          set: {
            teamId: sql`excluded.team_id`,
            finalScore: sql`excluded.final_score`,
            result: sql`excluded.result`,
          },
        });
    }
  }

  enqueueCriticalEvent(record: CriticalEventRecord): void {
    this.eventQueue.push(record);
  }

  async flushEvents(): Promise<void> {
    if (this.isFlushing || this.eventQueue.length === 0) return;
    this.isFlushing = true;
    const batch = this.eventQueue.splice(0, this.eventQueue.length);
    try {
      await this.db
        .insert(gameEvents)
        .values(
          batch.map((ev) => ({
            matchId: ev.matchId,
            playerId: ev.playerId,
            eventId: ev.eventId,
            sequence: ev.sequence,
            eventType: ev.eventType,
            payload: ev.payload,
            serverTimestamp: ev.serverTimestamp,
          })),
        )
        .onConflictDoNothing({ target: gameEvents.eventId });
    } catch (err) {
      // Re-queue failed batch at front to avoid losing events on transient error
      this.eventQueue.unshift(...batch);
      throw err;
    } finally {
      this.isFlushing = false;
    }
  }

  async saveStateSnapshot(
    matchId: string,
    stateVersion: number,
    stateData: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(gameStates).values({
      matchId,
      stateVersion,
      stateData,
    });
  }

  async getMatchRecord(matchId: string): Promise<{
    match: typeof matches.$inferSelect;
    participants: (typeof matchParticipants.$inferSelect)[];
    latestState: typeof gameStates.$inferSelect | null;
  } | null> {
    const [match] = await this.db
      .select()
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!match) return null;

    const participants = await this.db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId));

    const [latestState] = await this.db
      .select()
      .from(gameStates)
      .where(eq(gameStates.matchId, matchId))
      .orderBy(desc(gameStates.stateVersion))
      .limit(1);

    return {
      match,
      participants,
      latestState: latestState ?? null,
    };
  }
}
