import type { Client, Player } from "@runelite/api/Client";
import type { GameState } from "@runelite/api/GameState";
import type { OsrsClient } from "../../game/OsrsClient";
import type { SkillId } from "../../rs/skill/skills";
import { toRuneLiteGameState } from "./GameStateMapping";

/** The RuneLite `Client` facade over our engine. */
export class ClientImpl implements Client {
    constructor(private readonly osrsClient: OsrsClient) {}

    getGameState(): GameState {
        return toRuneLiteGameState(this.osrsClient.gameState);
    }

    getLocalPlayer(): Player | null {
        const client = this.osrsClient;
        const index = client.playerEcs?.getIndexForServerId(client.controlledPlayerServerId);
        if (client.controlledPlayerServerId < 0 || index === undefined || index < 0) return null;
        return {
            getName: () => client.localPlayerName,
            getCombatLevel: () => client.playerEcs.getCombatLevel(index),
        };
    }

    getVarpValue(varpId: number): number {
        return this.osrsClient.varManager?.getVarp(varpId) ?? 0;
    }

    getRealSkillLevel(skill: SkillId): number {
        return this.osrsClient.cs2Vm?.context?.getStatBase?.(skill) ?? 1;
    }

    /**
     * Throws when the script can't run: before the cache is loaded, or while another script runs
     * (a top-level run would reset that script's stacks). RuneLite runs scripts only on the
     * client thread, between scripts, so it never meets the second case.
     */
    runScript(scriptId: number, ...args: number[]): void {
        const vm = this.osrsClient.cs2Vm;
        if (!vm || vm.isRunning()) throw new Error(`Client script ${scriptId} can't run now`);
        const script = vm.context?.loadScript?.(scriptId | 0);
        if (!script) throw new Error(`Client script ${scriptId} is not in the cache`);
        vm.run(script, args, []);
    }

    getIntStack(): ArrayLike<number> {
        return this.osrsClient.cs2Vm.intStack;
    }
}
