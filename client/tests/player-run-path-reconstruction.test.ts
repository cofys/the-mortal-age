import assert from "node:assert/strict";
import { CollisionFlag } from "../common/CollisionFlag";
import { MovementDirection } from "../common/Direction";
import { PlayerAnimController } from "../game/PlayerAnimController";
import { PlayerEcs } from "../game/ecs/PlayerEcs";
import { PlayerMovementSync } from "../game/movement/PlayerMovementSync";
import { PlayerSyncContext } from "../game/sync/PlayerSyncContext";
import { PlayerSyncManager } from "../game/sync/PlayerSyncManager";
import { PlayerUpdateDecoder } from "../game/sync/PlayerUpdateDecoder";
import {
    createPlayerSyncState,
    encodePlayerSync,
} from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

const playerEcs = {
    setInteractionOrientationProvider() {},
    trimQueuedStepsAfter() {
        return true;
    },
    setServerPos() {
        return true;
    },
    setRunning() {},
    getInteractionIndex() {
        return -1;
    },
};

const movement = new PlayerMovementSync(
    playerEcs as any,
    undefined,
    undefined,
    undefined,
    undefined,
    (_plane, x, y) => (x === 1 && y === 0 ? CollisionFlag.OBJECT : 0),
);

movement.registerEntity({
    serverId: 1,
    ecsIndex: 0,
    tile: { x: 0, y: 0 },
    level: 0,
    subX: 64,
    subY: 64,
});

const { path } = movement.receiveUpdate({
    serverId: 1,
    ecsIndex: 0,
    x: (1 << 7) + 64,
    y: (1 << 7) + 64,
    level: 0,
    running: true,
    moved: true,
    directions: [MovementDirection.NorthEast],
    traversals: [2],
});

assert.equal(path.steps.length, 2);
assert.notEqual(path.steps[0].direction, MovementDirection.NorthEast);
assert.deepEqual(path.steps.at(-1)?.tile, { x: 1, y: 1 });

const start = { x: 3081, y: 3506, level: 0 };
const serverState = createPlayerSyncState(1, start);
const packet = encodePlayerSync(
    1,
    3040,
    3472,
    1,
    [{
        index: 1,
        x: 3080,
        y: 3507,
        level: 0,
        appearance: Buffer.alloc(0),
        movementType: 2,
    }],
    serverState,
);
const payload = packet.subarray(3);
const syncLength = payload.readUInt16BE(10);
const context = new PlayerSyncContext();
context.setBase(payload.readUInt16BE(0), payload.readUInt16BE(2));
context.setLocalIndex(1);
context.activate(1, start);
for (const index of context.emptyIndices) context.flags[index] = 1;

const frame = new PlayerUpdateDecoder().decode(
    payload.subarray(12, 12 + syncLength),
    context,
    { packetSize: syncLength, loopCycle: 1 },
);
assert.equal(frame.movements[0]?.mode, "run");
assert.equal(frame.movements[0]?.snap, undefined);
assert.equal(frame.movements[0]?.directions, undefined);
assert.deepEqual(frame.movements[0]?.tile, { x: 3080, y: 3507, level: 0 });

console.log("player run path reconstruction check passed");

const fine = (tile: number) => (tile << 7) + 64;

