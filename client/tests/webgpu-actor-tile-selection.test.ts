import assert from "node:assert/strict";

import { ClientState } from "../game/ClientState";
import {
    ActorTileSelection,
    getActorTileSelectionKey,
} from "../render/webgpu/actors/actorPacking";

// Priority order under test (WebGL tick2/overlays4):
// controlled player 5 > combat target 4 > NPC DRAW_PRIORITY_FIRST 3 > other players 2 >
// NPC DRAW_PRIORITY_DEFAULT 1 > NPC DRAW_PRIORITY_LAST 0, strictly greater replaces,
// first registration wins ties. Only actors centred exactly on a tile are candidates.

interface FakePlayer {
    serverId: number;
    tileX: number;
    tileY: number;
    plane?: number;
    centered?: boolean;
    hidden?: boolean;
}

interface FakeNpc {
    id: number;
    tileX: number;
    tileY: number;
    plane?: number;
    size?: number;
    drawPriority?: number;
    centered?: boolean;
}

function makeClient(opts: {
    players?: FakePlayer[];
    npcs?: FakeNpc[];
    controlledServerId?: number;
    combatTargetServerId?: number;
    renderSelf?: boolean;
}): any {
    const players = (opts.players ?? []).map((p) => ({
        serverId: p.serverId,
        ecs: p.serverId,
        x: p.tileX * 128 + (p.centered === false ? 0 : 64),
        y: p.tileY * 128 + (p.centered === false ? 0 : 64),
        level: p.plane ?? 0,
        hidden: p.hidden === true,
    }));
    const playerByEcs = new Map(players.map((p) => [p.ecs, p]));
    const npcs = new Map(
        (opts.npcs ?? []).map((n) => [
            n.id,
            {
                id: n.id,
                x: n.tileX * 128 + (n.centered === false ? 0 : 64),
                y: n.tileY * 128 + (n.centered === false ? 0 : 64),
                level: n.plane ?? 0,
                size: n.size ?? 1,
                drawPriority: n.drawPriority ?? 1,
            },
        ]),
    );

    const playerEcs = {
        getAllActiveIndices: () => playerByEcs.keys(),
        getAllServerIds: () => players.map((p) => p.serverId),
        getIndexForServerId: (serverId: number) =>
            players.find((p) => p.serverId === (serverId | 0))?.ecs,
        getX: (i: number) => playerByEcs.get(i)?.x ?? 0,
        getY: (i: number) => playerByEcs.get(i)?.y ?? 0,
        getLevel: (i: number) => playerByEcs.get(i)?.level ?? 0,
        getIsHidden: (i: number) => playerByEcs.get(i)?.hidden ?? false,
    };

    const npcEcs = {
        isActive: (id: number) => npcs.has(id),
        isLinked: (id: number) => npcs.has(id),
        getServerLinkedEcsIds: () => npcs.keys(),
        getWorldViewId: () => -1,
        getWorldX: (id: number) => npcs.get(id)?.x ?? 0,
        getWorldY: (id: number) => npcs.get(id)?.y ?? 0,
        getLevel: (id: number) => npcs.get(id)?.level ?? 0,
        getSize: (id: number) => npcs.get(id)?.size ?? 1,
        getNpcTypeId: (id: number) => id,
        getMapX: () => 0,
        getMapY: () => 0,
        queryByMap: () => [...npcs.keys()],
    };

    return {
        playerEcs,
        npcEcs,
        renderSelf: opts.renderSelf !== false,
        controlledPlayerServerId: opts.controlledServerId ?? -1,
        npcTypeLoader: {
            load: (typeId: number) => {
                const npc = npcs.get(typeId);
                return npc
                    ? { transforms: undefined, drawPriority: npc.drawPriority }
                    : undefined;
            },
        },
        varManager: {},
    };
}

const MAPS: any[] = [{ mapX: 0, mapY: 0 }];

function build(opts: Parameters<typeof makeClient>[0]): {
    client: any;
    selection: ActorTileSelection;
} {
    const client = makeClient(opts);
    const selection = new ActorTileSelection();
    selection.ensureForFrame(client, 1, MAPS);
    return { client, selection };
}

