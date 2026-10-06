// CitizenMemory unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenMemory.test.js (plain node)
const assert = require("node:assert/strict");
const {
  CitizenMemoryStore,
  scoreTone,
  grudgeLevel,
  GRUDGE_DECAY_MS,
  GRUDGE_INSULT,
  GRUDGE_ATTACK,
  GOSSIP_THEFT,
} = require("./CitizenMemory");

function fresh() {
  const store = new CitizenMemoryStore();
  store.resetForTests();
  return store;
}

// --- tone scoring ---
assert.equal(scoreTone("thanks so much, friend!"), 2);
assert.ok(scoreTone("shut up, you stupid idiot") <= -4, "rude weighs double");
assert.equal(scoreTone("just browsing"), 0);
assert.equal(scoreTone(""), 0);

// --- meetings & standings ---
{
  const m = fresh();
  assert.equal(m.standing("Maren", "Dave"), "neutral");
  m.recordMeeting("Maren", "Dave", 1000);
  m.recordMeeting("Maren", "Dave", 2000);
  assert.equal(m.getEntry("Maren", "Dave").met, 2);
  assert.equal(m.standing("Maren", "Dave"), "neutral", "2 meetings isn't regular");
  m.recordMeeting("Maren", "Dave", 3000);
  assert.equal(m.standing("Maren", "Dave", 3000), "regular");
  assert.equal(m.priceMultiplier("Maren", "Dave", 3000), 0.95);
  assert.ok(m.greetingFor("Maren", "Dave", 3000).includes("Dave"), "regulars greeted by name");
  assert.equal(m.greetingFor("Maren", "Stranger"), null, "strangers get no greeting");
}

// --- spend makes regulars too; favorites get the bigger discount ---
{
  const m = fresh();
  m.recordMeeting("Maren", "Rich", 1000);
  const crossed = m.recordSpend("Maren", "Rich", 600, 1000);
  assert.deepEqual(crossed, [], "600 < first generosity tier");
  assert.equal(m.standing("Maren", "Rich", 1000), "regular");
  const crossed2 = m.recordSpend("Maren", "Rich", 5000, 2000);
  assert.deepEqual(crossed2, [1000], "generosity tier fires once");
  assert.equal(m.standing("Maren", "Rich", 2000), "favorite");
  assert.equal(m.priceMultiplier("Maren", "Rich", 2000), 0.9);
  const crossed3 = m.recordSpend("Maren", "Rich", 1, 3000);
  assert.deepEqual(crossed3, [], "tier never refires");
}

// --- grudges: insult, decay, escalation ---
{
  const m = fresh();
  m.recordMeeting("Maren", "Rude", 1000);
  m.addGrudge("Maren", "Rude", GRUDGE_INSULT, "insult", 1000);
  assert.equal(m.standing("Maren", "Rude", 1000), "cold");
  assert.equal(m.priceMultiplier("Maren", "Rude", 1000), 1.25);
  // Decay: just under full decay the grudge is nearly gone...
  const almostGone = 1000 + GRUDGE_DECAY_MS - 1000;
  assert.ok(grudgeLevel(m.getEntry("Maren", "Rude"), almostGone) < 0.01);
  assert.equal(m.standing("Maren", "Rude", almostGone), "neutral", "grudge forgotten after decay");
  // ...and past it, fully zero.
  assert.equal(grudgeLevel(m.getEntry("Maren", "Rude"), 1000 + GRUDGE_DECAY_MS + 1), 0);
}
{
  const m = fresh();
  m.addGrudge("Maren", "Brute", GRUDGE_INSULT, "insult", 1000);
  m.addGrudge("Maren", "Brute", GRUDGE_ATTACK, "attack", 2000); // worse offense escalates
  const entry = m.getEntry("Maren", "Brute");
  assert.equal(entry.grudge, 3);
  assert.equal(entry.grudgeKind, "attack");
  assert.equal(entry.grudgeAt, 2000, "clock refreshes on re-offense");
  assert.equal(m.standing("Maren", "Brute", 2000), "hostile");
  assert.equal(m.priceMultiplier("Maren", "Brute", 2000), 1.5);
  const hostileGreeting = m.greetingFor("Maren", "Brute", 2000);
  assert.ok(
    hostileGreeting.includes("not welcome") || hostileGreeting.includes("Watch yourself"),
    `hostile greeting names the threat: ${hostileGreeting}`
  );
  // Grudge outranks loyalty: a favorite who attacks is hostile.
  for (let i = 0; i < 12; i++) m.recordMeeting("Maren", "Brute", 2000 + i);
  assert.equal(m.standing("Maren", "Brute", 3000), "hostile");
}

