import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  PlatformError,
  PlayerRole,
  RoomState,
  type PlayerState,
  type RoomSnapshot,
  type RoomStateType,
  type TeamState,
} from '@edusports/shared';
import type { PersistenceService } from '../db/persistence.js';
import type { GameModeRegistry } from '../modes/registry.js';
import type { PlayerManager } from './PlayerManager.js';
import type { TeamManager } from './TeamManager.js';

export interface RoomRecord {
  roomId: string;
  roomCode: string;
  gameModeId: string;
  ownerClientInstanceId: string;
  ownerPlayerId: string | null;
  status: RoomStateType;
  maxPlayers: number;
  players: Map<string, PlayerState>;
  teams: TeamState[];
  activeMatchId: string | null;
  config: Record<string, unknown>;
  createdAt: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly roomCodeToId = new Map<string, string>();

  constructor(
    private readonly modeRegistry: GameModeRegistry,
    private readonly playerManager: PlayerManager,
    private readonly teamManager: TeamManager,
    private readonly persistence: PersistenceService,
  ) {}

  createRoom(
    clientInstanceId: string,
    params: {
      gameModeId: string;
      maxPlayers?: number;
      config?: Record<string, unknown>;
      playerIds?: string[];
    },
  ): RoomSnapshot {
    const modeMeta = this.modeRegistry.getMetadata(params.gameModeId);
    const localPlayers = this.resolveClientPlayersForRoom(
      clientInstanceId,
      params.playerIds,
    );

    if (localPlayers.length === 0) {
      throw new PlatformError(
        ErrorCode.INSUFFICIENT_PLAYERS,
        'Register at least one local player before creating a room',
      );
    }

    const roomId = `room-${randomUUID().slice(0, 8)}`;
    const roomCode = this.generateUniqueRoomCode();
    const maxPlayers = Math.min(
      params.maxPlayers ?? modeMeta.maxPlayers,
      modeMeta.maxPlayers,
    );

    if (localPlayers.length > maxPlayers) {
      throw new PlatformError(
        ErrorCode.ROOM_FULL,
        `Room maxPlayers (${maxPlayers}) cannot fit ${localPlayers.length} local players`,
      );
    }

    const playerMap = new Map<string, PlayerState>();
    for (const p of localPlayers) {
      p.role = PlayerRole.PLAYER;
      p.ready = false;
      playerMap.set(p.playerId, p);
      this.playerManager.setPlayerRoom(p.playerId, roomId);
    }

    const room: RoomRecord = {
      roomId,
      roomCode,
      gameModeId: params.gameModeId,
      ownerClientInstanceId: clientInstanceId,
      ownerPlayerId: localPlayers[0].playerId,
      status: RoomState.WAITING,
      maxPlayers,
      players: playerMap,
      teams: this.teamManager.buildTeamsFromPlayers(localPlayers),
      activeMatchId: null,
      config: { ...modeMeta.defaultConfig, ...(params.config ?? {}) },
      createdAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    this.roomCodeToId.set(roomCode, roomId);

    const snapshot = this.toSnapshot(room);
    void this.persistence.saveRoom(snapshot).catch(() => {});
    return snapshot;
  }

  joinRoom(
    clientInstanceId: string,
    params: {
      roomCodeOrId: string;
      asSpectator?: boolean;
      playerIds?: string[];
    },
  ): { room: RoomSnapshot; joinedPlayers: PlayerState[] } {
    const room = this.findRoomOrThrow(params.roomCodeOrId);
    if (room.status === RoomState.CLOSED) {
      throw new PlatformError(
        ErrorCode.ROOM_INVALID_STATE,
        'Cannot join a closed room',
      );
    }

    const localPlayers = this.resolveClientPlayersForRoom(
      clientInstanceId,
      params.playerIds,
    );
    if (localPlayers.length === 0) {
      throw new PlatformError(
        ErrorCode.INSUFFICIENT_PLAYERS,
        'Register at least one local player before joining a room',
      );
    }

    const activePlayerCount = this.getActiveParticipants(room).length;
    const isPlayingOrStarting =
      room.status === RoomState.PLAYING || room.status === RoomState.STARTING;
    const joinedPlayers: PlayerState[] = [];

    let assignedCount = 0;
    for (const p of localPlayers) {
      const alreadyInRoom = room.players.get(p.playerId);
      if (alreadyInRoom) {
        joinedPlayers.push(alreadyInRoom);
        continue;
      }

      const mustSpectate =
        Boolean(params.asSpectator) ||
        isPlayingOrStarting ||
        activePlayerCount + assignedCount >= room.maxPlayers;

      p.role = mustSpectate ? PlayerRole.SPECTATOR : PlayerRole.PLAYER;
      p.ready = false;
      if (!mustSpectate) {
        assignedCount += 1;
      }

      room.players.set(p.playerId, p);
      this.playerManager.setPlayerRoom(p.playerId, room.roomId);
      joinedPlayers.push(p);
    }

    this.refreshRoomReadyState(room);
    const snapshot = this.toSnapshot(room);
    void this.persistence.saveRoom(snapshot).catch(() => {});
    return { room: snapshot, joinedPlayers };
  }

  setPlayerReady(
    clientInstanceId: string,
    playerId: string,
    ready: boolean,
  ): RoomSnapshot {
    this.playerManager.assertPlayerOwned(clientInstanceId, playerId);
    const roomId = this.playerManager.getPlayerRoom(playerId);
    if (!roomId) {
      throw new PlatformError(
        ErrorCode.ROOM_NOT_FOUND,
        `Player "${playerId}" is not currently in a room`,
      );
    }
    const room = this.getRoomOrThrow(roomId);
    if (
      room.status !== RoomState.WAITING &&
      room.status !== RoomState.READY
    ) {
      throw new PlatformError(
        ErrorCode.ROOM_INVALID_STATE,
        `Cannot change ready status while room is in state "${room.status}"`,
      );
    }

    const roomPlayer = room.players.get(playerId);
    if (!roomPlayer) {
      throw new PlatformError(
        ErrorCode.PLAYER_NOT_FOUND,
        `Player "${playerId}" not found in room "${roomId}"`,
      );
    }

    roomPlayer.ready = ready;
    this.refreshRoomReadyState(room);

    const snapshot = this.toSnapshot(room);
    void this.persistence.updateRoomStatus(room.roomId, room.status).catch(() => {});
    return snapshot;
  }

  leaveRoom(
    clientInstanceId: string,
    roomId?: string,
    specificPlayerId?: string,
  ): { room: RoomSnapshot; removedPlayerIds: string[] } | null {
    const targetRoomIds = roomId
      ? [roomId]
      : this.playerManager.getClientRoomIds(clientInstanceId);

    if (targetRoomIds.length === 0) return null;
    const room = this.getRoomOrThrow(targetRoomIds[0]);
    const removedPlayerIds: string[] = [];

    for (const [pid, player] of room.players.entries()) {
      if (player.clientInstanceId !== clientInstanceId) continue;
      if (specificPlayerId && pid !== specificPlayerId) continue;
      room.players.delete(pid);
      this.playerManager.setPlayerRoom(pid, null);
      removedPlayerIds.push(pid);
    }

    if (room.players.size === 0) {
      room.status = RoomState.CLOSED;
      const snapshot = this.toSnapshot(room);
      void this.persistence.saveRoom(snapshot).catch(() => {});
      return { room: snapshot, removedPlayerIds };
    }

    if (
      room.ownerClientInstanceId === clientInstanceId &&
      !Array.from(room.players.values()).some(
        (p) => p.clientInstanceId === clientInstanceId,
      )
    ) {
      const nextOwner = Array.from(room.players.values())[0];
      room.ownerClientInstanceId = nextOwner.clientInstanceId;
      room.ownerPlayerId = nextOwner.playerId;
    }

    this.refreshRoomReadyState(room);
    const snapshot = this.toSnapshot(room);
    void this.persistence.saveRoom(snapshot).catch(() => {});
    return { room: snapshot, removedPlayerIds };
  }

  resetRoom(
    clientInstanceId: string,
    params: {
      roomId: string;
      gameModeId?: string;
      config?: Record<string, unknown>;
    },
  ): RoomSnapshot {
    const room = this.getRoomOrThrow(params.roomId);
    if (room.ownerClientInstanceId !== clientInstanceId) {
      throw new PlatformError(
        ErrorCode.NOT_ROOM_OWNER,
        'Only the room owner can reset the room for a rematch',
      );
    }
    if (
      room.status !== RoomState.FINISHED &&
      room.status !== RoomState.WAITING &&
      room.status !== RoomState.READY
    ) {
      throw new PlatformError(
        ErrorCode.ROOM_INVALID_STATE,
        `Cannot reset room in state "${room.status}"`,
      );
    }

    if (params.gameModeId) {
      const modeMeta = this.modeRegistry.getMetadata(params.gameModeId);
      room.gameModeId = params.gameModeId;
      room.maxPlayers = Math.min(room.maxPlayers, modeMeta.maxPlayers);
      room.config = { ...modeMeta.defaultConfig, ...(params.config ?? {}) };
    } else if (params.config) {
      room.config = { ...room.config, ...params.config };
    }

    room.activeMatchId = null;
    room.status = RoomState.WAITING;
    for (const p of room.players.values()) {
      p.ready = false;
    }

    const snapshot = this.toSnapshot(room);
    void this.persistence.saveRoom(snapshot).catch(() => {});
    return snapshot;
  }

  validateStartConditions(
    clientInstanceId: string,
    roomId: string,
  ): { room: RoomRecord; participants: PlayerState[] } {
    const room = this.getRoomOrThrow(roomId);
    if (room.ownerClientInstanceId !== clientInstanceId) {
      throw new PlatformError(
        ErrorCode.NOT_ROOM_OWNER,
        'Only the room owner can start the match',
      );
    }
    if (
      room.status !== RoomState.WAITING &&
      room.status !== RoomState.READY
    ) {
      throw new PlatformError(
        ErrorCode.ROOM_INVALID_STATE,
        `Room is currently in "${room.status}" state`,
      );
    }

    const modeMeta = this.modeRegistry.getMetadata(room.gameModeId);
    const participants = this.getActiveParticipants(room);

    if (participants.length < modeMeta.minPlayers) {
      throw new PlatformError(
        ErrorCode.INSUFFICIENT_PLAYERS,
        `Mode "${modeMeta.modeId}" requires at least ${modeMeta.minPlayers} players (currently ${participants.length})`,
      );
    }

    const unready = participants.filter((p) => !p.ready);
    if (unready.length > 0) {
      throw new PlatformError(
        ErrorCode.PLAYERS_NOT_READY,
        `Not all players are ready: ${unready.map((u) => u.displayName).join(', ')}`,
      );
    }

    return { room, participants };
  }

  setRoomMatchState(
    roomId: string,
    status: RoomStateType,
    activeMatchId: string | null,
  ): RoomSnapshot {
    const room = this.getRoomOrThrow(roomId);
    room.status = status;
    room.activeMatchId = activeMatchId;
    const snapshot = this.toSnapshot(room);
    void this.persistence.updateRoomStatus(roomId, status).catch(() => {});
    return snapshot;
  }

  getRoom(roomCodeOrId: string): RoomRecord | undefined {
    const byId = this.rooms.get(roomCodeOrId);
    if (byId) return byId;
    const mappedId = this.roomCodeToId.get(roomCodeOrId.toUpperCase());
    return mappedId ? this.rooms.get(mappedId) : undefined;
  }

  getRoomOrThrow(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new PlatformError(
        ErrorCode.ROOM_NOT_FOUND,
        `Room "${roomId}" not found`,
      );
    }
    return room;
  }