function withCombatTarget<T>(serverId: number, fn: () => T): T {
    const previous = ClientState.combatTargetPlayerIndex;
    ClientState.combatTargetPlayerIndex = serverId;
    try {
        return fn();
    } finally {
        ClientState.combatTargetPlayerIndex = previous;
    }
}

// Key helper: same tile/plane is one slot; plane and tile separate them.
assert.equal(
    getActorTileSelectionKey(10, 10, 0),
    getActorTileSelectionKey(10, 10, 0),
    "same tile and plane must share a selection slot",
);
assert.notEqual(
    getActorTileSelectionKey(10, 10, 0),
    getActorTileSelectionKey(10, 10, 1),
    "planes must not share a selection slot",
);
assert.notEqual(
    getActorTileSelectionKey(10, 10, 0),
    getActorTileSelectionKey(11, 10, 0),
    "different tiles must not share a selection slot",
);

// 1. Controlled player beats everything at the same tile.
{
    const { client, selection } = build({
        players: [
            { serverId: 1, tileX: 10, tileY: 10 },
            { serverId: 2, tileX: 10, tileY: 10 },
        ],
        npcs: [
            { id: 100, tileX: 10, tileY: 10, drawPriority: 0 },
            { id: 101, tileX: 10, tileY: 10, drawPriority: 1 },
            { id: 102, tileX: 10, tileY: 10, drawPriority: 2 },
        ],
        controlledServerId: 1,
    });
    assert.equal(selection.shouldRenderPlayer(client, 1), true, "controlled player must win");
    assert.equal(selection.shouldRenderPlayer(client, 2), false, "other player must lose");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 100), false, "NPC FIRST must lose");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 101), false, "NPC DEFAULT must lose");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 102), false, "NPC LAST must lose");
}

// 2. Combat target beats NPC FIRST / other players when the controlled player is elsewhere.
{
    const { client, selection } = withCombatTarget(2, () =>
        build({
            players: [
                { serverId: 1, tileX: 5, tileY: 5 },
                { serverId: 2, tileX: 10, tileY: 10 },
                { serverId: 3, tileX: 10, tileY: 10 },
            ],
            npcs: [{ id: 100, tileX: 10, tileY: 10, drawPriority: 0 }],
            controlledServerId: 1,
        }),
    );
    assert.equal(selection.shouldRenderPlayer(client, 2), true, "combat target must win");
    assert.equal(selection.shouldRenderPlayer(client, 3), false, "other player must lose");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 100), false, "NPC FIRST must lose");
}

// 3. NPC DRAW_PRIORITY_FIRST (3) beats other players (2) and lower-priority NPCs.
{
    const { client, selection } = build({
        players: [
            { serverId: 1, tileX: 5, tileY: 5 },
            { serverId: 2, tileX: 10, tileY: 10 },
        ],
        npcs: [
            { id: 100, tileX: 10, tileY: 10, drawPriority: 0 },
            { id: 101, tileX: 10, tileY: 10, drawPriority: 1 },
            { id: 102, tileX: 10, tileY: 10, drawPriority: 2 },
        ],
        controlledServerId: 1,
    });
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 100), true, "NPC FIRST must win");
    assert.equal(selection.shouldRenderPlayer(client, 2), false, "other player must lose");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 101), false, "NPC DEFAULT must lose");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 102), false, "NPC LAST must lose");
}

// 4. Other player (2) beats NPC DEFAULT (1) and NPC LAST (0).
{
    const { client, selection } = build({
        players: [
            { serverId: 1, tileX: 5, tileY: 5 },
            { serverId: 2, tileX: 10, tileY: 10 },
        ],
        npcs: [
            { id: 101, tileX: 10, tileY: 10, drawPriority: 1 },
            { id: 102, tileX: 10, tileY: 10, drawPriority: 2 },
        ],
        controlledServerId: 1,
    });
    assert.equal(selection.shouldRenderPlayer(client, 2), true, "other player must win");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 101), false, "NPC DEFAULT must lose");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 102), false, "NPC LAST must lose");
}