// A one-tile moveTo (for example, placement onto a chair) must not be decoded
// as a walking step while its animation has already started.
for (const level of [0, 1]) for (const index of [1, 2]) {
    const state = createPlayerSyncState(1, start);
    const ctx = new PlayerSyncContext();
    ctx.setBase(3040, 3472);
    ctx.setLocalIndex(1);
    ctx.activate(1, start);
    for (const empty of ctx.emptyIndices) ctx.flags[empty] = 1;
    const views = [1, 2].map(id => ({ index: id, ...start, appearance: Buffer.alloc(0) }));
    const decode = (tick: number) => {
        const data = encodePlayerSync(1, 3040, 3472, tick, views, state).subarray(3);
        const length = data.readUInt16BE(10);
        return new PlayerUpdateDecoder().decode(data.subarray(12, 12 + length), ctx,
            { packetSize: length, loopCycle: tick });
    };
    const ecs = new PlayerEcs();
    const animations = new PlayerAnimController(ecs,
        { load: () => ({ priority: 1, forcedPriority: 5 }) } as any, {} as any);
    const movementSync = new PlayerMovementSync(ecs, animations);
    const manager = new PlayerSyncManager({ ecs, movementSync, animController: animations });
    const ecsIndex = ecs.allocatePlayer(index);
    ecs.teleport(ecsIndex, start.x, start.y, 0);
    movementSync.registerEntity({ serverId: index, ecsIndex, tile: start,
        level: 0, subX: fine(start.x), subY: fine(start.y) });
    manager.handleFrame(decode(1));
    ecs.setServerPos(ecsIndex, fine(start.x), fine(start.y + 1));
    ecs.setServerPos(ecsIndex, fine(start.x), fine(start.y + 2));
    Object.assign(views[index - 1], { y: start.y + 1, level, resetPath: true,
        animation: { id: 4103, delay: 0 }, faceDirection: 256 });
    const placed = decode(2);
    const move = placed.movements.find(event => event.index === index);
    assert.equal(move?.mode, "teleport", "placement must snap for both self and observers");
    assert.equal(move?.snap, true);
    assert.deepEqual(move?.tile, { ...start, y: start.y + 1, level });
    assert.equal(placed.updateBlocks.get(index)?.faceDir, 256);
    assert.deepEqual(placed.updateBlocks.get(index)?.animation, { seqId: 4103, delay: 0 });
    manager.handleFrame(placed);
    assert.equal(ecs.getAnimSeqId(ecsIndex), 4103, "placement preserves its same-packet animation");
    assert.equal(ecs.getForcedMovementSteps(ecsIndex), 0);
    ecs.updateClient(100);
    assert.deepEqual([ecs.getX(ecsIndex), ecs.getY(ecsIndex), ecs.getLevel(ecsIndex)],
        [fine(start.x), fine(start.y + 1), level], "old steps cannot move the player after placement");
}
console.log("player placement reset checks passed");

// Relocation discards the approach path and its animation snapshot, even when
// another forced movement was still running (stairs, teleports, interrupted jumps).
for (const forced of [false, true]) {
    const ecs = new PlayerEcs();
    const index = ecs.allocatePlayer(1);
    ecs.teleport(index, 100, 100);
    const animations = new PlayerAnimController(ecs,
        { load: () => ({ priority: 1, forcedPriority: 5 }) } as any, {} as any);
    const sync = new PlayerMovementSync(ecs, animations);
    sync.registerEntity({ serverId: 1, ecsIndex: index, tile: { x: 100, y: 100 },
        level: 0, subX: fine(100), subY: fine(100) });
    ecs.setServerPos(index, fine(100), fine(101));
    ecs.updateClient();
    ecs.setServerPos(index, fine(100), fine(102));
    animations.handleServerSequence(1, 828);
    assert.equal(ecs.getForcedMovementSteps(index), 2);
    if (forced) {
        ecs.startForcedMovement(index, 1, 70, fine(100), fine(101), fine(100), fine(104), 1024);
        ecs.setServerPos(index, fine(100), fine(105));
    }
    sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(200), y: fine(200),
        level: 1, moved: true, snap: true });
    assert.equal(ecs.isMoving(index), false, "teleport clears queued approach steps");
    assert.equal(ecs.getForcedMovementSteps(index), 0, "teleport clears sequencePathLength");
    assert.equal(ecs.isForcedMovementActive(index, 2), false, "teleport cancels an old jump");
    assert.equal(ecs.getAnimSeqId(index), 828, "relocation preserves the action animation");
    assert.equal(ecs.getLevel(index), 1);
    ecs.updateClient(100);
    assert.deepEqual([ecs.getX(index), ecs.getY(index)], [fine(200), fine(200)]);
    sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(200), y: fine(201),
        level: 1, moved: true, directions: [MovementDirection.North], traversals: [1] });
    assert.equal(ecs.getAnimSeqId(index), -1, "walking still cancels move-sensitive animations");
}

