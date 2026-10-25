// Run after yarn build: node --test tests/thieving-stalls.test.cjs
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const Thieving = require('../plugins/skills/Thieving.plugin');
const { handleStealFromStall: steal, STALLS, depleted, emptyStallId } = Thieving._test;
const core = PluginManager.getCoreApi();
const O = core.ObjectIdentifiers;
const I = core.ItemIdentifiers;
const hooks = new Map();
let tick, tasks, npcs, objects, events, realObjects = false;
core.ItemDefinition.forId = (id) => ({ getName: () => `item ${id}` });
Thieving.register({
    core: {
        ...core,
        World: { getProcessCycle: () => tick, getNpcsNear: (at, radius, area) => npcs.filter((npc) => npc.getLocation().getDistance(at) <= radius && npc.area === area) },
        RegionManager: { canProjectileAttackBounds: (at) => npcs.find((npc) => npc.getLocation() === at).visible },
        TaskManager: { submit: (task) => { task.setRunning(true); tasks.push(task); } },
        ObjectManager: {
            register: (object) => { objects.push(['add', object]); if (realObjects) core.ObjectManager.register(object, false); },
            deregister: (object) => { objects.push(['remove', object]); if (realObjects) core.ObjectManager.deregister(object, false); },
        },
    },
    onCustomEvent() {}, onNpcsInteraction() {}, onNpcInteraction() {}, onItemAction() {}, log() {},
    onObjectInteraction: (name, actions) => hooks.set(name, actions),
    emitCustomEvent: (name, request) => events.push([name, request]),
});
beforeEach(() => { tick = 100; tasks = []; npcs = []; objects = []; events = []; });
function advance(count = 1) {
    for (let i = 0; i < count; i++) {
        tick++;
        for (const task of [...tasks]) if (task.isRunning()) task.tick();
    }
}
function player({ level = 99, full = false, area = null } = {}) {
    const items = [], xp = [], messages = [];
    return {
        items, xp, messages,
        getSkillManager: () => ({ getCurrentLevel: () => level, addExperiences: (_skill, amount) => xp.push(amount) }),
        getClickDelay: () => ({ elapsedTime: () => true, reset() {} }),
        getInventory: () => ({ isFull: () => full, full: () => messages.push('full'), addItem: (item) => items.push(item) }),
        getLocation: () => new core.Location(3200, 3200), getPrivateArea: () => area,
        setPositionToFace() {}, performAnimation() {}, sendMessage: (message) => messages.push(message),
    };
}
function object(id = O.SPICE_STALL_3, area = null) {
    return new core.GameObject(id, new core.Location(3200, 3201), 10, 2, area);
}
function click(who, stallObject, name = 'Spice stall') {
    const event = { player: who, object: stallObject, definition: { getName: () => name } };
    steal(event);
    return event;
}
function npc(name, { visible = true, attackable = false, hp = 10, area = null, x = 3201, target = null } = {}) {
    const at = new core.Location(x, 3200);
    const lookout = {
        visible, area, chats: [], attacks: [],
        getDefinition: () => ({ getName: () => name, isAttackable: () => attackable }),
        getLocation: () => at, getSize: () => 1, getHitpoints: () => hp,
        forceChat: (line) => lookout.chats.push(line),
        getCombat: () => ({ getTarget: () => target, attack: (who) => lookout.attacks.push(who) }),
    };
    npcs.push(lookout);
    return lookout;
}

test('registers the cache names/options and resolves every reward symbol', () => {
    assert.equal(hooks.get('Silver stall')['Steal-from'], steal);
    assert.equal(hooks.get('Spice stall')['Steal-from'], steal);
    assert.equal(hooks.get('Market stall')['Steal-From'], steal);
    for (const stall of STALLS.values()) for (const [name] of stall.rewards) assert.ok(I[name] > 0, name);
});

test('silver, spice and wine grant loot/XP and restock at their Wiki intervals', () => {
    for (const [name, id, xp, ticks] of [
        ['Silver stall', O.SILVER_STALL_3, 205, 32],
        ['Spice stall', O.SPICE_STALL_3, 92, 10],
        ['Market stall', O.MARKET_STALL_14, 27, 8],
    ]) {
        const who = player(), stallObject = object(id);
        assert.equal(click(who, stallObject, name).handled, true);
        assert.equal(who.items.length, 1);
        assert.deepEqual(who.xp, [xp]);
        assert.equal(events.at(-1)[0], 'thieving:success');
        advance();
        assert.equal(objects.at(-1)[1].getId(), emptyStallId(stallObject));
        assert.equal(objects.at(-1)[1].getFace(), stallObject.getFace());
        click(who, stallObject, name); // Stale queued clicks cannot bypass depletion.
        assert.equal(who.items.length, 1);
        advance(ticks - 2);
        assert.ok(depleted.has(stallObject));
        advance();
        assert.ok(!depleted.has(stallObject));
        assert.equal(objects.at(-1)[1], stallObject);
        click(who, stallObject, name);
        assert.equal(who.items.length, 2);
    }
});

test('depletion is shared, permits simultaneous thieves and leaves other stalls alone', () => {
    const a = player(), b = player(), stall = object(), other = object();
    click(a, stall);
    click(b, stall);
    assert.equal(a.items.length, 1);
    assert.equal(b.items.length, 1);
    assert.equal(tasks.length, 2, 'one removal and one respawn for both thieves');
    advance();
    click(b, stall);
    assert.equal(b.items.length, 1);
    click(b, other);
    assert.equal(b.items.length, 2);
});

