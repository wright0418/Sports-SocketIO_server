import { io, type Socket } from 'socket.io-client';
import {
  ClientEvents,
  PROTOCOL_VERSION,
  ServerEvents,
  type AckError,
  type AckResponse,
  type DeviceState,
  type EventCategory,
  type EventEnvelope,
  type MatchResult,
  type MatchSnapshot,
  type PlayerState,
  type RoomSnapshot,
} from '@edusports/shared';

export interface EduSportsSdkOptions {
  serverUrl: string;
  modeId: string;
  version?: string;
  sdkVersion?: string;
  clientInstanceId?: string;
  ackTimeoutMs?: number;
  tickThrottleMs?: number;
  heartbeatIntervalMs?: number;
  autoReconnect?: boolean;
  offlineEventBufferEnabled?: boolean;
  tokenOverride?: string;
}

export class SdkError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    this.details = details;
  }
}

type EventListener = (payload: any) => void;

interface PendingTick {
  playerId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout> | null;
}

function generateUuid(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class EduSportsMultiplayer {
  private readonly options: Required<
    Omit<EduSportsSdkOptions, 'clientInstanceId' | 'tokenOverride'>
  > & {
    clientInstanceId?: string;
    tokenOverride?: string;
  };

  private socket: Socket | null = null;
  private token: string | null = null;
  private clientInstanceId: string | null = null;
  private maxLocalPlayers = 6;
  private serverTimeOffsetMs = 0;
  private lastRttMs = 0;

  private localPlayers = new Map<string, PlayerState>();
  private currentRoom: RoomSnapshot | null = null;
  private currentMatchId: string | null = null;
  private latestSnapshot: MatchSnapshot | null = null;

  private sequenceCounters = new Map<string, number>();
  private pendingTicks = new Map<string, PendingTick>();
  private lastTickSentAt = new Map<string, number>();
  private offlineQueue: Array<{
    playerId: string;
    eventType: string;
    category: EventCategory;
    payload: Record<string, unknown>;
    matchId: string;
    roomId: string;
    clientTimestamp: number;
  }> = [];

  private listeners = new Map<string, Set<EventListener>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private hasConnectedOnce = false;
  private intentionalDisconnect = false;
  private isConnectingExplicitly = false;

  constructor(options: EduSportsSdkOptions) {
    this.options = {
      serverUrl: options.serverUrl.replace(/\/+$/, ''),
      modeId: options.modeId,
      version: options.version ?? '1.0',
      sdkVersion: options.sdkVersion ?? '2.0.0',
      ackTimeoutMs: options.ackTimeoutMs ?? 5000,
      tickThrottleMs: options.tickThrottleMs ?? 200,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5000,
      autoReconnect: options.autoReconnect ?? true,
      offlineEventBufferEnabled: options.offlineEventBufferEnabled ?? true,
      clientInstanceId: options.clientInstanceId,
      tokenOverride: options.tokenOverride,
    };
    this.clientInstanceId = options.clientInstanceId ?? null;
  }

  getClientInstanceId(): string | null {
    return this.clientInstanceId;
  }

  getMaxLocalPlayers(): number {
    return this.maxLocalPlayers;
  }

  getLocalPlayers(): PlayerState[] {
    return Array.from(this.localPlayers.values());
  }

  getCurrentRoom(): RoomSnapshot | null {
    return this.currentRoom;
  }

  getCurrentMatchId(): string | null {
    return this.currentMatchId;
  }

  getLatestSnapshot(): MatchSnapshot | null {
    return this.latestSnapshot;
  }

  getClockOffsetMs(): number {
    return this.serverTimeOffsetMs;
  }

  getClockSyncInfo(): { offsetMs: number; rttMs: number } {
    return { offsetMs: this.serverTimeOffsetMs, rttMs: this.lastRttMs };
  }

  getServerNow(): number {
    return Math.round(Date.now() + this.serverTimeOffsetMs);
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected);
  }

  getRawSocket(): Socket | null {
    return this.socket;
  }

  on<T = any>(event: string, handler: (payload: T) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: EventListener): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emitLocal(event: string, payload: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(payload);
      } catch {
        // Keep SDK event loop resilient against listener exceptions
      }
    }
  }

  async connect(): Promise<{
    clientInstanceId: string;
    maxLocalPlayers: number;
    serverNow: number;
  }> {
    this.intentionalDisconnect = false;
    this.isConnectingExplicitly = true;

    try {
      if (this.options.tokenOverride) {
        this.token = this.options.tokenOverride;
        if (!this.clientInstanceId) {
          this.clientInstanceId = `client-${generateUuid().slice(0, 12)}`;
        }
      } else {
        await this.fetchSessionToken();
      }

      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      }

      const socket = io(this.options.serverUrl, {
        auth: { token: this.token },
        reconnection: this.options.autoReconnect,
        reconnectionDelay: 300,
        reconnectionDelayMax: 2000,
        transports: ['websocket', 'polling'],
      });
      this.socket = socket;
      this.bindServerEvents(socket);

      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off('connect_error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          socket.off('connect', onConnect);
          const [code, ...rest] = err.message.split(':');
          if (rest.length > 0 && code === code.toUpperCase()) {
            reject(new SdkError(code.trim(), rest.join(':').trim()));
          } else {
            reject(new SdkError('UNAUTHORIZED', err.message));
          }
        };
        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
      });

      const wasPreviouslyConnected = this.hasConnectedOnce;
      const reg = await this.performRegister();
      await this.syncClock();
      this.startHeartbeat();
      this.hasConnectedOnce = true;

      if (wasPreviouslyConnected && (this.currentRoom || this.currentMatchId)) {
        let restoredSnapshot: MatchSnapshot | null = null;
        try {
          restoredSnapshot = await this.requestGameState();
        } catch {
          restoredSnapshot = null;
        }
        const replayResults = await this.flushOfflineQueue();
        this.emitLocal('reconnected', { reg, restoredSnapshot, replayResults });
      }

      this.emitLocal('connected', reg);

      return {
        clientInstanceId: reg.clientInstanceId,
        maxLocalPlayers: reg.maxLocalPlayers,
        serverNow: reg.serverNow,
      };
    } finally {
      this.isConnectingExplicitly = false;
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    this.clearPendingTicks();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  async syncClock(): Promise<{ offsetMs: number; rttMs: number }> {
    const t0 = Date.now();
    const res = await this.emitWithAck<{ t0: number; serverNow: number }>(
      ClientEvents.CLIENT_HEARTBEAT,
      { t0 },
    );
    const t1 = Date.now();
    const rttMs = Math.max(0, t1 - t0);
    const offsetMs = res.serverNow - (t0 + rttMs / 2);
    this.lastRttMs = rttMs;
    this.serverTimeOffsetMs = offsetMs;
    this.emitLocal('clock:synced', { offsetMs, rttMs });
    return { offsetMs, rttMs };
  }

  async registerLocalPlayer(input: {
    playerId?: string;
    displayName: string;
    deviceId?: string | null;
    teamId?: string | null;
  }): Promise<PlayerState> {
    const res = await this.emitWithAck<{ player: PlayerState }>(
      ClientEvents.PLAYER_JOIN,
      input,
    );
    this.localPlayers.set(res.player.playerId, res.player);
    return res.player;
  }

  async removeLocalPlayer(playerId: string): Promise<PlayerState> {
    const res = await this.emitWithAck<{ player: PlayerState }>(
      ClientEvents.PLAYER_LEAVE,
      { playerId },
    );
    this.localPlayers.delete(playerId);
    return res.player;
  }

  async updateDeviceStatus(input: {
    deviceId: string;
    deviceType?: string;
    connectionStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
    assignedPlayerId?: string | null;
    lastDataTimestamp?: number;
  }): Promise<DeviceState> {
    const res = await this.emitWithAck<{ device: DeviceState }>(
      ClientEvents.DEVICE_STATUS,
      {
        deviceType: 'BLE_ROPE',
        ...input,
        lastDataTimestamp: input.lastDataTimestamp ?? Date.now(),
      },
    );
    return res.device;
  }

  async createRoom(options?: {
    gameModeId?: string;
    maxPlayers?: number;
    config?: Record<string, unknown>;
    playerIds?: string[];
  }): Promise<RoomSnapshot> {
    const res = await this.emitWithAck<{ room: RoomSnapshot }>(
      ClientEvents.ROOM_CREATE,
      {
        gameModeId: options?.gameModeId ?? this.options.modeId,
        maxPlayers: options?.maxPlayers,
        config: options?.config,
        playerIds: options?.playerIds,
      },
    );
    this.currentRoom = res.room;
    this.currentMatchId = res.room.activeMatchId;
    return res.room;
  }

  async joinRoom(
    roomCodeOrId: string,
    options?: { asSpectator?: boolean; playerIds?: string[] },
  ): Promise<{ room: RoomSnapshot; joinedPlayers: PlayerState[] }> {
    const res = await this.emitWithAck<{
      room: RoomSnapshot;
      joinedPlayers: PlayerState[];
    }>(ClientEvents.ROOM_JOIN, {
      roomCodeOrId,
      asSpectator: options?.asSpectator ?? false,
      playerIds: options?.playerIds,
    });
    this.currentRoom = res.room;
    this.currentMatchId = res.room.activeMatchId;
    return res;
  }

  async leaveRoom(): Promise<void> {
    await this.emitWithAck(ClientEvents.ROOM_LEAVE, {
      roomId: this.currentRoom?.roomId,
    });
    this.clearPendingTicks();
    this.currentRoom = null;
    this.currentMatchId = null;
    this.latestSnapshot = null;
  }

  async resetRoom(options?: {
    gameModeId?: string;
    config?: Record<string, unknown>;
  }): Promise<RoomSnapshot> {
    if (!this.currentRoom) {
      throw new SdkError('ROOM_NOT_FOUND', 'Not currently in a room');
    }
    this.clearPendingTicks();
    const res = await this.emitWithAck<{ room: RoomSnapshot }>(
      ClientEvents.ROOM_RESET,
      {
        roomId: this.currentRoom.roomId,
        gameModeId: options?.gameModeId,
        config: options?.config,
      },
    );
    this.currentRoom = res.room;
    this.currentMatchId = null;
    this.latestSnapshot = null;
    return res.room;
  }

  async setReady(playerId: string, ready = true): Promise<RoomSnapshot> {
    const res = await this.emitWithAck<{ room: RoomSnapshot }>(
      ClientEvents.PLAYER_READY,
      { playerId, ready },
    );
    this.currentRoom = res.room;
    return res.room;
  }

  async setAllLocalPlayersReady(ready = true): Promise<RoomSnapshot | null> {
    let latest: RoomSnapshot | null = null;
    for (const player of this.localPlayers.values()) {
      latest = await this.setReady(player.playerId, ready);
    }
    return latest;
  }

  async requestMatchStart(countdownMs = 1500): Promise<{
    matchId: string;
    room: RoomSnapshot;
    countdownMs: number;
  }> {
    if (!this.currentRoom) {
      throw new SdkError('ROOM_NOT_FOUND', 'Not currently in a room');
    }
    const res = await this.emitWithAck<{
      matchId: string;
      room: RoomSnapshot;
      countdownMs: number;
    }>(ClientEvents.MATCH_REQUEST_START, {
      roomId: this.currentRoom.roomId,
      countdownMs,
    });
    this.currentRoom = res.room;
    this.currentMatchId = res.matchId;
    return res;
  }

  async emitGameEvent(
    playerId: string,
    eventType: string,
    payload: Record<string, unknown>,
    options?: {
      category?: EventCategory;
      isOfflineReplay?: boolean;
      matchId?: string;
      roomId?: string;
    },
  ): Promise<{ matchId: string; accepted: boolean; stateVersion: number }> {
    const matchId = options?.matchId ?? this.currentMatchId;
    const roomId = options?.roomId ?? this.currentRoom?.roomId;
    if (!matchId || !roomId || !this.clientInstanceId) {
      throw new SdkError(
        'MATCH_NOT_PLAYING',
        'No active match or room associated with SDK instance',
      );
    }

    const category: EventCategory = options?.category ?? 'critical';

    if (!this.isConnected() && this.options.offlineEventBufferEnabled) {
      this.offlineQueue.push({
        playerId,
        eventType,
        category,
        payload,
        matchId,
        roomId,
        clientTimestamp: Date.now(),
      });
      return { matchId, accepted: false, stateVersion: -1 };
    }

    const envelope: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: generateUuid(),
      eventType,
      category,
      matchId,
      roomId,
      playerId,
      clientInstanceId: this.clientInstanceId,
      sequence: this.nextSequence(matchId, playerId),
      clientTimestamp: Date.now(),
      isOfflineReplay: options?.isOfflineReplay ?? false,
      payload,
    };

    return this.emitWithAck(ClientEvents.GAME_EVENT, envelope);
  }

  emitPlayerTick(
    playerId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const key = `${playerId}:${eventType}`;
    const now = Date.now();
    const lastSent = this.lastTickSentAt.get(key) ?? 0;
    const elapsed = now - lastSent;

    const existing = this.pendingTicks.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }

    if (elapsed >= this.options.tickThrottleMs) {
      this.pendingTicks.delete(key);
      this.lastTickSentAt.set(key, now);
      void this.emitGameEvent(playerId, eventType, payload, {
        category: 'telemetry',
      }).catch(() => {});
      return;
    }

    const waitMs = this.options.tickThrottleMs - elapsed;
    const pending: PendingTick = {
      playerId,
      eventType,
      payload,
      timer: setTimeout(() => {
        this.pendingTicks.delete(key);
        this.lastTickSentAt.set(key, Date.now());
        void this.emitGameEvent(playerId, eventType, pending.payload, {
          category: 'telemetry',
        }).catch(() => {});
      }, waitMs),
    };
    this.pendingTicks.set(key, pending);
  }

  async requestGameState(params?: {
    roomId?: string;
    matchId?: string;
  }): Promise<MatchSnapshot> {
    const res = await this.emitWithAck<{ snapshot: MatchSnapshot }>(
      ClientEvents.GAME_STATE_REQUEST,
      {
        roomId: params?.roomId ?? this.currentRoom?.roomId,
        matchId: params?.matchId ?? this.currentMatchId ?? undefined,
      },
    );
    this.latestSnapshot = res.snapshot;
    return res.snapshot;
  }

  private async fetchSessionToken(): Promise<void> {
    const response = await fetch(`${this.options.serverUrl}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientInstanceId: this.clientInstanceId ?? undefined,
        modeId: this.options.modeId,
      }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      clientInstanceId?: string;
      token?: string;
      maxLocalPlayers?: number;
      error?: AckError;
    };

    if (!response.ok || !data.ok || !data.token || !data.clientInstanceId) {
      throw new SdkError(
        data.error?.code ?? 'UNAUTHORIZED',
        data.error?.message ?? 'Failed to obtain session token',
      );
    }

    this.clientInstanceId = data.clientInstanceId;
    this.token = data.token;
    if (typeof data.maxLocalPlayers === 'number') {
      this.maxLocalPlayers = data.maxLocalPlayers;
    }
  }

  private async performRegister(): Promise<{
    clientInstanceId: string;
    maxLocalPlayers: number;
    players: PlayerState[];
    rejoinedRoomIds: string[];
    serverNow: number;
  }> {
    const res = await this.emitWithAck<{
      clientInstanceId: string;
      maxLocalPlayers: number;
      players: PlayerState[];
      rejoinedRoomIds: string[];
      serverNow: number;
    }>(ClientEvents.CLIENT_REGISTER, {
      clientInstanceId: this.clientInstanceId!,
      sdkVersion: this.options.sdkVersion,
      modeId: this.options.modeId,
    });
    this.maxLocalPlayers = res.maxLocalPlayers;
    return res;
  }

  private bindServerEvents(socket: Socket): void {
    socket.on('disconnect', (reason) => {
      this.emitLocal('disconnected', { reason });
    });

    socket.on('connect', () => {
      if (
        !this.hasConnectedOnce ||
        this.intentionalDisconnect ||
        this.isConnectingExplicitly
      ) {
        return;
      }
      void this.handleReconnect();
    });

    socket.on(ServerEvents.ROOM_UPDATED, (room: RoomSnapshot) => {
      this.currentRoom = room;
      if (room.activeMatchId) {
        this.currentMatchId = room.activeMatchId;
      }
      this.emitLocal(ServerEvents.ROOM_UPDATED, room);
    });

    socket.on(ServerEvents.MATCH_COUNTDOWN, (payload) => {
      if (payload?.matchId) {
        this.currentMatchId = payload.matchId;
      }
      this.emitLocal(ServerEvents.MATCH_COUNTDOWN, payload);
    });

    socket.on(ServerEvents.MATCH_START, (snapshot: MatchSnapshot) => {
      this.currentMatchId = snapshot.matchId;
      this.latestSnapshot = snapshot;
      this.emitLocal(ServerEvents.MATCH_START, snapshot);
    });

    socket.on(ServerEvents.GAME_STATE, (snapshot: MatchSnapshot) => {
      this.latestSnapshot = snapshot;
      this.emitLocal(ServerEvents.GAME_STATE, snapshot);
    });

    socket.on(ServerEvents.MATCH_FINISH, (payload) => {
      this.clearPendingTicks();
      this.emitLocal(ServerEvents.MATCH_FINISH, payload);
    });

    socket.on(ServerEvents.MATCH_RESULT, (result: MatchResult) => {
      this.clearPendingTicks();
      this.emitLocal(ServerEvents.MATCH_RESULT, result);
    });

    const passthroughEvents = [
      ServerEvents.CLIENT_REGISTERED,
      ServerEvents.PLAYER_JOINED,
      ServerEvents.PLAYER_LEFT,
      ServerEvents.PLAYER_DISCONNECTED,
      ServerEvents.PLAYER_RECONNECTED,
      ServerEvents.DEVICE_UPDATED,
      ServerEvents.GAME_EVENT,
      ServerEvents.SCORE_BROADCAST,
      ServerEvents.SERVER_ERROR,
    ];

    for (const evt of passthroughEvents) {
      socket.on(evt, (payload) => {
        this.emitLocal(evt, payload);
      });
    }
  }

  private async handleReconnect(): Promise<void> {
    try {
      const reg = await this.performRegister();
      await this.syncClock();

      let restoredSnapshot: MatchSnapshot | null = null;
      if (this.currentRoom || this.currentMatchId) {
        try {
          restoredSnapshot = await this.requestGameState();
        } catch {
          restoredSnapshot = null;
        }
      }

      const replayResults = await this.flushOfflineQueue();

      this.emitLocal('reconnected', {
        reg,
        restoredSnapshot,
        replayResults,
      });
    } catch (err) {
      this.emitLocal(ServerEvents.SERVER_ERROR, {
        code: err instanceof SdkError ? err.code : 'UNAUTHORIZED',
        message: err instanceof Error ? err.message : 'Reconnect failed',
      });
    }
  }

  private async flushOfflineQueue(): Promise<
    Array<{ eventType: string; accepted: boolean; error?: string }>
  > {
    const queued = this.offlineQueue.splice(0, this.offlineQueue.length);
    const replayResults: Array<{
      eventType: string;
      accepted: boolean;
      error?: string;
    }> = [];
    for (const item of queued) {
      try {
        await this.emitGameEvent(item.playerId, item.eventType, item.payload, {
          category: item.category,
          isOfflineReplay: true,
          matchId: item.matchId,
          roomId: item.roomId,
        });
        replayResults.push({ eventType: item.eventType, accepted: true });
      } catch (err) {
        replayResults.push({
          eventType: item.eventType,
          accepted: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return replayResults;
  }

  private emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || !socket.connected) {
      return Promise.reject(
        new SdkError('DISCONNECTED', 'Socket.IO is not connected'),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new SdkError(
            'ACK_TIMEOUT',
            `Request "${event}" timed out after ${this.options.ackTimeoutMs}ms`,
          ),
        );
      }, this.options.ackTimeoutMs);

      socket.emit(event, payload, (response: AckResponse<T>) => {
        clearTimeout(timer);
        if (!response) {
          reject(
            new SdkError(
              'INVALID_RESPONSE',
              `Empty ack received for "${event}"`,
            ),
          );
          return;
        }
        if (response.ok) {
          resolve(response.data);
        } else {
          reject(
            new SdkError(
              response.error.code,
              response.error.message,
              response.error.details,
            ),
          );
        }
      });
    });
  }

  private nextSequence(matchId: string, playerId: string): number {
    const key = `${matchId}:${playerId}`;
    const next = (this.sequenceCounters.get(key) ?? 0) + 1;
    this.sequenceCounters.set(key, next);
    return next;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected()) {
        void this.syncClock().catch(() => {});
      }
    }, this.options.heartbeatIntervalMs);
    if (typeof (this.heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (this.heartbeatTimer as { unref: () => void }).unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearPendingTicks(): void {
    for (const p of this.pendingTicks.values()) {
      if (p.timer) clearTimeout(p.timer);
    }
    this.pendingTicks.clear();
  }
}
