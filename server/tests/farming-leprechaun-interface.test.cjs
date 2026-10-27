const assert = require('node:assert/strict');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Services, logoutHooks = [];
function logout(event) { for (const handler of logoutHooks) handler(event); }
const actions = [];
const uid = name => core.CacheDefinitions.getComponentId(name);
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Data.initializeFarmingData();
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (name === 'onInterfaceActionClick') actions.push(args[0]);
        if (name === 'onPlayerLogout') logoutHooks.push(args[0]);
    } }));
});
function prepare(t, stored = {}, metadata = {}) {
    const player = new Player(null), messages = [];
    player.getSession = () => ({ sendClientPacket: () => true });
    player.sendMessage = text => messages.push(text);
    player.moveTo(new core.Location(2810, 3464, 0));
    player.setNeedsPlacement(false);
    const sender = player.getPacketSender(), inventory = player.getInventory();
    const farm = { offset: 0, patches: {}, tools: {}, toolMeta: {} };
    for (const [name, count] of Object.entries(stored)) farm.tools[Data.itemId(name)] = count;
    for (const [name, meta] of Object.entries(metadata)) farm.toolMeta[Data.itemId(name)] = meta;
    player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    const npc = core.NPC.create(core.CacheDefinitions.getNpcId('farming_tools_leprechaun'), new core.Location(2810, 3464, 0));
    const open = () => Services.farmingNpc({ player, npc, clickType: 1,
        definition: { getName: () => 'Tool Leprechaun', getActions: () => ['Exchange'] } });
    const click = (name, opId = 1) => {
        assert.ok(actions.length > 0, 'Farming must register native interface action handlers');
        const event = { player, buttonId: uid(name), opId, action: opId, handled: false };
        for (const action of actions) {
            if (event.handled) break;
            action(event);
        }
        return event;
    };
    return { player, inventory, sender, farm, messages, open, click,
        count: name => inventory.getAmount(Data.itemId(name)),
        stored: name => farm.tools[Data.itemId(name)] ?? 0,
        bit: name => sender.getVarbit(core.CacheDefinitions.getVarbitId(name)),
        add: (name, n = 1, meta) => inventory.add(new core.Item(Data.itemId(name), n, meta), false),
        enterAmount: n => player.getEnteredAmountAction().execute(n) };
}
test('Exchange mounts both native screens and mirrors packed quantities', t => {
    const f = prepare(t, { Rake: 99, 'Magic secateurs': 4, Bucket: 999, Compost: 700, Supercompost: 650, Ultracompost: 500 });
    f.open();
    assert.equal(f.sender.isSubInterfaceOpen(125), true);
    assert.equal(f.sender.isSubInterfaceOpen(126), true);
    assert.equal(f.bit('farming_tools_rake') + 2 * f.bit('farming_tools_extrarakes'), 99);
    assert.equal(f.bit('farming_tools_secateurs') + 2 * f.bit('farming_tools_extrasecateurs'), 4);
    assert.equal(f.bit('farming_tools_fairysecateurs'), 1);
    assert.equal(f.bit('farming_tools_buckets') + 32 * f.bit('farming_tools_extrabuckets') + 256 * f.bit('farming_tools_extra2buckets'), 999);
    assert.equal(f.bit('farming_tools_compost') + 256 * f.bit('farming_tools_extracompost'), 700);
});
test('side panel deposits and main panel withdraws the selected quantity', t => {
    const f = prepare(t);
    f.add('Rake', 9);
    f.open();
    f.click('farming_tools:quantity_5');
    f.click('farming_tools_side:rake');
    assert.equal(f.stored('Rake'), 5);
    assert.equal(f.count('Rake'), 4);
    f.click('farming_tools:rake', 2); // In mode5 the second op is Remove-1.
    assert.equal(f.stored('Rake'), 4);
    assert.equal(f.count('Rake'), 5);
    f.click('farming_tools:rake');
    assert.equal(f.stored('Rake'), 0);
    assert.equal(f.count('Rake'), 9);
});
test('noted deposits respect capacity and noted withdrawals use the native Banknotes op', t => {
    const f = prepare(t, { Compost: 990 });
    const note = core.CacheDefinitions.getItem(Data.itemId('Compost')).note;
    f.inventory.add(new core.Item(note, 50), false);
    f.open();
    f.click('farming_tools:quantity_all');
    f.click('farming_tools_side:compost');
    assert.equal(f.stored('Compost'), 1000);
    assert.equal(f.inventory.getAmount(note), 40);
    f.click('farming_tools:compost', 9);
    assert.equal(f.stored('Compost'), 0);
    assert.equal(f.inventory.getAmount(note), 1040);
});
test('selected-X transfers use the entered amount and recheck open screens and distance', t => {
    const f = prepare(t, { Spade: 20 });
    f.open();
    f.click('farming_tools:quantity_x');
    f.enterAmount(7);
    f.click('farming_tools:spade');
    assert.equal(f.count('Spade'), 7);
    assert.equal(f.stored('Spade'), 13);
    f.click('farming_tools:spade');
    f.player.moveTo(new core.Location(3200, 3200, 0));
    // A selected-X action may prompt again; if so the delayed answer must stay inert.
    f.player.getEnteredAmountAction()?.execute(10);
    assert.equal(f.stored('Spade'), 6);
    f.click('farming_tools:spade', 4);
    assert.equal(f.stored('Spade'), 6);
});
test('single stored watering cans and bottomless buckets preserve metadata', t => {
    const f = prepare(t);
    f.add('Gricoller\'s can', 1, { 'farming:water': 173 });
    f.add('Bottomless compost bucket', 1, { 'farming:charges': 80, 'farming:tier': 3 });
    f.open();
    f.click('farming_tools_side:wateringcan');
    f.click('farming_tools_side:bottomless_bucket');
    assert.equal(f.bit('farming_tools_wateringcan'), 10);
    assert.equal(f.bit('farming_tools_bottomless_bucket_type'), 4);
    assert.equal(f.bit('farming_tools_bottomless_bucket_quantity'), 80);
    f.click('farming_tools:wateringcan');
    f.click('farming_tools:bottomless_bucket');
    assert.equal(f.inventory.getValidItems().find(i => i.getId() === Data.itemId("Gricoller's can")).getMetaValue('farming:water'), 173);
    assert.equal(f.inventory.getValidItems().find(i => i.getId() === Data.itemId('Bottomless compost bucket')).getMetaValue('farming:charges'), 80);
});
test('a full inventory leaves withdrawn tools in storage and closed screens reject clicks', t => {
    const f = prepare(t, { Spade: 4 });
    f.add('Bronze axe', 28);
    f.open();
    f.click('farming_tools:spade', 4);
    assert.equal(f.stored('Spade'), 4);
    f.sender.closeSubInterface(uid('toplevel_osrs_stretch:mainmodal'));
    f.inventory.deleteAtSlot(0, 1, false);
    f.click('farming_tools:spade');
    assert.equal(f.stored('Spade'), 4);
});
test('Deposit inventory stores only eligible tools, preserving unrelated items and conflicting variants', t => {
    const f = prepare(t, { 'Magic secateurs': 1 });
    f.add('Secateurs'); f.add('Rake', 2); f.add('Potato');
    f.open();
    f.click('farming_tools:deposit_all');
    assert.equal(f.stored('Rake'), 2);
    assert.equal(f.count('Secateurs'), 1);
    assert.equal(f.count('Potato'), 1);
    assert.equal(f.stored('Magic secateurs'), 1);
});
test('a double deposit cannot exceed capacity or consume the remainder', t => {
    const f = prepare(t, { Rake: 99 });
    f.add('Rake', 3); f.open();
    f.click('farming_tools:quantity_all');
    f.click('farming_tools_side:rake'); f.click('farming_tools_side:rake');
    assert.equal(f.stored('Rake'), 100);
    assert.equal(f.count('Rake'), 2);
});
test('exact last-slot withdrawals fit and a capped note stack cannot consume storage', t => {
    const f = prepare(t, { Rake: 2 });
    f.add('Bronze axe', 27); f.open(); f.click('farming_tools:rake');
    assert.equal(f.count('Rake'), 1);
    assert.equal(f.stored('Rake'), 1);
    const g = prepare(t, { Compost: 12 });
    const note = core.CacheDefinitions.getItem(Data.itemId('Compost')).note;
    g.inventory.add(new core.Item(note, 2147483647), false);
    g.add('Bronze axe', 27); g.open(); g.click('farming_tools:compost', 9);
    assert.equal(g.stored('Compost'), 12);
    assert.equal(g.inventory.getAmount(note), 2147483647);
});
test('trade and zero-hitpoint states reject pending storage inputs', t => {
    for (const state of ['trade', 'dead']) {
        const f = prepare(t, { Spade: 4 }); f.open();
        if (state === 'trade') f.player.setStatus(core.PlayerStatus.TRADING);
        else f.player.setHitpoints(0);
        f.click('farming_tools:spade');
        assert.equal(f.stored('Spade'), 4, state);
        assert.equal(f.count('Spade'), 0, state);
    }
});
test('logout and replacement sessions cancel an outstanding X answer; relog resends counts', t => {
    const f = prepare(t, { Spade: 12 });
    f.open(); f.click('farming_tools:quantity_x');
    const answer = f.player.getEnteredAmountAction();
    logout({ player: f.player });
    answer.execute(9);
    assert.equal(f.stored('Spade'), 12);
    f.sender.sendInterfaceRemoval();
    f.player.setInterfaceId(-1);
    f.open();
    assert.equal(f.bit('farming_tools_spade') + 2 * f.bit('farming_tools_extraspades'), 12);
    answer.execute(9);
    assert.equal(f.stored('Spade'), 12);
    f.click('farming_tools:spade');
    assert.equal(f.count('Spade'), 1);
});
test('zero and invalid X quantities are inert and the prompt explicitly accepts zero', t => {
    for (const amount of [0, -1, NaN, Infinity, 1.5]) {
        const f = prepare(t, { Spade: 12 });
        f.open(); f.click('farming_tools:quantity_x');
        assert.equal(f.player.getEnteredAmountAction().acceptsZero, true);
        f.enterAmount(amount);
        assert.equal(f.stored('Spade'), 12);
    }
});
for (const [name, row] of [['Magic secateurs', 'secateurs'], ['Watering can(7)', 'wateringcan']]) {
    test(`Examine uses the actual ${name} variant on both native panels`, t => {
        const f = prepare(t, { [name]: 1 });
        f.add(name); f.open();
        const expected = core.CacheDefinitions.getItem(Data.itemId(name)).examine;
        assert.ok(expected);
        f.click('farming_tools:' + row, 10);
        assert.equal(f.messages.at(-1), expected);
        f.click('farming_tools_side:' + row, 10);
        assert.equal(f.messages.at(-1), expected);
        assert.equal(f.count(name), 1);
        assert.equal(f.stored(name), 1);
    });
}
test('a stale amount callback cannot cancel a replacement session prompt', t => {
    const f = prepare(t, { Spade: 8 });
    f.open(); f.click('farming_tools:quantity_x');
    const stale = f.player.getEnteredAmountAction();
    logout({ player: f.player });
    f.sender.sendInterfaceRemoval(); f.player.setInterfaceId(-1); f.open();
    f.click('farming_tools:quantity_x');
    const fresh = f.player.getEnteredAmountAction();
    stale.execute(5);
    assert.equal(f.player.getEnteredAmountAction(), fresh);
    fresh.execute(2); f.click('farming_tools:spade');
    assert.equal(f.count('Spade'), 2);
    assert.equal(f.stored('Spade'), 6);
});
