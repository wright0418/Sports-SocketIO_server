import {
  ErrorCode,
  PlatformError,
  type GameModeMetadata,
} from '@edusports/shared';
import { BombPassModeModule, BOMB_PASS_METADATA } from './bombPassMode.js';
import { MultiplayerModeModule, MULTIPLAYER_METADATA } from './multiplayerMode.js';
import type { GameModeServerModule } from './types.js';

export type ModeFactory = () => GameModeServerModule;

interface RegisteredMode {
  metadata: GameModeMetadata;
  factory: ModeFactory;
}

export class GameModeRegistry {
  private readonly modes = new Map<string, RegisteredMode>();

  constructor() {
    this.registerMode(MULTIPLAYER_METADATA, () => new MultiplayerModeModule());
    this.registerMode(BOMB_PASS_METADATA, () => new BombPassModeModule());
  }

  registerMode(metadata: GameModeMetadata, factory: ModeFactory): void {
    this.modes.set(metadata.modeId, { metadata, factory });
  }

  getMetadata(modeId: string): GameModeMetadata {
    const entry = this.modes.get(modeId);
    if (!entry) {
      throw new PlatformError(
        ErrorCode.GAME_MODE_NOT_FOUND,
        `Game mode "${modeId}" is not registered`,
      );
    }
    return entry.metadata;
  }

  listMetadata(): GameModeMetadata[] {
    return Array.from(this.modes.values()).map((m) => m.metadata);
  }

  createInstance(modeId: string): GameModeServerModule {
    const entry = this.modes.get(modeId);
    if (!entry) {
      throw new PlatformError(
        ErrorCode.GAME_MODE_NOT_FOUND,
        `Game mode "${modeId}" is not registered`,
      );
    }
    return entry.factory();
  }
}
