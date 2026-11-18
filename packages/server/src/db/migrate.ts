import type { Pool } from 'pg';

const DDL_STATEMENTS = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_modes (
  id SERIAL PRIMARY KEY,
  mode_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  developer_id TEXT NOT NULL DEFAULT 'edusports',
  protocol_version TEXT NOT NULL DEFAULT '1.0',
  min_players INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  allowed_origins JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  client_entry_url TEXT,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS client_instances (
  id SERIAL PRIMARY KEY,
  client_instance_id TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'CONNECTED'
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE,
  device_type TEXT NOT NULL DEFAULT 'BLE_ROPE',
  device_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  assigned_player_id TEXT,
  local_client_id TEXT NOT NULL,
  last_data_timestamp BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  game_mode_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING',
  max_players INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_players (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  client_instance_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'PLAYER',
  team_id TEXT,
  status TEXT NOT NULL DEFAULT 'CONNECTED'
);

CREATE UNIQUE INDEX IF NOT EXISTS room_players_room_player_idx
  ON room_players (room_id, player_id);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  game_mode_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  result JSONB
);

CREATE TABLE IF NOT EXISTS match_participants (
  id SERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  team_id TEXT,
  final_score INTEGER NOT NULL DEFAULT 0,
  result JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS match_participants_match_player_idx
  ON match_participants (match_id, player_id);

CREATE TABLE IF NOT EXISTS game_events (
  id SERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS game_events_match_player_seq_idx
  ON game_events (match_id, player_id, sequence);

CREATE TABLE IF NOT EXISTS game_states (
  id SERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  state_version INTEGER NOT NULL,
  state_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS game_states_match_version_idx
  ON game_states (match_id, state_version);
`;

export async function ensureDatabaseSchema(pool: Pool): Promise<void> {
  await pool.query(DDL_STATEMENTS);
}
