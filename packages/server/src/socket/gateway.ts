import {
  ClientEvents,
  ClientHeartbeatSchema,
  ClientRegisterSchema,
  DeviceStatusSchema,
  ErrorCode,
  GameStateRequestSchema,
  MatchRequestStartSchema,
  PlatformError,
  PlayerJoinSchema,
  PlayerLeaveSchema,
  PlayerReadySchema,
  RoomCreateSchema,
  RoomJoinSchema,
  RoomLeaveSchema,
  RoomResetSchema,
  ServerEvents,
  fail,
  ok,
  type AckResponse,
} from '@edusports/shared';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { z } from 'zod';
import { verifySessionToken, type SessionClaims } from '../auth/jwt.js';
import type { ServerConfig } from '../config/index.js';
import type { MatchManager } from '../managers/MatchManager.js';
import type { PlayerManager } from '../managers/PlayerManager.js';
import type { RoomManager } from '../managers/RoomManager.js';

interface SocketData {
  clientInstanceId: string;
  claims: SessionClaims;
}

type AckFn<T = unknown> = (response: AckResponse<T>) => void;

function parseWithAck<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  raw: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new PlatformError(
      ErrorCode.INVALID_PAYLOAD,
      'Payload validation failed',
      result.error.flatten(),
    );
  }
  return result.data;
}

function replyError<T>(
  socket: Socket,
  ack: AckFn<T> | undefined,
  err: unknown,
): void {
  const ackPayload =
    err instanceof PlatformError
      ? err.toAck()
      : fail(
          ErrorCode.INTERNAL_ERROR,
          err instanceof Error ? err.message : 'Unexpected server error',
        );

  if (typeof ack === 'function') {
    ack(ackPayload as AckResponse<T>);
  } else if (!ackPayload.ok) {
    socket.emit(ServerEvents.SERVER_ERROR, ackPayload.error);
  }
}