// --- notoriety: guards hear about it even from other citizens' memories ---
{
  const m = fresh();
  m.addGrudge("Victim", "Brute", GRUDGE_ATTACK, "attack", 1000);
  m.heardAbout("Bystander", "Brute", GOSSIP_THEFT, 1, 1000);
  assert.ok(m.notoriety("Brute", 1000) >= 2.9, "direct grudge dominates");
  assert.equal(m.notoriety("Saint", 1000), 0);
  const m2 = fresh();
  m2.heardAbout("Bystander", "Sneak", GOSSIP_THEFT, 1, 1000);
  assert.equal(m2.notoriety("Sneak", 1000), 0.5, "gossip counts at half weight");
}

// --- cap: LRU eviction, grudges protected ---
{
  const m = fresh();
  const now = 1_000_000;
  for (let i = 0; i < 45; i++) {
    m.recordMeeting("Maren", `Player${i}`, now - (45 - i) * 1000);
  }
  const size = m.citizens.get("maren").players.size;
  assert.equal(size, 40, "capped at 40 players");
  assert.equal(m.getEntry("Maren", "Player0"), null, "oldest evicted");
  assert.ok(m.getEntry("Maren", "Player44"), "newest kept");
  // A grudged player survives eviction even when oldest.
  m.addGrudge("Maren", "Grudgy", GRUDGE_ATTACK, "attack", now - 100_000);
  for (let i = 0; i < 45; i++) m.recordMeeting("Maren", `New${i}`, now + i);
  assert.ok(m.getEntry("Maren", "Grudgy"), "grudge protected from eviction");
}

// --- social links: deterministic, bounded, never self ---
{
  const m = fresh();
  const kingdom = ["Maren", "Borin", "Sella", "Tav", "Wren", "Pike", "Odd"];
  const a = m.socialLinks("Maren", kingdom);
  const b = m.socialLinks("Maren", kingdom);
  assert.deepEqual(a, b, "stable links");
  assert.ok(a.length <= 5 && a.length > 0);
  assert.ok(!a.map((n) => n.toLowerCase()).includes("maren"), "never self");
}

// --- gossip propagation walks social links, not the whole world ---
{
  const m = fresh();
  const members = new Map([["misthalin", ["Maren", "Borin", "Sella", "Tav", "Wren"]]]);
  const online = new Set(["Borin"]);
  const said = [];
  m.seedGossip({
    kingdomId: "misthalin",
    kind: GOSSIP_THEFT,
    subject: "Sneak",
    text: "caught stealing at the market, bold as brass!",
    holder: "Maren",
  });
  assert.equal(m.gossip.length, 1);
  const deps = {
    kingdomMembers: members,
    isOnline: (n) => online.has(n),
    botFor: (n) => ({ forceChat: (line) => said.push({ n, line }) }),
  };
  // Force hops by aging the rumor past the hop interval.
  let hops = 0;
  const holdersSeen = new Set();
  for (let t = 0; t < 20 && m.gossip.length > 0; t++) {
    m.gossip[0].lastHopAt -= 200_000;
    const before = m.gossip[0]?.holder;
    m.spreadGossipTick(deps, Date.now() + t * 1000);
    if (m.gossip[0]) {
      holdersSeen.add(m.gossip[0].holderDisplay);
      if (m.gossip[0].holder !== before) hops++;
    }
  }
  assert.ok(hops > 0, "rumor hopped along social links");
  // Everyone who held it heard about the subject second-hand.
  for (const holder of holdersSeen) {
    assert.ok(m.hasHeard(holder, "Sneak"), `${holder} remembers hearing it`);
  }
  assert.ok(holdersSeen.size > 1, "news traveled, not instant global");
  assert.ok(
    said.every((s) => s.line.includes("Sneak")),
    "street-talk names the subject"
  );
}

// --- persistence round-trip (in-memory seam, no disk) ---
{
  const m = fresh();
  m.recordMeeting("Maren", "Dave", 5000);
  m.recordSpend("Maren", "Dave", 750, 5000);
  const json = m.toJSON();
  const m2 = fresh();
  m2.citizens = new Map(); // simulate fresh boot
  // load() reads disk; emulate by injecting the parsed JSON shape directly
  for (const [key, record] of Object.entries(json.citizens)) {
    const players = new Map();
    for (const [pkey, data] of Object.entries(record.players)) {
      const { display, ...entry } = data;
      players.set(pkey, { display, entry });
    }
    m2.citizens.set(key, { display: record.display, players });
  }
  assert.equal(m2.getEntry("Maren", "Dave").spent, 750);
  assert.equal(m2.standing("Maren", "Dave", 5000), "regular");
}

console.log("CitizenMemory.test.js: all checks passed");