  findRoomOrThrow(roomCodeOrId: string): RoomRecord {
    const room = this.getRoom(roomCodeOrId);
    if (!room) {
      throw new PlatformError(
        ErrorCode.ROOM_NOT_FOUND,
        `Room "${roomCodeOrId}" not found`,
      );
    }
    return room;
  }

  listRooms(): RoomSnapshot[] {
    return Array.from(this.rooms.values())
      .filter((r) => r.status !== RoomState.CLOSED)
      .map((r) => this.toSnapshot(r));
  }

  getActiveParticipants(room: RoomRecord): PlayerState[] {
    return Array.from(room.players.values()).filter(
      (p) => p.role === PlayerRole.PLAYER,
    );
  }

  toSnapshot(room: RoomRecord): RoomSnapshot {
    const players = Array.from(room.players.values()).map((p) => ({ ...p }));
    room.teams = this.teamManager.buildTeamsFromPlayers(
      players.filter((p) => p.role === PlayerRole.PLAYER),
    );
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      gameModeId: room.gameModeId,
      ownerClientInstanceId: room.ownerClientInstanceId,
      ownerPlayerId: room.ownerPlayerId,
      status: room.status,
      maxPlayers: room.maxPlayers,
      players,
      teams: room.teams,
      activeMatchId: room.activeMatchId,
      config: room.config,
      createdAt: room.createdAt,
    };
  }

  private resolveClientPlayersForRoom(
    clientInstanceId: string,
    requestedPlayerIds?: string[],
  ): PlayerState[] {
    if (requestedPlayerIds && requestedPlayerIds.length > 0) {
      return requestedPlayerIds.map((pid) =>
        this.playerManager.assertPlayerOwned(clientInstanceId, pid),
      );
    }
    return this.playerManager.getClientPlayers(clientInstanceId);
  }

  private refreshRoomReadyState(room: RoomRecord): void {
    if (
      room.status !== RoomState.WAITING &&
      room.status !== RoomState.READY
    ) {
      return;
    }
    const modeMeta = this.modeRegistry.getMetadata(room.gameModeId);
    const participants = this.getActiveParticipants(room);
    const allReady =
      participants.length >= modeMeta.minPlayers &&
      participants.every((p) => p.ready);
    room.status = allReady ? RoomState.READY : RoomState.WAITING;
  }

  private generateUniqueRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      if (!this.roomCodeToId.has(code)) {
        return code;
      }
    }
    return randomUUID().slice(0, 6).toUpperCase();
  }
}
