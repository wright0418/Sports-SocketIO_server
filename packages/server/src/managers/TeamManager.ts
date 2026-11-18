import type { PlayerState, TeamState } from '@edusports/shared';

export class TeamManager {
  buildTeamsFromPlayers(players: PlayerState[]): TeamState[] {
    const teams = new Map<string, TeamState>();
    for (const player of players) {
      if (!player.teamId) continue;
      let team = teams.get(player.teamId);
      if (!team) {
        team = {
          teamId: player.teamId,
          name: player.teamId,
          playerIds: [],
          score: 0,
        };
        teams.set(player.teamId, team);
      }
      if (!team.playerIds.includes(player.playerId)) {
        team.playerIds.push(player.playerId);
      }
    }
    return Array.from(teams.values());
  }
}
