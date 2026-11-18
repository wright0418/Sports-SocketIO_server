import { randomUUID } from 'node:crypto';
import {
  ConnectionStatus,
  DeviceConnectionStatus,
  ErrorCode,
  PlatformError,
  PlayerRole,
  type DeviceState,
  type PlayerState,
} from '@edusports/shared';
import type { PersistenceService } from '../db/persistence.js';

export interface ClientInstanceSession {
  clientInstanceId: string;
  socketId: string | null;
  status: 'CONNECTED' | 'DISCONNECTED';
  lastSeenAt: number;
  playerIds: Set<string>;
  disconnectTimer: NodeJS.Timeout | null;
}

export class PlayerManager {
  private readonly clients = new Map<string, ClientInstanceSession>();
  private readonly players = new Map<string, PlayerState>();
  private readonly playerRoomMap = new Map<string, string>();
  private readonly devices = new Map<string, DeviceState>();

  constructor(
    private readonly maxLocalPlayersPerClient: number,
    private readonly disconnectGracePeriodMs: number,
    private readonly persistence: PersistenceService,
  ) {}

  registerClient(
    clientInstanceId: string,
    socketId: string,
  ): {
    session: ClientInstanceSession;
    reconnectedPlayers: Array<{
      playerId: string;
      roomId: string | null;
      disconnectedDurationMs: number;
    }>;
  } {
    const existing = this.clients.get(clientInstanceId);
    const now = Date.now();
    const reconnectedPlayers: Array<{
      playerId: string;
      roomId: string | null;
      disconnectedDurationMs: number;
    }> = [];

    if (existing) {
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }
      const wasDisconnected = existing.status === 'DISCONNECTED';
      existing.socketId = socketId;
      existing.status = 'CONNECTED';
      existing.lastSeenAt = now;

      for (const pid of existing.playerIds) {
        const p = this.players.get(pid);
        if (p) {
          const disconnectedDurationMs =
            wasDisconnected && p.disconnectedAt
              ? Math.max(0, now - p.disconnectedAt)
              : 0;
          p.connectionStatus = ConnectionStatus.CONNECTED;
          p.disconnectedAt = null;
          if (wasDisconnected) {
            reconnectedPlayers.push({
              playerId: pid,
              roomId: this.playerRoomMap.get(pid) ?? null,
              disconnectedDurationMs,
            });
          }
        }
      }

      void this.persistence.upsertClientInstance(clientInstanceId, 'CONNECTED').catch(() => {});
      return { session: existing, reconnectedPlayers };
    }