// The forced endpoint is the next path's origin, even before the rendered
// player has landed. Walking must wait until the final forced-movement cycle.
{
    const ecs = new PlayerEcs();
    const index = ecs.allocatePlayer(1);
    ecs.teleport(index, 100, 99);
    const movementSync = new PlayerMovementSync(ecs);
    movementSync.registerEntity({ serverId: 1, ecsIndex: index,
        tile: { x: 100, y: 100 }, level: 0, subX: fine(100), subY: fine(100) });
    const manager = new PlayerSyncManager({ ecs, movementSync });
    manager.handleFrame({ baseX: 0, baseY: 0, localIndex: 1, loopCycle: 1,
        movements: [], spawns: [], removals: [], updateBlocks: new Map([[1, {
            forcedMovement: { startDeltaX: 0, startDeltaY: 0, endDeltaX: 0, endDeltaY: 3,
                startTileX: 100, startTileY: 100, endTileX: 100, endTileY: 103,
                startCycle: 2, endCycle: 12, direction: 1024 },
        }]]) });
    ecs.updateClient(4);
    assert.equal(ecs.getY(index), fine(100) + Math.trunc(2 * 384 / 10));
    const beforeWalk = ecs.getY(index);
    movementSync.receiveUpdate({ serverId: 1, ecsIndex: index,
        x: fine(100), y: fine(104), level: 0, running: false, moved: true,
        directions: [MovementDirection.North], traversals: [1] });
    assert.equal(ecs.getY(index), beforeWalk, "a queued walk must not snap a jump to its endpoint");
    for (let cycle = 5; cycle <= 12; cycle++) {
        ecs.updateClient();
        assert.equal(ecs.getY(index), fine(100) + Math.trunc((cycle - 2) * 384 / 10),
            "walking must not alter forced interpolation");
    }
    ecs.updateClient();
    assert.ok(ecs.getY(index) > fine(103) && ecs.getY(index) < fine(104),
        "the first step after landing walks smoothly from the endpoint");
    ecs.updateClient(70);
    assert.equal(ecs.getY(index), fine(104));
    assert.equal(ecs.isMoving(index), false);
}
console.log("player relocation and forced movement checks passed");

// WASD starts locally, but anticipation never changes the authoritative tile or
// replays an acknowledged step. A rejected/expired route returns along its tiles.
{
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
        for (const running of [false, true]) {
            now = 0;
            const ecs = new PlayerEcs();
            const index = ecs.allocatePlayer(1);
            ecs.teleport(index, 100, 100);
            ecs.setRotationImmediate(index, 1024);
            const sync = new PlayerMovementSync(ecs);
            sync.registerEntity({ serverId: 1, ecsIndex: index, tile: { x: 100, y: 100 },
                level: 0, subX: fine(100), subY: fine(100) });
            const tiles = [1, 2, 3, 4].map(n => ({ x: 100, y: 100 + n }));
            const span = running ? 2 : 1;
            sync.predictKeyboardMovement(1, tiles, running);
            ecs.updateClient();
            assert.ok(ecs.getY(index) > fine(100), "input moves before any server reply");
            assert.equal(sync.getState(1)?.tileY, 100, "prediction cannot move the server tile");
            ecs.updateClient(10);
            const beforeAck = ecs.getY(index);
            sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(100), y: fine(100 + span),
                level: 0, running, moved: true,
                directions: Array(span).fill(MovementDirection.North),
                traversals: Array(span).fill(running ? 2 : 1) });
            assert.equal(ecs.getY(index), beforeAck, "acknowledgement never snaps prediction back");
            ecs.updateClient(100);
            assert.equal(ecs.getY(index), fine(100 + span), "acknowledged steps are not replayed");
            sync.predictKeyboardMovement(1, tiles.slice(span), running);
            ecs.updateClient(100);
            assert.equal(ecs.getY(index), fine(100 + span * 2), "at most one tick is anticipated");
            now = 1201;
            sync.updateInteractionRotations();
            ecs.updateClient(100);
            assert.equal(ecs.getY(index), fine(100 + span * 2), "late confirmation freezes speculation without reversing it");
            sync.predictKeyboardMovement(1, tiles.slice(span), running);
            ecs.updateClient(100);
            assert.equal(ecs.getY(index), fine(100 + span * 2), "held keys cannot repeatedly extend an unconfirmed route");
            sync.stopKeyboardMovement(1);
            sync.predictKeyboardMovement(1, tiles.slice(span), running);
            sync.stopKeyboardMovement(1);
            ecs.updateClient(100);
            assert.equal(ecs.getY(index), fine(100 + span), "release before a client cycle discards prediction");

            sync.predictKeyboardMovement(1, tiles.slice(span), running);
            ecs.updateClient(3);
            const beforeCorrection = ecs.getY(index);
            sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(101), y: fine(100 + span),
                level: 0, moved: true, directions: [MovementDirection.East], traversals: [1] });
            assert.equal(ecs.getY(index), beforeCorrection, "a disagreement corrects smoothly");
            ecs.updateClient(100);
            assert.deepEqual([ecs.getX(index), ecs.getY(index)], [fine(101), fine(100 + span)]);
        }
    } finally {
        Date.now = originalNow;
    }
}
console.log("keyboard movement prediction checks passed");

