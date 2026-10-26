import type { WorldTile } from "./QuestHelperProtocol";

/**
 * A marker plugins put on the world map (RuneLite's WorldMapPoint). The world map draws each
 * one over its area; `snapToEdge` keeps an off-screen point at the map's edge.
 */
export type PluginWorldMapPoint = WorldTile & { color: number; snapToEdge: boolean; texture?: string; owner: string };

const OWNER = "questhelper";

/** QuestWorldMapPoint: the current step's location, snapped to the edge, in the target colour. */
export function setQuestWorldMapPoint(client: any, target: WorldTile | undefined, color: number): void {
    if (!client) return;
    const others: PluginWorldMapPoint[] = (client.pluginWorldMapPoints ?? []).filter((p: PluginWorldMapPoint) => p.owner !== OWNER);
    const current = (client.pluginWorldMapPoints ?? []).find((p: PluginWorldMapPoint) => p.owner === OWNER);
    if (!target) {
        if (current) client.pluginWorldMapPoints = others;
        return;
    }
    if (current && current.x === target.x && current.y === target.y && current.plane === target.plane && current.color === color) return;
    client.pluginWorldMapPoints = [...others, { x: target.x, y: target.y, plane: target.plane, color, snapToEdge: true, texture: "questhelper:quest_icon", owner: OWNER }];
}
