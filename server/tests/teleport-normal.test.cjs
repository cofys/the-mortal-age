// Run after `yarn build`: node --test tests/teleport-normal.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { Location } = require('../dist/game/model/Location');
const { Sounds } = require('../dist/game/Sounds');
const { GraphicHeight } = require('../dist/game/model/GraphicHeight');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { TeleportHandler } = require('../dist/game/model/teleportation/TeleportHandler');
const { TeleportType } = require('../dist/game/model/teleportation/TeleportType');

/** A player that records, per tick, what the server would send about them. */
function recordingPlayer() {
    const ticks = [[]];
    const log = (entry) => ticks[ticks.length - 1].push(entry);
    const player = {
        getMovementQueue: () => ({
            setBlockMovement: (blocked) => {
                log(blocked ? 'locked' : 'free');
                return { reset: () => {} };
            },
            reset: () => {},
        }),
        getSkillManager: () => ({ stopSkillable: () => {} }),
        getPacketSender: () => ({
            sendInterfaceRemoval: () => {},
            sendVarbit: (id, value) => log(`varbit ${id}=${value}`),
        }),
        getCombat: () => ({ reset: () => {} }),
        getClickDelay: () => ({ reset: () => {} }),
        performAnimation: (animation) => log(`anim ${animation.getId()}${animation.getDelay() ? ` delay ${animation.getDelay()}` : ''}`),
        performGraphic: (graphic) => graphic && log(`spotanim ${graphic.getId()}`),
        setUntargetable: () => {},
        setTeleporting: () => {},
        moveTo: (location) => log(`teleport ${location.getX()},${location.getY()}`),
    };
    return { player, ticks, log, nextTick: () => ticks.push([]) };
}

test('the standard teleport: arms on cast, bubble at T+1, landing on tick 3', (t) => {
    const sendSound = Sounds.sendSound;
    Sounds.sendSound = (_player, sound) => log(`sound ${sound.getId()} delay ${sound.getDelay()}`);
    t.after(() => { Sounds.sendSound = sendSound; });
    const { player, ticks, log, nextTick } = recordingPlayer();

    // The click is handled between ticks; its sends go out with tick 0.
    TeleportHandler.teleport(player, new Location(3213, 3424, 0), TeleportType.NORMAL, false,
        () => log('arrived'));
    for (let tick = 0; tick < 6; tick++) {
        TaskManager.process();
        nextTick();
    }

    assert.deepEqual(ticks.slice(0, 4), [
        ['locked', 'anim 714', 'sound 200 delay 0'],
        ['spotanim 308'],
        [],
        ['anim 715', 'teleport 3213,3424', 'free', 'arrived'],
    ]);
    assert.deepEqual(ticks.slice(4).flat(), [], 'nothing after');
});

test('NORMAL fires the bubble from its middle step with a 15-cycle delay', () => {
    assert.equal(TeleportType.NORMAL.getStartTick(), 4, 'arrival step lands on tick 3');
    const bubble = TeleportType.NORMAL.getMiddleGraphic();
    assert.equal(bubble.getId(), 308, 'the teleport bubble');
    assert.equal(bubble.getDelay(), 15, 'client cycles, so ~T+1.5 from the T+1 middle step');
    assert.equal(bubble.getHeight(), GraphicHeight.HIGH);
    assert.equal(TeleportType.NORMAL.getStartGraphic(), null, 'no start graphic');
    assert.equal(TeleportType.NORMAL.getEndGraphic(), null, 'no landing burst');
});