{
    const ecs = new PlayerEcs();
    const index = ecs.allocatePlayer(1);
    ecs.teleport(index, 100, 100);
    ecs.setRotationImmediate(index, 1024);
    const sync = new PlayerMovementSync(ecs);
    sync.registerEntity({ serverId: 1, ecsIndex: index, tile: { x: 100, y: 100 },
        level: 0, subX: fine(100), subY: fine(100) });
    sync.predictKeyboardMovement(1, [{ x: 100, y: 101 }], false);
    ecs.updateClient(5);
    const beforeTurn = ecs.getY(index);
    sync.predictKeyboardMovement(1, [{ x: 101, y: 100 }], false);
    assert.equal(ecs.getY(index), beforeTurn, "steering preserves the current drawn position");
    ecs.updateClient();
    assert.ok(ecs.getY(index) >= beforeTurn, "steering does not rewind the active step to an old origin");
    sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(101), y: fine(100),
        level: 0, moved: true, directions: [MovementDirection.East], traversals: [1] });
    ecs.updateClient(100);
    assert.deepEqual([ecs.getX(index), ecs.getY(index)], [fine(101), fine(100)], "turned prediction is acknowledged once");

    sync.predictKeyboardMovement(1, [{ x: 101, y: 101 }, { x: 101, y: 102 }], true);
    ecs.updateClient();
    sync.stopKeyboardMovement(1);
    sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(101), y: fine(102), level: 0,
        running: true, moved: true, directions: [MovementDirection.North, MovementDirection.North], traversals: [2, 2] });
    ecs.updateClient(100);
    assert.equal(ecs.getY(index), fine(102), "release cannot discard a step the server already accepted");
    sync.predictKeyboardMovement(1, [{ x: 101, y: 103 }, { x: 101, y: 104 }], true);
    ecs.updateClient(3);
    sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(101), y: fine(103), level: 0,
        running: false, moved: true, directions: [MovementDirection.North], traversals: [1] });
    sync.predictKeyboardMovement(1, [{ x: 101, y: 104 }, { x: 101, y: 105 }], true);
    ecs.updateClient(100);
    assert.equal(ecs.getY(index), fine(104), "partial acknowledgement cannot extend speculation past its original tick");
}