test('the empty wine stall and unrelated market stalls never grant loot', () => {
    for (const id of [O.MARKET_STALL_15, O.MARKET_STALL]) {
        const who = player();
        click(who, object(id), 'Market stall');
        assert.equal(who.items.length, 0);
        assert.equal(tasks.length, 0);
    }
});

test('visible guards catch and attack thieves, preventing loot, XP, pets and depletion', () => {
    const who = player(), stall = object();
    const guard = npc('Guard', { attackable: true });
    click(who, stall);
    assert.deepEqual(guard.attacks, [who]);
    assert.ok(who.messages.includes("You've been caught stealing!"));
    assert.equal(who.items.length, 0);
    assert.equal(who.xp.length, 0);
    assert.equal(events.length, 0);
    assert.ok(!depleted.has(stall));
});

test('the owner calls a nearby guard even if that guard cannot see the thief', () => {
    const who = player();
    const guard = npc('Guard', { attackable: true, visible: false });
    const owner = npc('Spice seller');
    click(who, object());
    assert.equal(owner.chats.length, 1);
    assert.deepEqual(guard.attacks, [who]);
    assert.equal(who.items.length, 0);
});

test('blocked, dead, distant, other-instance guards and unrelated owners cannot catch thieves', () => {
    npc('Guard', { attackable: true, visible: false });
    npc('Guard', { attackable: true, hp: 0 });
    npc('Guard', { attackable: true, x: 3210 });
    npc('Guard', { attackable: true, area: {} });
    npc('Silver merchant');
    npc(undefined);
    npc('Guard', { attackable: true, target: player() });
    const who = player();
    click(who, object());
    assert.equal(who.items.length, 1);
});

test('level and inventory checks prevent theft and depletion', () => {
    for (const who of [player({ level: 64 }), player({ full: true })]) {
        const stall = object();
        assert.equal(click(who, stall).handled, true);
        assert.equal(who.items.length, 0);
        assert.ok(!depleted.has(stall));
    }
    assert.equal(tasks.length, 0);
});

test('existing stalls use current restock times and market-specific empty models', () => {
    for (const [name, id, ticks, empty] of [
        ["Baker's stall", O.BAKERS_STALL, 4, O.MARKET_STALL],
        ['Bakery stall', O.BAKERY_STALL_2, 16, O.MARKET_STALL_12],
        ["Baker's Stall", O.BAKERS_STALL_2, 4, O.EMPTY_STALL],
        ['Silk stall', O.SILK_STALL_5, 8, O.MARKET_STALL_25],
        ['Gem stall', O.GEM_STALL_6, 100, O.MARKET_STALL_25],
        ['Fur stall', O.FUR_STALL_7, 12, O.MARKET_STALL_28],
        ['Tea stall', O.TEA_STALL, 4, O.MARKET_STALL],
        ['Seed Stall', O.SEED_STALL, 4, O.MARKET_STALL],
    ]) {
        tasks = [];
        const stall = object(id);
        click(player(), stall, name);
        assert.equal(tasks[1].getDelay(), ticks, name);
        assert.equal(emptyStallId(stall), empty, name);
    }
});

test('destroying a private area before restock never resurrects its objects', () => {
    let destroyed = false;
    const area = { add: (entity) => entity.setArea(area), getObjects: () => [], isDestroyed: () => destroyed };
    const stall = object(O.SPICE_STALL_3, area);
    click(player({ area }), stall);
    advance();
    objects = [];
    destroyed = true;
    advance(9);
    assert.equal(objects.length, 0);
    assert.ok(!depleted.has(stall));
});

test('a depleted private stall remains resolvable and is removed when its instance is destroyed', () => {
    const area = new core.PrivateArea();
    const stall = object(O.SPICE_STALL_3, area);
    area.add(stall);
    core.ObjectManager.register(stall, false);
    realObjects = true;
    try {
        click(player({ area }), stall);
        advance();
        const empty = area.getObjects()[0];
        assert.ok(empty, 'the replacement belongs to the instance');
        assert.equal(empty.getId(), emptyStallId(stall));
        assert.equal(core.MapObjects.get(empty.getId(), empty.getLocation(), area), empty);
        area.destroy();
        advance(9);
        assert.equal(core.ObjectManager.objectsAt(stall.getLocation()).some((o) => o.getPrivateArea() === area), false);
        assert.equal(core.World.getRemovedObjects().some((o) => o.getPrivateArea() === area), false);
        assert.equal(area.getObjects().length, 0);
    } finally {
        area.destroy();
        realObjects = false;
    }
});

test('Port Roberts stalls keep their stock instead of acquiring classic stall depletion', () => {
    const stall = object(O.SILVER_STALL_7), who = player();
    click(who, stall, 'Silver stall');
    assert.equal(who.items.length, 1);
    assert.equal(tasks.length, 0);
});

test('standing under the baker remains a safe spot', () => {
    const baker = npc('Baker', { x: 3200 });
    const who = player();
    click(who, object(O.BAKERS_STALL), "Baker's stall");
    assert.equal(who.items.length, 1);
    assert.equal(baker.chats.length, 0);
});
