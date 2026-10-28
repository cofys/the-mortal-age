const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, Spells, spell;
const COST = [['Astral rune', 1], ['Earth rune', 8]];
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Spells = require('../plugins/skills/farming/Spells.Farming');
    Data.initializeFarmingData();
    spell = core.CacheDefinitions.getSpellByName('Cure Plant');
    assert.ok(spell, 'resolve the spell from the active cache');
});
function fixture(t, { status = 'diseased', crop = 'RANARR', weeds = 0, type = 'HERB', level = 99, runes = true } = {}) {
    const player = new Player(null), xp = [], messages = [], animations = [], bits = new Map();
    const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => bits.get(id) ?? 0
        : name === 'sendVarbit' ? (id, value) => { bits.set(id, value); return sender; } : () => sender });
    player.getPacketSender = () => sender;
    player.sendMessage = text => messages.push(text);
    player.performAnimation = value => animations.push(value);
    player.setSpellbook(core.MagicSpellbook.LUNAR);
    const skills = player.getSkillManager();
    skills.setMaxLevels(core.Skill.MAGIC, 99, false).setCurrentLevels(core.Skill.MAGIC, level, false);
    t.mock.method(skills, 'addExperiences', (skill, amount) => { xp.push([skill, amount]); return skills; });
    t.mock.method(core.MapObjects, 'get', () => null);
    const patch = Data.CACHE.patches.find(p => p.type === type);
    assert.ok(patch);
    const farm = { offset: 0, patches: {}, tools: {} };
    const state = { ...Model.emptyPatch(Date.now(), farm), crop, weeds, status, stage: !crop ? 0 : status === 'grown' ? 4 : 1 };
    state.nextAt = Date.now() + 3600000;
    farm.patches[Data.patchKey(patch)] = state;
    player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    if (runes) for (const [name, amount] of COST) player.getInventory().add(new core.Item(Data.itemId(name), amount), false);
    const cast = () => Spells.farmingSpell({ player, spellWidget: spell.widgetId,
        spellItemId: spell.itemId, spellId: spell.widgetId }, patch);
    return { player, patch, state, cast, xp, messages, animations,
        runes: () => COST.map(([name]) => player.getInventory().getAmount(Data.itemId(name))) };
}
test('Cure Plant restores a diseased herb and awards 91.5 Farming XP plus 60 Magic XP once', t => {
    const f = fixture(t);
    f.cast();
    assert.equal(f.state.status, 'growing');
    assert.equal(f.state.stage, 1);
    assert.ok(f.state.nextAt > Date.now());
    assert.deepEqual(f.runes(), [0, 0]);
    assert.deepEqual(f.xp, [[core.Skill.MAGIC, 60], [core.Skill.FARMING, 91.5]]);
    f.cast();
    assert.equal(f.xp.length, 2, 'a healthy repeat cannot earn XP');
});
test('Cure Plant cures a pruning crop without secateurs or plant cure', t => {
    const f = fixture(t, { crop: 'OAK', type: 'TREE' });
    f.cast();
    assert.equal(f.state.status, 'growing');
    assert.deepEqual(f.xp, [[core.Skill.MAGIC, 60], [core.Skill.FARMING, 91.5]]);
    assert.deepEqual(f.runes(), [0, 0]);
});
for (const [name, options, message] of [
    ['growing crop', { status: 'growing' }, "It's growing just fine."],
    ['fully grown crop', { status: 'grown' }, "That's not diseased."],
    ['compost bin', { type: 'COMPOST', crop: null, status: 'growing' }, "Bins don't often get diseased."],
    ['weeds', { crop: null, weeds: 3, status: 'growing' }, 'The weeds are healthy enough already.'],
    ['empty patch', { crop: null, status: 'growing' }, "There's nothing there to cure."],
    ['dead crop', { status: 'dead' }, "It says 'Cure' not 'Resurrect'. Although death may arise from disease, it is not in itself a disease and hence cannot be cured. So there."],
]) test(`Cure Plant refuses ${name} with its state-specific message and no cost`, t => {
    const f = fixture(t, options);
    const original = { ...f.state };
    f.cast();
    assert.deepEqual(f.messages, [message]);
    assert.deepEqual(f.state, original);
    assert.deepEqual(f.runes(), [1, 8]);
    assert.deepEqual(f.xp, []);
    assert.deepEqual(f.animations, []);
});
test('failed ordinary casting checks cannot cure or award either skill XP', t => {
    for (const options of [{ level: 65 }, { runes: false }]) {
        const f = fixture(t, options), original = { ...f.state }, runes = f.runes();
        f.cast();
        assert.deepEqual(f.state, original);
        assert.deepEqual(f.runes(), runes);
        assert.deepEqual(f.xp, []);
        assert.deepEqual(f.animations, []);
    }
});
test('the registered object-spell hook refuses unrelated scenery with player speech and no cost', t => {
    const f = fixture(t);
    let handler;
    Patches.attach(new Proxy({}, { get: (_, name) => name === 'onSpellOnObject'
        ? value => { handler = value; } : () => {} }));
    assert.equal(typeof handler, 'function');
    const event = { player: f.player, object: { getId: () => core.ObjectIdentifiers.TREE },
        location: { x: 3200, y: 3200, z: 0 }, spellWidget: spell.widgetId,
        spellItemId: spell.itemId, spellId: spell.widgetId, handled: false };
    handler(event);
    assert.equal(event.handled, true);
    const dialogue = f.player.getDialogueManager().getCurrent();
    assert.ok(dialogue instanceof core.PlayerDialogue);
    assert.equal(dialogue.getText(), "Umm... this spell won't cure that!");
    assert.deepEqual(f.runes(), [1, 8]);
    assert.deepEqual(f.xp, []);
    assert.deepEqual(f.animations, []);
    const otherSpell = core.CacheDefinitions.getSpellByName('Fertile Soil');
    const otherEvent = { ...event, spellWidget: otherSpell.widgetId, spellId: otherSpell.widgetId,
        spellItemId: otherSpell.itemId, handled: false };
    handler(otherEvent);
    assert.equal(otherEvent.handled, false);
    assert.equal(f.player.getDialogueManager().getCurrent(), dialogue);
});