// Continuous angled input, speed changes and a late reply must never replay the
// old authoritative origin. Sample every visual cycle, not only final positions.
{
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
        const ecs = new PlayerEcs();
        const index = ecs.allocatePlayer(1);
        ecs.teleport(index, 100, 100);
        ecs.setRotationImmediate(index, 1024);
        const sync = new PlayerMovementSync(ecs, undefined, undefined, undefined, undefined, () => 0);
        sync.registerEntity({ serverId: 1, ecsIndex: index, tile: { x: 100, y: 100 },
            level: 0, subX: fine(100), subY: fine(100) });
        let previousY = ecs.getY(index);
        const advance = (cycles: number) => {
            for (let n = 0; n < cycles; n++) {
                ecs.updateClient();
                assert.ok(ecs.getY(index) >= previousY, "held forward motion cannot reverse on reconciliation");
                previousY = ecs.getY(index);
            }
        };
        for (let tick = 0; tick < 8; tick++) {
            const tile = sync.getState(1)!;
            const startY = tile.tileY;
            const input = [1, 2, 3, 4].map(n => ({ x: tile.tileX + Math.round(n / 4), y: startY + n }));
            sync.predictKeyboardMovement(1, input, true);
            advance(4);
            // A speed/heading change while the acknowledgement is in flight
            // previously queued a walk back to the old origin.
            sync.predictKeyboardMovement(1, input.slice(0, 2), false);
            advance(30);
            if (tick === 3) {
                now += 1600;
                sync.updateInteractionRotations();
                advance(10);
            }
            const x = tile.tileX + (tick === 5 ? 1 : 0);
            sync.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(x), y: fine(startY + 2),
                level: 0, running: true, moved: true });
            advance(30);
        }
    } finally {
        Date.now = originalNow;
    }
}
console.log("continuous keyboard reconciliation checks passed");

// Appearance packets can arrive between a movement tick and a render frame.
// Refreshing the animation metadata must not briefly render an idle pose at a run frame.
for (const continuous of [false, true]) for (const running of [false, true]) {
    const ecs = new PlayerEcs();
    const index = ecs.allocatePlayer(1);
    ecs.teleport(index, 100, 100);
    ecs.setRotationImmediate(index, 1024);
    const animations = { idle: 808, walk: 819, run: 824 };
    ecs.setAnimSet(index, animations);
    assert.equal(ecs.getAnimMovementSeqId(index), animations.idle,
        "a stationary player initializes to idle");
    if (continuous) ecs.setContinuousPosition(index, fine(100), fine(100) + 4,
        0, 1, running, true, 1024);
    else ecs.setServerPos(index, fine(100), fine(101), running ? 2 : 1);
    ecs.updateClient();
    const sequence = running ? 824 : 819;
    assert.equal(ecs.getAnimMovementSeqId(index), sequence);
    const position = [ecs.getX(index), ecs.getY(index)];
    // Assert before the next tick, when the recorded one-frame flash occurs.
    ecs.setAnimSet(index, animations);
    assert.equal(ecs.getAnimMovementSeqId(index), sequence,
        "an appearance refresh between ticks preserves the walking/running pose");
    assert.deepEqual([ecs.getX(index), ecs.getY(index)], position);
    ecs.setAnimSet(index, { ...animations, walk: 820, run: 825 });
    assert.equal(ecs.getAnimMovementSeqId(index), sequence,
        "equipment animation changes wait for the movement tick to select a coherent pose");
    ecs.updateClient();
    assert.equal(ecs.getAnimMovementSeqId(index), running ? 825 : 820);
    if (continuous) continue;
    ecs.updateClient(100);
    assert.equal(ecs.isMoving(index), false);
    ecs.setAnimSet(index, { ...animations, idle: 809 });
    assert.equal(ecs.getAnimMovementSeqId(index), 809,
        "a stationary appearance refresh still applies the new idle animation");
}
console.log("appearance refresh movement animation checks passed");

