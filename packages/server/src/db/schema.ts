import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gameModes = pgTable('game_modes', {
  id: serial('id').primaryKey(),
  modeId: text('mode_id').notNull().unique(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  developerId: text('developer_id').notNull().default('edusports'),
  protocolVersion: text('protocol_version').notNull().default('1.0'),
  minPlayers: integer('min_players').notNull(),
  maxPlayers: integer('max_players').notNull(),
  allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default(['*']),
  clientEntryUrl: text('client_entry_url'),
  configuration: jsonb('configuration').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('ACTIVE'),
});

export const clientInstances = pgTable('client_instances', {
  id: serial('id').primaryKey(),
  clientInstanceId: text('client_instance_id').notNull().unique(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('CONNECTED'),
});

export const devices = pgTable('devices', {
  id: serial('id').primaryKey(),
  deviceId: text('device_id').notNull().unique(),
  deviceType: text('device_type').notNull().default('BLE_ROPE'),
  deviceStatus: text('device_status').notNull().default('UNKNOWN'),
  assignedPlayerId: text('assigned_player_id'),
  localClientId: text('local_client_id').notNull(),
  lastDataTimestamp: bigint('last_data_timestamp', { mode: 'number' }).notNull().default(0),
});

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(),
  roomCode: text('room_code').notNull().unique(),
  gameModeId: text('game_mode_id').notNull(),
  ownerId: text('owner_id').notNull(),
  status: text('status').notNull().default('WAITING'),
  maxPlayers: integer('max_players').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roomPlayers = pgTable(
  'room_players',
  {
    id: serial('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    playerId: text('player_id').notNull(),
    clientInstanceId: text('client_instance_id').notNull(),
    role: text('role').notNull().default('PLAYER'),
    teamId: text('team_id'),
    status: text('status').notNull().default('CONNECTED'),
  },
  (table) => ({
    roomPlayerUniqueIdx: uniqueIndex('room_players_room_player_idx').on(
      table.roomId,
      table.playerId,
    ),
  }),
);

export const matches = pgTable('matches', {
  id: text('id').primaryKey(),
  roomId: text('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  gameModeId: text('game_mode_id').notNull(),
  status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  result: jsonb('result').$type<Record<string, unknown> | null>(),
});

export const matchParticipants = pgTable(
  'match_participants',
  {
    id: serial('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    playerId: text('player_id').notNull(),
    teamId: text('team_id'),
    finalScore: integer('final_score').notNull().default(0),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
  },
  (table) => ({
    matchParticipantUniqueIdx: uniqueIndex('match_participants_match_player_idx').on(
      table.matchId,
      table.playerId,
    ),
  }),
);

export const gameEvents = pgTable(
  'game_events',
  {
    id: serial('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    playerId: text('player_id').notNull(),
    eventId: text('event_id').notNull().unique(),
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    serverTimestamp: timestamp('server_timestamp', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    matchPlayerSeqIdx: index('game_events_match_player_seq_idx').on(
      table.matchId,
      table.playerId,
      table.sequence,
    ),
  }),
);

export const gameStates = pgTable(
  'game_states',
  {
    id: serial('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    stateVersion: integer('state_version').notNull(),
    stateData: jsonb('state_data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    matchVersionIdx: index('game_states_match_version_idx').on(
      table.matchId,
      table.stateVersion,
    ),
  }),
);
