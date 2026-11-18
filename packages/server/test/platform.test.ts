import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ClientEvents,
  ErrorCode,
  MatchState,
  PROTOCOL_VERSION,
  RoomState,
  ServerEvents,
  type AckResponse,
  type MatchResult,
  type MatchSnapshot,
} from '@edusports/shared';
import { EduSportsMultiplayer, SdkError } from '@edusports/sdk';
import { createPlatformServer, type PlatformServer } from '../src/app.js';

function waitForEvent<T = unknown>(
  sdk: EduSportsMultiplayer,
  event: string,
  predicate?: (payload: T) => boolean,
  timeoutMs = 10000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);

    const off = sdk.on<T>(event, (payload) => {
      if (!predicate || predicate(payload)) {
        clearTimeout(timer);
        off();
        resolve(payload);
      }
    });
  });
}

function rawEmitAck<T = unknown>(
  sdk: EduSportsMultiplayer,
  event: string,
  payload: unknown,
): Promise<AckResponse<T>> {
  const socket = sdk.getRawSocket();
  if (!socket) throw new Error('No underlying socket');
  return new Promise<AckResponse<T>>((resolve) => {
    socket.emit(event, payload, (res: AckResponse<T>) => resolve(res));
  });
}

describe('EduSports V2.0 Competition Server & SDK Integration', () => {
  let server: PlatformServer;
  let serverUrl: string;
  const activeClients: EduSportsMultiplayer[] = [];

  const trackClient = (client: EduSportsMultiplayer): EduSportsMultiplayer => {
    activeClients.push(client);
    return client;
  };

  beforeAll(async () => {
    server = createPlatformServer({
      port: 0, // ephemeral free port for test suite
      disconnectGracePeriodMs: 30000,
      scoreBroadcastIntervalMs: 100,
      matchTickIntervalMs: 50,
    });
    const port = await server.start();
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    while (activeClients.length > 0) {
      const c = activeClients.pop();
      c?.disconnect();
    }
  });

  afterAll(async () => {
    await server.stop();
  });

  it('1. Auth session, clock sync, 1-6 local players multiplexing, and 7th player limit', async () => {
    const sdk = trackClient(
      new EduSportsMultiplayer({
        serverUrl,
        modeId: 'multiplayer',
      }),
    );

    const conn = await sdk.connect();
    expect(conn.clientInstanceId).toBeTruthy();
    expect(conn.maxLocalPlayers).toBe(6);

    const clock = await sdk.syncClock();
    expect(clock.rttMs).toBeGreaterThanOrEqual(0);
    expect(Math.abs(sdk.getServerNow() - Date.now())).toBeLessThan(5000);

    // Register 6 local players + BLE devices
    for (let i = 1; i <= 6; i++) {
      const p = await sdk.registerLocalPlayer({
        displayName: `LocalPlayer_${i}`,
        deviceId: `Rope_000${i}`,
      });
      expect(p.playerId).toBeTruthy();

      const dev = await sdk.updateDeviceStatus({
        deviceId: `Rope_000${i}`,
        connectionStatus: 'CONNECTED',
        assignedPlayerId: p.playerId,
      });
      expect(dev.assignedPlayerId).toBe(p.playerId);
    }

    expect(sdk.getLocalPlayers()).toHaveLength(6);

    // 7th local player must fail with LOCAL_PLAYER_LIMIT_EXCEEDED
    await expect(
      sdk.registerLocalPlayer({
        displayName: 'LocalPlayer_7',
        deviceId: 'Rope_0007',
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.LOCAL_PLAYER_LIMIT_EXCEEDED,
    });
  });

  it('2. Full multiplayer match lifecycle across 2 clients + DB persistence', async () => {
    const host = trackClient(
      new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer', tickThrottleMs: 50 }),
    );
    const guest = trackClient(
      new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer', tickThrottleMs: 50 }),
    );

    await host.connect();
    await guest.connect();

    const p1 = await host.registerLocalPlayer({ displayName: 'Alice', deviceId: 'Rope_A1' });
    const p2 = await host.registerLocalPlayer({ displayName: 'Bob', deviceId: 'Rope_A2' });
    const p3 = await guest.registerLocalPlayer({ displayName: 'Charlie', deviceId: 'Rope_B1' });

    const room = await host.createRoom({
      gameModeId: 'multiplayer',
      config: { durationMs: 1200, scorePerJump: 10 },
    });
    expect(room.status).toBe(RoomState.WAITING);

    const joined = await guest.joinRoom(room.roomCode);
    expect(joined.room.players).toHaveLength(3);

    await host.setAllLocalPlayersReady(true);
    const readyRoom = await guest.setReady(p3.playerId, true);
    expect(readyRoom.status).toBe(RoomState.READY);

    const startPromise = waitForEvent<MatchSnapshot>(guest, ServerEvents.MATCH_START);
    const resultPromise = waitForEvent<MatchResult>(host, ServerEvents.MATCH_RESULT);

    const startRes = await host.requestMatchStart(200);
    const startedSnapshot = await startPromise;
    expect(startedSnapshot.matchId).toBe(startRes.matchId);
    expect(startedSnapshot.status).toBe(MatchState.PLAYING);

    // Emit jump ticks from all 3 players
    await host.emitGameEvent(
      p1.playerId,
      'jump:tick',
      { totalJumps: 10, deltaJumps: 10, rpm: 140, energy: 20 },
      { category: 'telemetry' },
    );
    await host.emitGameEvent(
      p2.playerId,
      'jump:tick',
      { totalJumps: 5, deltaJumps: 5, rpm: 110, energy: 10 },
      { category: 'telemetry' },
    );
    await guest.emitGameEvent(
      p3.playerId,
      'jump:tick',
      { totalJumps: 15, deltaJumps: 15, rpm: 165, energy: 30 },
      { category: 'telemetry' },
    );

    const result = await resultPromise;
    expect(result.matchId).toBe(startRes.matchId);
    expect(result.reason).toBe('TIME_UP');
    expect(result.winnerPlayerIds).toEqual([p3.playerId]);
    expect(result.participants[0].finalScore).toBe(150);
    expect(result.participants[1].playerId).toBe(p1.playerId);
    expect(result.participants[2].playerId).toBe(p2.playerId);

    // Verify PostgreSQL persistence via REST API and PersistenceService
    const persisted = await server.persistence.getMatchRecord(result.matchId);
    expect(persisted).not.toBeNull();
    expect(persisted!.match.status).toBe('FINISHED');
    expect(persisted!.participants).toHaveLength(3);
    expect(persisted!.latestState).not.toBeNull();
  });

  it('3. Full bomb-pass match lifecycle: jump, pass, fuse explosion & DB critical events', async () => {
    const c1 = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'bomb-pass' }));
    const c2 = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'bomb-pass' }));

    await c1.connect();
    await c2.connect();

    const p1 = await c1.registerLocalPlayer({ displayName: 'BombP1', deviceId: 'Rope_P1' });
    const p2 = await c2.registerLocalPlayer({ displayName: 'BombP2', deviceId: 'Rope_P2' });

    const room = await c1.createRoom({
      gameModeId: 'bomb-pass',
      config: { durationMs: 20000, fuseDurationMs: 1000, jumpsRequiredToPass: 3 },
    });
    await c2.joinRoom(room.roomCode);

    await c1.setReady(p1.playerId, true);
    await c2.setReady(p2.playerId, true);

    const startPromise = waitForEvent<MatchSnapshot>(c1, ServerEvents.MATCH_START);
    const resultPromise = waitForEvent<MatchResult>(c1, ServerEvents.MATCH_RESULT);

    await c1.requestMatchStart(100);
    const startSnap = await startPromise;
    expect(startSnap.modeState.bombHolderPlayerId).toBe(p1.playerId);

    // p1 tries to pass before 3 jumps -> INVALID_GAME_ACTION
    await expect(
      c1.emitGameEvent(p1.playerId, 'bomb:pass', {}, { category: 'critical' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_GAME_ACTION });

    // p1 jumps 3 times and passes bomb to p2
    await c1.emitGameEvent(p1.playerId, 'bomb:jump', { deltaJumps: 3, rpm: 130 }, { category: 'telemetry' });

    const passStatePromise = waitForEvent<MatchSnapshot>(
      c2,
      ServerEvents.GAME_STATE,
      (s) => s.modeState.bombHolderPlayerId === p2.playerId,
    );
    await c1.emitGameEvent(p1.playerId, 'bomb:pass', { targetPlayerId: p2.playerId }, { category: 'critical' });
    const afterPass = await passStatePromise;
    expect(afterPass.modeState.bombHolderPlayerId).toBe(p2.playerId);

    // Let fuse (1000ms) expire on p2 -> p2 eliminated, p1 wins!
    const result = await resultPromise;
    expect(result.reason).toBe('LAST_SURVIVOR');
    expect(result.winnerPlayerIds).toEqual([p1.playerId]);

    // Flush and verify critical bomb:pass event was written to PostgreSQL
    await server.persistence.flushEvents();
    const evRows = await server.db.pool.query(
      'SELECT event_type, player_id FROM game_events WHERE match_id = $1',
      [result.matchId],
    );
    expect(evRows.rows.some((r) => r.event_type === 'bomb:pass' && r.player_id === p1.playerId)).toBe(true);
  });

  it('4. Web Bluetooth continuous session: room:reset allows rematch without disconnecting', async () => {
    const host = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer' }));
    await host.connect();
    const p1 = await host.registerLocalPlayer({ displayName: 'SoloRematch', deviceId: 'Rope_Solo' });

    const room = await host.createRoom({
      gameModeId: 'multiplayer',
      config: { durationMs: 400 },
    });
    await host.setReady(p1.playerId, true);

    const firstFinish = waitForEvent<MatchResult>(host, ServerEvents.MATCH_RESULT);
    const m1 = await host.requestMatchStart(50);
    await firstFinish;

    // Reset room without disconnecting socket or re-registering local player
    const resetRoom = await host.resetRoom({
      gameModeId: 'multiplayer',
      config: { durationMs: 400 },
    });
    expect(resetRoom.status).toBe(RoomState.WAITING);
    expect(resetRoom.activeMatchId).toBeNull();
    expect(host.getLocalPlayers()).toHaveLength(1);

    await host.setReady(p1.playerId, true);
    const secondFinish = waitForEvent<MatchResult>(host, ServerEvents.MATCH_RESULT);
    const m2 = await host.requestMatchStart(50);
    expect(m2.matchId).not.toBe(m1.matchId);
    const res2 = await secondFinish;
    expect(res2.matchId).toBe(m2.matchId);
  });

  it('5. Network disconnect & reconnect within 30s grace period restores snapshot and applies mode offline policy', async () => {
    const c1 = trackClient(
      new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer', offlineEventBufferEnabled: true }),
    );
    const c2 = trackClient(
      new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer' }),
    );

    await c1.connect();
    await c2.connect();

    const p1 = await c1.registerLocalPlayer({ displayName: 'ReconnectP1' });
    const p2 = await c2.registerLocalPlayer({ displayName: 'StayP2' });

    const room = await c1.createRoom({
      gameModeId: 'multiplayer',
      config: { durationMs: 8000, maxJumpsPerSecond: 12 },
    });
    await c2.joinRoom(room.roomCode);
    await c1.setReady(p1.playerId, true);
    await c2.setReady(p2.playerId, true);

    const started = waitForEvent<MatchSnapshot>(c1, ServerEvents.MATCH_START);
    await c1.requestMatchStart(50);
    await started;

    // Simulate c1 dropping network
    const disconnectedNotice = waitForEvent(c2, ServerEvents.PLAYER_DISCONNECTED);
    c1.disconnect();
    await disconnectedNotice;

    // Wait 1100ms while offline so offline window > 1s, queue offline jump event on SDK
    await new Promise((r) => setTimeout(r, 1100));
    await c1.emitGameEvent(
      p1.playerId,
      'jump:tick',
      { totalJumps: 8, deltaJumps: 8, rpm: 120, energy: 10 },
      { category: 'telemetry' },
    );

    // Reconnect c1 using same clientInstanceId
    const reconnectedEvt = waitForEvent<{
      restoredSnapshot: MatchSnapshot | null;
      replayResults: Array<{ accepted: boolean }>;
    }>(c1, 'reconnected');
    await c1.connect();
    const rec = await reconnectedEvt;

    expect(rec.restoredSnapshot).not.toBeNull();
    expect(rec.restoredSnapshot!.status).toBe(MatchState.PLAYING);
    expect(rec.replayResults).toHaveLength(1);
    expect(rec.replayResults[0].accepted).toBe(true);

    // Now test bomb-pass rejects offline replay
    const bombC1 = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'bomb-pass' }));
    const bombC2 = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'bomb-pass' }));
    await bombC1.connect();
    await bombC2.connect();
    const bp1 = await bombC1.registerLocalPlayer({ displayName: 'BP1' });
    const bp2 = await bombC2.registerLocalPlayer({ displayName: 'BP2' });
    const bRoom = await bombC1.createRoom({
      gameModeId: 'bomb-pass',
      config: { durationMs: 10000, fuseDurationMs: 8000, jumpsRequiredToPass: 1 },
    });
    await bombC2.joinRoom(bRoom.roomCode);
    await bombC1.setReady(bp1.playerId, true);
    await bombC2.setReady(bp2.playerId, true);

    const bombStart = waitForEvent<MatchSnapshot>(bombC1, ServerEvents.MATCH_START);
    await bombC1.requestMatchStart(50);
    await bombStart;

    await expect(
      bombC1.emitGameEvent(
        bp1.playerId,
        'bomb:jump',
        { deltaJumps: 1, rpm: 100 },
        { category: 'telemetry', isOfflineReplay: true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.OFFLINE_REPLAY_REJECTED });
  });

  it('6. Security test suite: invalid/expired JWT, spoofing, dedup, sequence, spectator, rate limit, post-match', async () => {
    // 6a. Expired JWT rejected on socket handshake
    const expiredToken = jwt.sign(
      { clientInstanceId: 'expired-client', allowedModeIds: ['*'], origin: '*', jti: '1' },
      server.config.jwtSecret,
      { expiresIn: -10 },
    );
    const badSdk = trackClient(
      new EduSportsMultiplayer({
        serverUrl,
        modeId: 'multiplayer',
        clientInstanceId: 'expired-client',
        tokenOverride: expiredToken,
        autoReconnect: false,
      }),
    );
    await expect(badSdk.connect()).rejects.toMatchObject({
      code: ErrorCode.TOKEN_EXPIRED,
    });

    // Setup valid host, valid guest, and spectator
    const host = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer' }));
    const guest = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer' }));
    const spectator = trackClient(new EduSportsMultiplayer({ serverUrl, modeId: 'multiplayer' }));

    await host.connect();
    await guest.connect();
    await spectator.connect();

    const p1 = await host.registerLocalPlayer({ displayName: 'SecHost' });
    const p2 = await guest.registerLocalPlayer({ displayName: 'SecGuest' });
    const pSpec = await spectator.registerLocalPlayer({ displayName: 'SecSpectator' });

    const room = await host.createRoom({
      gameModeId: 'multiplayer',
      config: { durationMs: 5000, maxJumpsPerSecond: 10 },
    });
    await guest.joinRoom(room.roomCode);
    await spectator.joinRoom(room.roomCode, { asSpectator: true });

    await host.setReady(p1.playerId, true);
    await guest.setReady(p2.playerId, true);

    const startEvt = waitForEvent<MatchSnapshot>(host, ServerEvents.MATCH_START);
    const { matchId } = await host.requestMatchStart(50);
    await startEvt;

    // 6b. Cross-client playerId spoofing (guest attempts to send event as host's p1)
    const spoofAck = await rawEmitAck(guest, ClientEvents.GAME_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      eventType: 'jump:tick',
      category: 'telemetry',
      matchId,
      roomId: room.roomId,
      playerId: p1.playerId,
      clientInstanceId: guest.getClientInstanceId()!,
      sequence: 1,
      clientTimestamp: Date.now(),
      payload: { totalJumps: 5, deltaJumps: 5, rpm: 100 },
    });
    expect(spoofAck.ok).toBe(false);
    if (!spoofAck.ok) expect(spoofAck.error.code).toBe(ErrorCode.PLAYER_NOT_OWNED);

    // 6c. Spectator cannot emit game events
    await expect(
      spectator.emitGameEvent(
        pSpec.playerId,
        'jump:tick',
        { totalJumps: 5, deltaJumps: 5, rpm: 100 },
        { category: 'telemetry', matchId, roomId: room.roomId },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SPECTATOR_CANNOT_EMIT });

    // 6d. Duplicate eventId rejected
    const sharedEventId = randomUUID();
    const firstAck = await rawEmitAck(host, ClientEvents.GAME_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      eventId: sharedEventId,
      eventType: 'jump:tick',
      category: 'telemetry',
      matchId,
      roomId: room.roomId,
      playerId: p1.playerId,
      clientInstanceId: host.getClientInstanceId()!,
      sequence: 1,
      clientTimestamp: Date.now(),
      payload: { totalJumps: 2, deltaJumps: 2, rpm: 100 },
    });
    expect(firstAck.ok).toBe(true);

    const dupAck = await rawEmitAck(host, ClientEvents.GAME_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      eventId: sharedEventId,
      eventType: 'jump:tick',
      category: 'telemetry',
      matchId,
      roomId: room.roomId,
      playerId: p1.playerId,
      clientInstanceId: host.getClientInstanceId()!,
      sequence: 2,
      clientTimestamp: Date.now(),
      payload: { totalJumps: 4, deltaJumps: 2, rpm: 100 },
    });
    expect(dupAck.ok).toBe(false);
    if (!dupAck.ok) expect(dupAck.error.code).toBe(ErrorCode.DUPLICATE_EVENT);

    // 6e. Non-increasing sequence rejected (sequence 1 <= last accepted 1)
    const seqAck = await rawEmitAck(host, ClientEvents.GAME_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      eventType: 'jump:tick',
      category: 'telemetry',
      matchId,
      roomId: room.roomId,
      playerId: p1.playerId,
      clientInstanceId: host.getClientInstanceId()!,
      sequence: 1,
      clientTimestamp: Date.now(),
      payload: { totalJumps: 4, deltaJumps: 2, rpm: 100 },
    });
    expect(seqAck.ok).toBe(false);
    if (!seqAck.ok) expect(seqAck.error.code).toBe(ErrorCode.INVALID_SEQUENCE);

    // 6f. Illegal jump rate (500 jumps in 1s) rejected
    const cheatAck = await rawEmitAck(host, ClientEvents.GAME_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      eventType: 'jump:tick',
      category: 'telemetry',
      matchId,
      roomId: room.roomId,
      playerId: p1.playerId,
      clientInstanceId: host.getClientInstanceId()!,
      sequence: 2,
      clientTimestamp: Date.now(),
      payload: { totalJumps: 502, deltaJumps: 500, rpm: 300 },
    });
    expect(cheatAck.ok).toBe(false);
    if (!cheatAck.ok) expect(cheatAck.error.code).toBe(ErrorCode.INVALID_GAME_ACTION);

    // 6g. Post-match event rejected (finish match early and try sending event)
    await server.matchManager.finishMatch(matchId, 'TEST_FORCE_FINISH');
    const postAck = await rawEmitAck(host, ClientEvents.GAME_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      eventType: 'jump:tick',
      category: 'telemetry',
      matchId,
      roomId: room.roomId,
      playerId: p1.playerId,
      clientInstanceId: host.getClientInstanceId()!,
      sequence: 3,
      clientTimestamp: Date.now(),
      payload: { totalJumps: 5, deltaJumps: 3, rpm: 120 },
    });
    expect(postAck.ok).toBe(false);
    if (!postAck.ok) expect(postAck.error.code).toBe(ErrorCode.MATCH_NOT_FOUND);
  });
});