// Exercise the real movement input codec, server plugin, acknowledgement codec,
// prediction, collision footprint, and the handoff back to native tile routes.
function checkFreeMovement() {
    const { ContinuousMovement } = require("../game/movement/ContinuousMovement");
    const { encodeClientMessage } = require("../network/packet/ClientBinaryEncoder");
    const { decodeServerPacket } = require("../network/packet/ServerBinaryDecoder");
    const { decodeClientPackets, encodeFinePosition } = require("../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol");
    const { Location } = require("../../server/src/main/typescript/elvarg/game/model/Location");
    const plugin = require("../../server/plugins/movement/FreeMovement.plugin.js");
    const { RADIUS, moveContinuous, WALK_SPEED, MAX_PREDICTION_MS } = require("../../server/plugins/movement/ContinuousMotion.js");
    const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
    let now = 1000;
    Object.defineProperty(performance, "now", { configurable: true, value: () => now });
    try {
        let location = new Location(100, 100), mobile = true, running = false, energy = 100;
        let wall = false, teleporter: any, process: any, delayReplies = false, delayInputs = false;
        const delayedInputs: any[] = [];
        const delayedReplies: any[] = [];
        const hooks = new Map<string, Function>();
        const packets: Buffer[] = [];
        const ecs = new PlayerEcs();
        const index = ecs.allocatePlayer(1);
        ecs.teleport(index, 100, 100);
        const core = { Location, encodeFinePosition, Mobile: { onBeforeTeleport(fn: any) { teleporter = fn; } } };
        plugin.register({ core, onCustomEvent: (name: string, fn: Function) => hooks.set(name, fn),
            onPlayerProcess: (fn: any) => { process = fn; }, onPlayerLogout() {} });
        const queue = { getMobility: () => ({ canMove: () => mobile }), reset() {}, walkToReset() {},
            setExternalMovement() {}, handleRegionChange() {},
            canWalkTo: (to: any) => !wall || to.getX() < 101 };
        let movement: InstanceType<typeof ContinuousMovement>;
        const player = { getIndex: () => 1, getLocation: () => location,
            setLocation: (to: any) => { location = to; }, getMovementQueue: () => queue,
            getHitpoints: () => 10, getRunEnergy: () => energy, setRunEnergy: (value: number) => { energy = value; },
            getCombat: () => ({ reset() {} }), setFollowing() {}, setMobileInteraction() {}, setPositionToFace() {},
            closeInterruptibleInterfaces() {}, isRunningReturn: () => running, setRunning: (value: boolean) => { running = value; },
            getPacketSender: () => ({ sendRunEnergy() {}, sendRunStatus() {} }), getPrivateArea: () => null,
            getLocalPlayers: () => [], getForceMovement: () => null, isNeedsPlacement: () => false,
            getSession: () => ({ sendClientPacket(packet: Buffer) {
                packets.push(packet);
                const decoded = decodeServerPacket(packet)!;
                assert.equal(decoded.type, "movement_position");
                if (delayReplies) delayedReplies.push(decoded.payload);
                else movement.receive(decoded.payload);
            } }) };
        movement = new ContinuousMovement(ecs, () => 1, command => {
            const wire = encodeClientMessage({ type: "movement_input", payload: command });
            const decoded = decodeClientPackets(Buffer.from(wire))[0];
            assert.deepEqual(decoded, { type: "movement_input", ...command });
            if (delayInputs) delayedInputs.push(decoded);
            else hooks.get("player:movement-input")!({ player, packet: decoded });
        }, (_plane, x) => wall && x >= 101 ? CollisionFlag.OBJECT : 0);
        const tick = () => { now += 20; movement.tick(); ecs.updateClient(); };
        movement.setInput(1, 0, false, 1536);
        for (let i = 0; i < 8; i++) tick();
        assert.ok(ecs.getX(index) > fine(100) && ecs.getX(index) < 101 * 128,
            "movement advances within the tile before crossing its boundary");
        assert.equal(location.getX(), 100, "interactions use the tile actually occupied");
        movement.stop();
        const stopped = ecs.getX(index);
        for (let i = 0; i < 10; i++) tick();
        assert.equal(ecs.getX(index), stopped, "release stops off-centre without completing a tile");
        assert.notEqual(stopped & 127, 64);
        const idlePackets = packets.length;
        movement.stop();
        assert.equal(packets.length, idlePackets, "stationary frames do not send stop packets repeatedly");
        movement.stop(true);
        assert.equal(ecs.getX(index), stopped, "switching camera modes cannot give a free jump to the centre");
        movement.setInput(1, 0, false, 1536);
        tick();
        assert.ok(ecs.getX(index) > stopped && ecs.getX(index) <= stopped + 5,
            "re-entering free movement starts at the same sub-tile position");
        movement.setInput(0, 1, false, 1024);
        delayReplies = true;
        for (let i = 0; i < 8; i++) tick();
        const anticipated = [ecs.getX(index), ecs.getY(index)];
        for (const reply of delayedReplies.splice(0)) {
            movement.receive(reply);
            assert.deepEqual([ecs.getX(index), ecs.getY(index)], anticipated,
                "late acknowledgements never replay movement backwards");
        }
        delayReplies = false;
        const tileSync = new PlayerMovementSync(ecs);
        tileSync.registerEntity({ serverId: 1, ecsIndex: index,
            tile: { x: location.getX(), y: location.getY() }, level: 0 });
        tileSync.receiveUpdate({ serverId: 1, ecsIndex: index,
            x: fine(location.getX()), y: fine(location.getY()), level: 0, teleport: true });
        assert.deepEqual([ecs.getX(index), ecs.getY(index)], anticipated,
            "native tile snapshots cannot snap continuous movement back to a tile centre");
        wall = true;
        movement.setInput(1, 0, false, 1536);
        for (let i = 0; i < 100; i++) tick();
        assert.ok(ecs.getX(index) <= 101 * 128 - RADIUS, "the footprint stops before a blocked tile");
        const wallY = ecs.getY(index);
        movement.setInput(1, 1, false, 1536);
        for (let i = 0; i < 10; i++) tick();
        assert.ok(ecs.getX(index) <= 101 * 128 - RADIUS && ecs.getY(index) > wallY + 20, "diagonal steering slides along the wall");
        mobile = false;
        const frozen = [ecs.getX(index), ecs.getY(index)];
        for (let i = 0; i < 8; i++) tick();
        assert.deepEqual([ecs.getX(index), ecs.getY(index)], frozen, "server mobility restrictions stop sub-tile movement too");
        mobile = true;
        wall = false;
        movement.setInput(0, 1, true, 1024);
        const runStart = ecs.getY(index);
        for (let i = 0; i < 30; i++) tick();
        assert.ok(Math.abs(ecs.getY(index) - runStart - 256) <= 1, "running travels two tiles per server tick, not more");
        assert.ok(energy < 100, "continuous running consumes run energy");
        // A busy render frame / network jitter can deliver several 20ms inputs together.
        // Every acknowledged input must retain its movement time within the prediction window.
        const burstStart = ecs.getY(index);
        delayInputs = true;
        for (let i = 0; i < 9; i++) tick();
        delayInputs = false;
        for (const packet of delayedInputs.splice(0)) hooks.get("player:movement-input")!({ player, packet });
        const beforeCorrection = ecs.getY(index);
        tick();
        assert.ok(ecs.getY(index) >= beforeCorrection,
            "batched movement inputs cannot pull a forward-running player backwards");
        for (let i = 0; i < 10; i++) tick();
        assert.ok(Math.abs(ecs.getY(index) - burstStart - WALK_SPEED * 400 * 2) <= 1,
            "jittered inputs retain the same distance as evenly delivered inputs");
        // A hosted world acknowledges each input a full internet round trip later.
        const rttStart = ecs.getY(index);
        const inFlight: any[][] = [];
        delayReplies = true;
        for (let i = 0; i < 50; i++) {
            tick();
            inFlight.push(delayedReplies.splice(0));
            if (inFlight.length > 10) for (const reply of inFlight.shift()!) movement.receive(reply);
        }
        delayReplies = false;
        for (const replies of inFlight.splice(0)) for (const reply of replies) movement.receive(reply);
        assert.ok(Math.abs(ecs.getY(index) - rttStart - WALK_SPEED * 1000 * 2) <= 1,
            "a 200ms round trip does not stall or slow movement");
        const catchUpStart = ecs.getY(index);
        delayInputs = true;
        now += 1000;
        for (let i = 0; i < 50; i++) { movement.tick(); ecs.updateClient(); }
        assert.equal(delayedInputs.length, MAX_PREDICTION_MS / 20,
            "client catch-up never sends more movement time than the bounded clock window");
        delayInputs = false;
        for (const packet of delayedInputs.splice(0)) hooks.get("player:movement-input")!({ player, packet });
        const afterCatchUp = ecs.getY(index);
        tick();
        assert.ok(ecs.getY(index) >= afterCatchUp, "catch-up acknowledgements cannot reverse forward movement");
        assert.ok(Math.abs(ecs.getY(index) - catchUpStart - WALK_SPEED * (MAX_PREDICTION_MS + 20) * 2) <= 1,
            "a long stall resumes from bounded prediction, without a correction jump");
        const view: any = {};
        hooks.get("player:sync-view")!({ player, view });
        assert.equal(view.finePosition.active, true);
        const native = encodePlayerSync(1, 64, 64, 1,
            [{ index: 1, x: location.x, y: location.y, level: 0, appearance: Buffer.alloc(0), finePosition: view.finePosition }],
            createPlayerSyncState(1, location));
        assert.equal(decodeServerPacket(native)!.payload.finePositions[0].x, Math.round(view.finePosition.x * 256) / 256,
            "new observers receive the exact stop position with native player sync");
        now += 1000;
        const beforeSpam = decodeServerPacket(packets.at(-1)!)!.payload;
        for (let i = 0; i < 100; i++) hooks.get("player:movement-input")!({ player, packet: {
            type: "movement_input", seq: beforeSpam.seq + i + 1, dx: 32767, dy: 0,
            rotation: 1536, duration: 40, active: true, running: true } });
        const afterSpam = decodeServerPacket(packets.at(-1)!)!.payload;
        assert.ok(afterSpam.x - beforeSpam.x <= WALK_SPEED * MAX_PREDICTION_MS * 2 + 0.01,
            "packet flooding cannot manufacture movement time");
        const target = new Location(130, 130, 1);
        teleporter(player, target);
        location = target;
        assert.deepEqual([ecs.getX(index), ecs.getY(index), ecs.getLevel(index)], [fine(130), fine(130), 1],
            "scripted teleports supersede prediction and clear continuous movement");
        assert.equal(ecs.isContinuousMovement(index), false);
        process({ player });
        const nativeMovement = new PlayerMovementSync(ecs);
        nativeMovement.registerEntity({ serverId: 1, ecsIndex: index, tile: { x: 130, y: 130 },
            level: 1, subX: fine(130), subY: fine(130) });
        ecs.setContinuousPosition(index, fine(130) + 30, fine(130), 0, 0, false, false, 1536);
        ecs.clearContinuousPosition(index);
        const beforeClick = ecs.getX(index);
        nativeMovement.receiveUpdate({ serverId: 1, ecsIndex: index, x: fine(131), y: fine(130), level: 1,
            directions: [MovementDirection.East], traversals: [1], moved: true });
        assert.equal(ecs.getX(index), beforeClick, "click routes preserve a sub-tile starting position");
        ecs.updateClient();
        assert.ok(ecs.getX(index) > beforeClick && ecs.getX(index) <= beforeClick + 4);
        const origin = { x: fine(100), y: fine(100) };
        const cardinal = moveContinuous(origin, 1, 0, 40, () => true);
        const diagonal = moveContinuous(origin, 1, 1, 40, () => true);
        assert.ok(Math.abs(Math.hypot(diagonal.x - origin.x, diagonal.y - origin.y) - (cardinal.x - origin.x)) < 1e-6,
            "diagonal input has the same speed as cardinal input");
    } finally {
        if (originalNow) Object.defineProperty(performance, "now", originalNow);
        else delete (performance as any).now;
    }
}
checkFreeMovement();
console.log("continuous sub-tile movement checks passed");
