// Run after `yarn build`: node --test tests/staff-cast-animations.test.cjs
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheIndexDat2 } = require("../dist/game/cache/codec/rs/cache/CacheIndex");
const { ConfigType } = require("../dist/game/cache/codec/rs/cache/ConfigType");
const { IndexType } = require("../dist/game/cache/codec/rs/cache/IndexType");
const { Gamevals, GamevalKind } = require("../dist/game/cache/Gamevals");
const { CombatSpells } = require("../dist/game/content/combat/magic/CombatSpells");

const BIND = 710; // human_castentangle
const BIND_STAFF = 1161; // human_castentangle_staff

let seqs;
let seqNames;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  seqs = CacheIndexDat2.fromStore(IndexType.DAT2.configs, CachePipeline.getStore()).getArchive(ConfigType.DAT2.seqs);
  seqNames = new Gamevals().namesOf(GamevalKind.SEQ);
});

/** The opcodes these casting sequences use (rev 241); hands are item + 512, 0 empties the hand. */
function decodeSeq(id) {
  const bytes = Uint8Array.from(seqs.getFile(id).data);
  let i = 0;
  const u8 = () => bytes[i++];
  const u16 = () => (u8() << 8) | u8();
  const seq = { frames: null, leftHand: -1, rightHand: -1 };
  for (let opcode = u8(); opcode !== 0; opcode = u8()) {
    if (opcode === 1) {
      const count = u16();
      const lengths = Array.from({ length: count }, u16);
      const low = Array.from({ length: count }, u16);
      const high = Array.from({ length: count }, u16);
      seq.frames = lengths.map((length, frame) => `${(high[frame] << 16) + low[frame]}x${length}`);
    } else if (opcode === 5 || opcode === 11 || opcode === 16) {
      u8();
    } else if (opcode === 6) {
      seq.leftHand = u16();
    } else if (opcode === 7) {
      seq.rightHand = u16();
    } else {
      throw new Error(`seq ${id}: opcode ${opcode} isn't decoded here`);
    }
  }
  return seq;
}

function caster({ player = true, staff = false } = {}) {
  const played = [];
  const mobile = {
    isPlayer: () => player,
    isNpc: () => !player,
    getAsPlayer: () => mobile,
    getEquipment: () => ({ hasStaffEquipped: () => staff }),
    performAnimation: (animation) => played.push(animation.getId()),
    performGraphic: () => {},
  };
  return { mobile, played };
}

test("every twin is the cache's _staff copy of the cast: the same frames, with the staff kept in hand", () => {
  for (const name of ["BIND", "WIND_STRIKE", "CONFUSE", "WEAKEN", "CURSE", "CRUMBLE_UNDEAD", "WIND_WAVE", "ENFEEBLE", "STUN", "TELEBLOCK"]) {
    const spell = CombatSpells[name];
    const plain = spell.castAnimation().getId();
    const staff = spell.castAnimationFor(caster({ staff: true }).mobile).getId();
    assert.equal(seqNames.get(staff), `${seqNames.get(plain)}_staff`, `seq ${staff}`);
    const [cast, staffCast] = [decodeSeq(plain), decodeSeq(staff)];
    assert.deepEqual(staffCast.frames, cast.frames, `${plain} and ${staff} frames`);
    assert.equal(cast.rightHand, 0, `${seqNames.get(plain)} empties the weapon hand`);
    assert.equal(staffCast.rightHand, -1, `${seqNames.get(staff)} keeps the weapon`);
  }
});

test("Bind casts with the staff twin only when a player wields a staff", () => {
  assert.equal(CombatSpells.BIND.castAnimation().getId(), BIND);
  assert.equal(CombatSpells.BIND.castAnimationFor(caster({ staff: true }).mobile).getId(), BIND_STAFF);
  assert.equal(CombatSpells.BIND.castAnimationFor(caster({ staff: false }).mobile).getId(), BIND, "a sword is put away");
  assert.equal(CombatSpells.BIND.castAnimationFor(caster({ player: false, staff: true }).mobile).getId(), BIND, "only players");
  for (const spell of [CombatSpells.SNARE, CombatSpells.ENTANGLE]) {
    assert.equal(spell.castAnimationFor(caster({ staff: true }).mobile).getId(), BIND_STAFF);
  }
});

test("the cast plays the twin, and a spell with no twin keeps its own animation", () => {
  const bind = Object.create(CombatSpells.BIND);
  bind.castProjectile = () => null;
  const withStaff = caster({ staff: true });
  bind.startCast(withStaff.mobile, caster().mobile);
  assert.deepEqual(withStaff.played, [BIND_STAFF]);

  const surge = CombatSpells.FIRE_SURGE.castAnimation().getId();
  assert.equal(CombatSpells.FIRE_SURGE.castAnimationFor(caster({ staff: true }).mobile).getId(), surge);
});

test("the POH elemental balance casts through the house handler with the staff twin", (t) => {
  const { PluginManager } = require("../dist/plugins/PluginManager");
  const { Location } = require("../dist/game/model/Location");
  const { TaskManager } = require("../dist/game/task/TaskManager");
  require("../plugins/skills/construction/Core.Construction").init({ core: PluginManager.getCoreApi() });
  const { PlayerHouseInstance } = require("../plugins/skills/construction/Instance.Construction");
  const balance = require("../plugins/skills/construction/ElementalBalance.Construction");
  const location = new Location(6400, 6400, 0);
  const house = Object.assign(Object.create(PlayerHouseInstance.prototype), {
    buildingMode: false,
    getFurnitureAt: () => ({ buildableKey: "LESSER_MAGICAL_BALANCE" }),
    enter() {}, hideFurniture() {}, getPlayers: () => [],
  });
  const npc = { getLocation: () => location, isRegistered: () => true };
  t.mock.method(PluginManager, "spawnNpc", () => npc);
  let activate;
  balance.attachElementalBalance({
    onObjectInteraction: (_name, handlers) => { activate = handlers.Activate; },
    onNpcInteraction() {},
  });
  const { mobile: player, played } = caster({ staff: true });
  const deleted = [];
  Object.assign(player, {
    getPrivateArea: () => house, getLocation: () => location,
    getSkillManager: () => ({ getCurrentLevel: () => 99 }),
    getInventory: () => ({ getAmount: () => 100, delete: (id, amount) => deleted.push([id, amount]) }),
    getMovementQueue: () => ({ reset() {} }), setPositionToFace() {},
  });
  t.after(() => TaskManager.cancelTasks(player));
  assert.equal(activate({ player, location }), true);
  t.mock.method(CombatSpells.WIND_STRIKE, "castProjectile", () => null);
  assert.equal(house.canCastOnNpc(player, npc, CombatSpells.WIND_STRIKE), false);
  assert.deepEqual(played, [1162]);
  assert.deepEqual(deleted, CombatSpells.WIND_STRIKE.itemsRequired(player).map(item => [item.getId(), item.getAmount()]));
  assert.ok(deleted.length > 0, "the actual balance cast consumed its runes");
});