export function attachSocketGateway(deps: {
  io: SocketIOServer;
  config: ServerConfig;
  playerManager: PlayerManager;
  roomManager: RoomManager;
  matchManager: MatchManager;
}): void {
  const { io, config, playerManager, roomManager, matchManager } = deps;

  const broadcastLobbyRooms = () => {
    io.to('lobby').emit(ServerEvents.ROOMS_UPDATED, {
      rooms: roomManager.listPublicRooms(),
    });
  };

  // JWT Authentication Middleware on Socket.IO handshake
  io.use((socket, next) => {
    try {
      const token =
        typeof socket.handshake.auth?.token === 'string'
          ? socket.handshake.auth.token
          : '';
      if (!token) {
        return next(
          new Error(`${ErrorCode.UNAUTHORIZED}: Missing authentication token`),
        );
      }

      const claims = verifySessionToken(config.jwtSecret, token);
      (socket.data as SocketData).clientInstanceId = claims.clientInstanceId;
      (socket.data as SocketData).claims = claims;
      next();
    } catch (err) {
      if (err instanceof PlatformError) {
        return next(new Error(`${err.code}: ${err.message}`));
      }
      next(new Error(`${ErrorCode.UNAUTHORIZED}: Authentication failed`));
    }
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    const clientInstanceId = data.clientInstanceId;

    const handleAsync = <T>(
      ack: AckFn<T> | undefined,
      fn: () => Promise<T> | T,
    ): void => {
      Promise.resolve()
        .then(fn)
        .then((res) => {
          if (typeof ack === 'function') {
            ack(ok(res));
          }
        })
        .catch((err) => replyError(socket, ack, err));
    };

    socket.on(ClientEvents.CLIENT_REGISTER, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, async () => {
        const input = parseWithAck(ClientRegisterSchema, rawPayload ?? {});
        if (input.clientInstanceId !== clientInstanceId) {
          throw new PlatformError(
            ErrorCode.UNAUTHORIZED,
            'clientInstanceId does not match authenticated token',
          );
        }

        const { session, previousSocketId, reconnectedPlayers } =
          playerManager.registerClient(clientInstanceId, socket.id);

        if (previousSocketId) {
          const oldSocket = io.sockets.sockets.get(previousSocketId);
          if (oldSocket && oldSocket.id !== socket.id) {
            oldSocket.disconnect(true);
          }
        }

        await socket.join('lobby');

        const rejoinedRooms = new Set<string>();
        for (const info of reconnectedPlayers) {
          if (info.disconnectedDurationMs > 0) {
            matchManager.recordPlayerDisconnectWindow(
              info.playerId,
              info.disconnectedDurationMs,
            );
          }
          if (info.roomId) {
            rejoinedRooms.add(info.roomId);
          }
        }

        for (const rid of rejoinedRooms) {
          await socket.join(rid);
          const room = roomManager.getRoom(rid);
          if (room) {
            const roomSnap = roomManager.toSnapshot(room);
            io.to(rid).emit(ServerEvents.PLAYER_RECONNECTED, {
              roomId: rid,
              clientInstanceId,
              playerIds: reconnectedPlayers
                .filter((p) => p.roomId === rid)
                .map((p) => p.playerId),
            });
            io.to(rid).emit(ServerEvents.ROOM_UPDATED, roomSnap);
          }
        }

        const registeredPayload = {
          clientInstanceId: session.clientInstanceId,
          maxLocalPlayers: config.maxLocalPlayersPerClient,
          players: playerManager.getClientPlayers(clientInstanceId),
          rejoinedRoomIds: Array.from(rejoinedRooms),
          serverNow: Date.now(),
        };
        socket.emit(ServerEvents.CLIENT_REGISTERED, registeredPayload);
        return registeredPayload;
      });
    });

    socket.on(ClientEvents.CLIENT_HEARTBEAT, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        const input = parseWithAck(ClientHeartbeatSchema, rawPayload);
        playerManager.touchHeartbeat(clientInstanceId);
        return {
          t0: input.t0,
          serverNow: Date.now(),
        };
      });
    });

    socket.on(ClientEvents.PLAYER_JOIN, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        const input = parseWithAck(PlayerJoinSchema, rawPayload);
        const player = playerManager.addLocalPlayer(clientInstanceId, input);
        return { player };
      });
    });

    socket.on(ClientEvents.PLAYER_LEAVE, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        const input = parseWithAck(PlayerLeaveSchema, rawPayload);
        const roomId = playerManager.getPlayerRoom(input.playerId);
        if (roomId) {
          const left = roomManager.leaveRoom(
            clientInstanceId,
            roomId,
            input.playerId,
          );
          matchManager.handlePermanentPlayerLeave(roomId, input.playerId);
          if (left) {
            io.to(roomId).emit(ServerEvents.PLAYER_LEFT, {
              roomId,
              playerIds: left.removedPlayerIds,
            });
            io.to(roomId).emit(ServerEvents.ROOM_UPDATED, left.room);
            broadcastLobbyRooms();
          }
        }
        const player = playerManager.removeLocalPlayer(
          clientInstanceId,
          input.playerId,
        );
        if (roomId && !playerManager.getClientRoomIds(clientInstanceId).includes(roomId)) {
          void socket.leave(roomId);
        }
        return { player };
      });
    });

    socket.on(ClientEvents.DEVICE_STATUS, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        const input = parseWithAck(DeviceStatusSchema, rawPayload);
        const device = playerManager.updateDeviceStatus(clientInstanceId, input);
        const roomIds = playerManager.getClientRoomIds(clientInstanceId);
        for (const rid of roomIds) {
          io.to(rid).emit(ServerEvents.DEVICE_UPDATED, device);
        }
        return { device };
      });
    });

    socket.on(ClientEvents.ROOM_CREATE, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, async () => {
        const input = parseWithAck(RoomCreateSchema, rawPayload);
        const claims = data.claims;
        if (
          !claims.allowedModeIds.includes('*') &&
          !claims.allowedModeIds.includes(input.gameModeId)
        ) {
          throw new PlatformError(
            ErrorCode.UNAUTHORIZED,
            `Token is not authorized for game mode "${input.gameModeId}"`,
          );
        }

        const room = roomManager.createRoom(clientInstanceId, input);
        await socket.join(room.roomId);
        io.to(room.roomId).emit(ServerEvents.ROOM_UPDATED, room);
        broadcastLobbyRooms();
        return { room };
      });
    });

    socket.on(ClientEvents.ROOM_JOIN, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, async () => {
        const input = parseWithAck(RoomJoinSchema, rawPayload);
        const { room, joinedPlayers } = roomManager.joinRoom(
          clientInstanceId,
          input,
        );
        await socket.join(room.roomId);
        io.to(room.roomId).emit(ServerEvents.PLAYER_JOINED, {
          roomId: room.roomId,
          players: joinedPlayers,
        });
        io.to(room.roomId).emit(ServerEvents.ROOM_UPDATED, room);
        broadcastLobbyRooms();
        return { room, joinedPlayers };
      });
    });

    socket.on(ClientEvents.ROOM_LEAVE, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, async () => {
        const input = parseWithAck(RoomLeaveSchema, rawPayload ?? {});
        const left = roomManager.leaveRoom(clientInstanceId, input.roomId);
        if (left) {
          for (const pid of left.removedPlayerIds) {
            matchManager.handlePermanentPlayerLeave(left.room.roomId, pid);
          }
          await socket.leave(left.room.roomId);
          io.to(left.room.roomId).emit(ServerEvents.PLAYER_LEFT, {
            roomId: left.room.roomId,
            playerIds: left.removedPlayerIds,
          });
          io.to(left.room.roomId).emit(ServerEvents.ROOM_UPDATED, left.room);
          broadcastLobbyRooms();
        }
        return { room: left?.room ?? null };
      });
    });

    socket.on(ClientEvents.ROOM_RESET, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        const input = parseWithAck(RoomResetSchema, rawPayload);
        const room = roomManager.resetRoom(clientInstanceId, input);
        io.to(room.roomId).emit(ServerEvents.ROOM_UPDATED, room);
        broadcastLobbyRooms();
        return { room };
      });
    });

    socket.on(ClientEvents.PLAYER_READY, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        const input = parseWithAck(PlayerReadySchema, rawPayload);
        const room = roomManager.setPlayerReady(
          clientInstanceId,
          input.playerId,
          input.ready,
        );
        io.to(room.roomId).emit(ServerEvents.ROOM_UPDATED, room);
        broadcastLobbyRooms();
        return { room };
      });
    });

    socket.on(ClientEvents.MATCH_REQUEST_START, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, async () => {
        const input = parseWithAck(MatchRequestStartSchema, rawPayload);
        return await matchManager.requestStartMatch(
          clientInstanceId,
          input.roomId,
          input.countdownMs,
        );
      });
    });

    socket.on(ClientEvents.GAME_EVENT, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        return matchManager.handleGameEvent(clientInstanceId, rawPayload);
      });
    });

    socket.on(ClientEvents.GAME_STATE_REQUEST, (rawPayload, ack?: AckFn) => {
      handleAsync(ack, () => {
        const input = parseWithAck(GameStateRequestSchema, rawPayload ?? {});
        const snapshot = matchManager.getStateSnapshot(input);
        socket.emit(ServerEvents.GAME_STATE, snapshot);
        return { snapshot };
      });
    });

    socket.on('disconnect', () => {
      const { affectedPlayers, affectedRoomIds } =
        playerManager.handleDisconnect(
          clientInstanceId,
          socket.id,
          (expiredClientId, expiredPlayerIds) => {
            const roomIds = playerManager.getClientRoomIds(expiredClientId);
            for (const rid of roomIds) {
              const left = roomManager.leaveRoom(expiredClientId, rid);
              for (const pid of expiredPlayerIds) {
                matchManager.handlePermanentPlayerLeave(rid, pid);
              }
              if (left) {
                io.to(rid).emit(ServerEvents.PLAYER_LEFT, {
                  roomId: rid,
                  playerIds: left.removedPlayerIds,
                  reason: 'DISCONNECT_TIMEOUT',
                });
                io.to(rid).emit(ServerEvents.ROOM_UPDATED, left.room);
                broadcastLobbyRooms();
              }
            }
          },
        );

      for (const rid of affectedRoomIds) {
        const room = roomManager.getRoom(rid);
        io.to(rid).emit(ServerEvents.PLAYER_DISCONNECTED, {
          roomId: rid,
          clientInstanceId,
          playerIds: affectedPlayers.map((p) => p.playerId),
        });
        if (room) {
          io.to(rid).emit(ServerEvents.ROOM_UPDATED, roomManager.toSnapshot(room));
        }
      }
    });
  });
}