    const session: ClientInstanceSession = {
      clientInstanceId,
      socketId,
      status: 'CONNECTED',
      lastSeenAt: now,
      playerIds: new Set<string>(),
      disconnectTimer: null,
    };
    this.clients.set(clientInstanceId, session);
    void this.persistence.upsertClientInstance(clientInstanceId, 'CONNECTED').catch(() => {});
    return { session, reconnectedPlayers };
  }

  touchHeartbeat(clientInstanceId: string): void {
    const client = this.clients.get(clientInstanceId);
    if (client) {
      client.lastSeenAt = Date.now();
    }
  }

  getClient(clientInstanceId: string): ClientInstanceSession | undefined {
    return this.clients.get(clientInstanceId);
  }

  getSocketId(clientInstanceId: string): string | null {
    return this.clients.get(clientInstanceId)?.socketId ?? null;
  }

  addLocalPlayer(
    clientInstanceId: string,
    input: {
      playerId?: string;
      displayName: string;
      deviceId?: string | null;
      teamId?: string | null;
    },
  ): PlayerState {
    const client = this.clients.get(clientInstanceId);
    if (!client) {
      throw new PlatformError(
        ErrorCode.CLIENT_NOT_REGISTERED,
        'Client instance must register before adding local players',
      );
    }

    const playerId = input.playerId ?? `player-${randomUUID().slice(0, 8)}`;
    const existing = this.players.get(playerId);

    if (existing) {
      if (existing.clientInstanceId !== clientInstanceId) {
        throw new PlatformError(
          ErrorCode.PLAYER_NOT_OWNED,
          `Player ${playerId} belongs to another client instance`,
        );
      }
      existing.displayName = input.displayName;
      existing.deviceId = input.deviceId ?? existing.deviceId;
      existing.teamId = input.teamId ?? existing.teamId;
      existing.connectionStatus = ConnectionStatus.CONNECTED;
      void this.persistence.upsertUser(playerId, existing.displayName).catch(() => {});
      return existing;
    }

    if (client.playerIds.size >= this.maxLocalPlayersPerClient) {
      throw new PlatformError(
        ErrorCode.LOCAL_PLAYER_LIMIT_EXCEEDED,
        `Client instance cannot manage more than ${this.maxLocalPlayersPerClient} local players`,
        { maxLocalPlayersPerClient: this.maxLocalPlayersPerClient },
      );
    }

    const player: PlayerState = {
      playerId,
      clientInstanceId,
      displayName: input.displayName,
      role: PlayerRole.PLAYER,
      teamId: input.teamId ?? null,
      deviceId: input.deviceId ?? null,
      ready: false,
      connectionStatus: ConnectionStatus.CONNECTED,
      disconnectedAt: null,
      joinedAt: Date.now(),
    };

    this.players.set(playerId, player);
    client.playerIds.add(playerId);
    void this.persistence.upsertUser(playerId, player.displayName).catch(() => {});
    return player;
  }

  removeLocalPlayer(clientInstanceId: string, playerId: string): PlayerState {
    const player = this.assertPlayerOwned(clientInstanceId, playerId);
    const client = this.clients.get(clientInstanceId);
    client?.playerIds.delete(playerId);
    this.players.delete(playerId);
    this.playerRoomMap.delete(playerId);
    return player;
  }

  assertPlayerOwned(clientInstanceId: string, playerId: string): PlayerState {
    const player = this.players.get(playerId);
    if (!player) {
      throw new PlatformError(
        ErrorCode.PLAYER_NOT_FOUND,
        `Player "${playerId}" not found`,
      );
    }
    if (player.clientInstanceId !== clientInstanceId) {
      throw new PlatformError(
        ErrorCode.PLAYER_NOT_OWNED,
        `Client "${clientInstanceId}" does not own player "${playerId}"`,
      );
    }
    return player;
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.get(playerId);
  }

  getClientPlayers(clientInstanceId: string): PlayerState[] {
    const client = this.clients.get(clientInstanceId);
    if (!client) return [];
    const list: PlayerState[] = [];
    for (const pid of client.playerIds) {
      const p = this.players.get(pid);
      if (p) list.push(p);
    }
    return list;
  }

  setPlayerRoom(playerId: string, roomId: string | null): void {
    if (roomId === null) {
      this.playerRoomMap.delete(playerId);
    } else {
      this.playerRoomMap.set(playerId, roomId);
    }
  }

  getPlayerRoom(playerId: string): string | null {
    return this.playerRoomMap.get(playerId) ?? null;
  }

  getClientRoomIds(clientInstanceId: string): string[] {
    const roomIds = new Set<string>();
    for (const p of this.getClientPlayers(clientInstanceId)) {
      const rid = this.playerRoomMap.get(p.playerId);
      if (rid) roomIds.add(rid);
    }
    return Array.from(roomIds);
  }

  updateDeviceStatus(
    clientInstanceId: string,
    input: {
      deviceId: string;
      deviceType: string;
      connectionStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
      assignedPlayerId?: string | null;
      lastDataTimestamp?: number;
    },
  ): DeviceState {
    if (input.assignedPlayerId) {
      const player = this.assertPlayerOwned(clientInstanceId, input.assignedPlayerId);
      player.deviceId = input.deviceId;
    }

    const device: DeviceState = {
      deviceId: input.deviceId,
      deviceType: input.deviceType,
      connectionStatus: input.connectionStatus ?? DeviceConnectionStatus.UNKNOWN,
      assignedPlayerId: input.assignedPlayerId ?? null,
      localClientId: clientInstanceId,
      lastDataTimestamp: input.lastDataTimestamp ?? Date.now(),
    };

    this.devices.set(device.deviceId, device);
    void this.persistence.upsertDevice(device).catch(() => {});
    return device;
  }

  handleDisconnect(
    clientInstanceId: string,
    socketId: string,
    onGraceExpired: (clientInstanceId: string, playerIds: string[]) => void,
  ): { affectedPlayers: PlayerState[]; affectedRoomIds: string[] } {
    const client = this.clients.get(clientInstanceId);
    if (!client || client.socketId !== socketId) {
      return { affectedPlayers: [], affectedRoomIds: [] };
    }

    const now = Date.now();
    client.socketId = null;
    client.status = 'DISCONNECTED';

    const affectedPlayers: PlayerState[] = [];
    const affectedRoomIds = new Set<string>();

    for (const pid of client.playerIds) {
      const p = this.players.get(pid);
      if (p) {
        p.connectionStatus = ConnectionStatus.DISCONNECTED;
        p.disconnectedAt = now;
        affectedPlayers.push(p);
        const rid = this.playerRoomMap.get(pid);
        if (rid) affectedRoomIds.add(rid);
      }
    }

    void this.persistence.upsertClientInstance(clientInstanceId, 'DISCONNECTED').catch(() => {});

    if (client.disconnectTimer) {
      clearTimeout(client.disconnectTimer);
    }

    client.disconnectTimer = setTimeout(() => {
      const current = this.clients.get(clientInstanceId);
      if (!current || current.status === 'CONNECTED') return;
      const expiredPlayerIds = Array.from(current.playerIds);
      onGraceExpired(clientInstanceId, expiredPlayerIds);
    }, this.disconnectGracePeriodMs);
    client.disconnectTimer.unref();

    return {
      affectedPlayers,
      affectedRoomIds: Array.from(affectedRoomIds),
    };
  }

  clearAllTimers(): void {
    for (const client of this.clients.values()) {
      if (client.disconnectTimer) {
        clearTimeout(client.disconnectTimer);
        client.disconnectTimer = null;
      }
    }
  }
}
