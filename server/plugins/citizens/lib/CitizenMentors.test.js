// CitizenMentors unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenMentors.test.js (plain node)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Mentors = require("./CitizenMentors");
const { getMemory } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");
const { skillStore } = require("./CitizenSkilling");

const tmpSave = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mentors-")), "mentors.json");

function mockPlayer(name, bots, x = 3200, y = 3200) {
  const said = [];
  return {
    getUsername: () => name,
    getLocalPlayers: () => bots,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    sendMessage: (m) => said.push(m),
    _said: said,
  };
}

function mockBot(name, x = 3200, y = 3200) {
  const chats = [];
  return {
    getUsername: () => name,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: (m) => chats.push(m),
    _chats: chats,
  };
}

function stubDirector(names) {
  // names: array of { username, personality }
  const roster = new Map();
  for (const n of names) {
    roster.set(n.username.toLowerCase(), {
      username: n.username,
      personality: n.personality ?? { traits: ["kind"] },
      role: "commoner",
      kingdomId: "varrock",
    });
  }
  Mentors._setDirectorGetter(() => ({ roster, isOnline: () => true }));
}

function fresh() {
  getMemory().resetForTests();
  getJournal().resetForTests();
  Mentors.getMentorStore().resetForTests();
  Mentors._resetCooldownsForTests();
}

function seedMaster(name, skill) {
  // Add XP until the citizen genuinely qualifies as a master.
  for (let i = 0; i < 40 && skillStore.getLevel(name, skill) < Mentors.MASTER_LEVEL; i++) {
    skillStore.addXp(name, skill, 25000);
  }
  assert.ok(
    skillStore.getLevel(name, skill) >= Mentors.MASTER_LEVEL,
    `${name} should be a master of ${skill}`
  );
}

// --- pure helpers ---
{
  assert.equal(Mentors.skillKeyOf({ getName: () => "Woodcutting" }), "woodcutting");
  assert.equal(Mentors.skillKeyOf({ name: "Fishing" }), "fishing");
  assert.equal(Mentors.skillKeyOf({ getName: () => "Attack" }), null, "non-citizen skill -> null");
  assert.equal(Mentors.skillKeyOf({}), null, "missing skill -> null");
  assert.equal(Mentors.skillKeyOf(null), null, "null skill -> null");

  assert.ok(!Mentors.isApprenticeLevel(1), "level 1 is not an apprentice");
  assert.ok(Mentors.isApprenticeLevel(2), "level 2 is an apprentice");
  assert.ok(Mentors.isApprenticeLevel(50), "level 50 is an apprentice");
  assert.ok(!Mentors.isApprenticeLevel(51), "level 51 is a journeyman");
}

// --- persistence round-trip ---
{
  const file = tmpSave();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      bonds: {
        "maren|dave|woodcutting": {
          mentor: "Maren",
          apprentice: "Dave",
          skill: "woodcutting",
          tipsGiven: 2,
          startedAt: 1000,
          lastTipAt: 2000,
        },
      },
    })
  );
  Mentors._setSaveFile(file);
  const s = Mentors.getMentorStore();
  const loaded = s.getBond("Maren", "Dave", "woodcutting");
  assert.ok(loaded, "saved bond loads");
  assert.equal(loaded.tipsGiven, 2, "tipsGiven survives the round trip");
  s.recordLesson("Maren", "Erin", "fishing", 3000);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(onDisk.bonds["maren|dave|woodcutting"], "existing bond kept on save");
  assert.equal(onDisk.bonds["maren|erin|fishing"].tipsGiven, 1, "new bond persisted");
  assert.ok(
    Mentors.mentorStatus().some((l) => l.includes("Maren") && l.includes("Dave")),
    "mentorStatus lists the bond"
  );
  s.resetForTests();
}

// --- full flow: a master teaches a leveling player ---
{
  fresh();
  const file = tmpSave();
  Mentors._setSaveFile(file);
  seedMaster("Maren", "woodcutting");
  stubDirector([{ username: "Maren", personality: { traits: ["kind"] } }]);
  const bot = mockBot("Maren");
  const player = mockPlayer("Dave", [bot]);

  Mentors.onMentorLevelUpNotice({
    player,
    skill: { getName: () => "Woodcutting" },
    oldLevel: 4,
    newLevel: 5,
  });

  const bond = Mentors.getMentorStore().getBond("Maren", "Dave", "woodcutting");
  assert.ok(bond, "first lesson founds a bond");
  assert.equal(bond.tipsGiven, 1, "one lesson recorded");
  assert.equal(bot._chats.length, 1, "master speaks overhead");
  assert.ok(bot._chats[0].length <= 120, "forceChat line fits the chat bubble");
  assert.equal(player._said.length, 1, "player gets the full lesson");
  assert.ok(player._said[0].includes("Maren"), "lesson names the master");
  assert.ok(player._said[0].includes("master woodcutter"), "master title in the lesson");
  assert.ok(
    getMemory().getEntry("Maren", "Dave").tone >= 1,
    "the lesson warms the memory tone"
  );
  const journal = getJournal().entries.get("maren");
  assert.ok(journal && journal.events.length > 0, "the lesson is journaled");

  // Cooldowns: an immediate second level-up gets no second lesson.
  const chatsBefore = bot._chats.length;
  Mentors.onMentorLevelUpNotice({
    player,
    skill: { getName: () => "Woodcutting" },
    oldLevel: 5,
    newLevel: 6,
  });
  assert.equal(bot._chats.length, chatsBefore, "cooldown blocks the second lesson");
  assert.equal(
    Mentors.getMentorStore().getBond("Maren", "Dave", "woodcutting").tipsGiven,
    1,
    "no lesson recorded under cooldown"
  );
}

// --- no master, no lesson ---
{
  fresh();
  stubDirector([{ username: "Noob" }]); // level 1 woodcutter, not a master
  const bot = mockBot("Noob");
  const player = mockPlayer("Dave", [bot]);
  Mentors.onMentorLevelUpNotice({
    player,
    skill: { getName: () => "Woodcutting" },
    oldLevel: 4,
    newLevel: 5,
  });
  assert.equal(bot._chats.length, 0, "a non-master never lectures");
  assert.equal(player._said.length, 0, "no lesson without a master");
}

// --- journeymen are not lectured ---
{
  fresh();
  stubDirector([{ username: "Maren" }]); // still a master from the earlier seed
  const bot = mockBot("Maren");
  const player = mockPlayer("Dave", [bot]);
  Mentors.onMentorLevelUpNotice({
    player,
    skill: { getName: () => "Woodcutting" },
    oldLevel: 59,
    newLevel: 60,
  });
  assert.equal(bot._chats.length, 0, "masters don't lecture level-60 players");
}

// --- citizen bots are not students ---
{
  fresh();
  stubDirector([{ username: "Maren" }]);
  const bot = mockBot("Maren");
  const fake = mockPlayer("FakeDave", [bot]);
  fake.getHostAddress = () => "bot"; // a bot pretending to learn
  Mentors.onMentorLevelUpNotice({
    player: fake,
    skill: { getName: () => "Woodcutting" },
    oldLevel: 4,
    newLevel: 5,
  });
  assert.equal(bot._chats.length, 0, "citizen bots are never students");
}

Mentors._setSaveFile(Mentors._defaultSaveFile);
Mentors._setDirectorGetter(null);
console.log("CitizenMentors.test.js: all checks passed");