// 5. NPC DEFAULT (1) beats NPC LAST (0); a lone NPC LAST still renders.
{
    const { client, selection } = build({
        npcs: [
            { id: 101, tileX: 10, tileY: 10, drawPriority: 1 },
            { id: 102, tileX: 10, tileY: 10, drawPriority: 2 },
        ],
    });
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 101), true, "NPC DEFAULT must win");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 102), false, "NPC LAST must lose");

    const lone = build({ npcs: [{ id: 102, tileX: 3, tileY: 3, drawPriority: 2 }] });
    assert.equal(
        lone.selection.shouldRenderNpc(lone.client, MAPS[0], 102),
        true,
        "a lone NPC LAST has no contest and must render",
    );
}

// 6. Ties keep the first registration: other players are registered in ascending server id.
{
    const { client, selection } = build({
        players: [
            { serverId: 2, tileX: 10, tileY: 10 },
            { serverId: 3, tileX: 10, tileY: 10 },
        ],
        controlledServerId: -1,
    });
    assert.equal(selection.shouldRenderPlayer(client, 2), true, "lower server id wins the tie");
    assert.equal(selection.shouldRenderPlayer(client, 3), false, "higher server id loses the tie");
}

// 7. Ties between equal-priority NPCs keep the first linked id.
{
    const { client, selection } = build({
        npcs: [
            { id: 100, tileX: 10, tileY: 10, drawPriority: 0 },
            { id: 101, tileX: 10, tileY: 10, drawPriority: 0 },
        ],
    });
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 100), true, "first NPC wins the tie");
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 101), false, "second NPC loses the tie");
}

// 8. Non-candidate players always render; hidden players never do (shouldRenderPlayerIndex).
{
    const { client, selection } = build({
        players: [
            { serverId: 1, tileX: 10, tileY: 10 },
            { serverId: 2, tileX: 10, tileY: 10, centered: false },
            { serverId: 4, tileX: 10, tileY: 10, hidden: true },
        ],
        controlledServerId: 1,
    });
    assert.equal(
        selection.shouldRenderPlayer(client, 2),
        true,
        "a player not centred on the tile always renders",
    );
    assert.equal(selection.shouldRenderPlayer(client, 4), false, "a hidden player never renders");
}

// 9. Non-candidate NPCs (size != 1 or off-centre) always render.
{
    const { client, selection } = build({
        npcs: [
            { id: 100, tileX: 10, tileY: 10, drawPriority: 0 },
            { id: 200, tileX: 10, tileY: 10, size: 2 },
            { id: 201, tileX: 10, tileY: 10, centered: false },
        ],
    });
    assert.equal(selection.shouldRenderNpc(client, MAPS[0], 200), true, "size > 1 always renders");
    assert.equal(
        selection.shouldRenderNpc(client, MAPS[0], 201),
        true,
        "off-centre NPC always renders",
    );
}

// 10. The winner map is rebuilt when the frame changes.
{
    const client = makeClient({
        players: [
            { serverId: 1, tileX: 5, tileY: 5 },
            { serverId: 2, tileX: 10, tileY: 10 },
        ],
        controlledServerId: 1,
    });
    const selection = new ActorTileSelection();
    selection.ensureForFrame(client, 1, MAPS);
    assert.equal(selection.shouldRenderPlayer(client, 2), true, "frame 1 winner renders");

    // Move the controlled player onto the contested tile; the next frame must rebuild.
    client.playerEcs.getX = () => 10 * 128 + 64;
    client.playerEcs.getY = () => 10 * 128 + 64;
    selection.ensureForFrame(client, 2, MAPS);
    assert.equal(selection.shouldRenderPlayer(client, 2), false, "frame 2 rebuild picks the controlled player");
    assert.equal(selection.shouldRenderPlayer(client, 1), true, "controlled player wins frame 2");
    selection.ensureForFrame(client, 2, MAPS);
    assert.equal(selection.shouldRenderPlayer(client, 2), false, "same frame reuses the winner map");
}

console.log("WebGPU actor tile selection test passed");
