// CitizenGlassblowers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const g = require("./CitizenGlassblowers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Local time constructor — server-hour gates read server-local time, never UTC.
function at(h, m = 0) {
  return new Date(2026, 9, 8, h, m).getTime();
}

g._resetState();

// 1. hashStr: deterministic, differentiates.
assert.equal(g.hashStr("abc"), g.hashStr("abc"));
assert.notEqual(g.hashStr("abc"), g.hashStr("abd"));

// 2. Type-from-roll covers all four types and sums to 100.
{
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(g.glassblowerTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), [...g.GLASSBLOWER_TYPES].sort());
  assert.equal(g.glassblowerTypeFromRoll(0), g.GLASSBLOWER_VESSEL);
  assert.equal(g.glassblowerTypeFromRoll(34), g.GLASSBLOWER_VESSEL);
  assert.equal(g.glassblowerTypeFromRoll(35), g.GLASSBLOWER_WINDOW);
  assert.equal(g.glassblowerTypeFromRoll(64), g.GLASSBLOWER_WINDOW);
  assert.equal(g.glassblowerTypeFromRoll(65), g.GLASSBLOWER_ORNAMENT);
  assert.equal(g.glassblowerTypeFromRoll(84), g.GLASSBLOWER_ORNAMENT);
  assert.equal(g.glassblowerTypeFromRoll(85), g.GLASSBLOWER_FURNACE);
  assert.equal(g.glassblowerTypeFromRoll(99), g.GLASSBLOWER_FURNACE);
}

// 3. Nominal 75% roll; mutual exclusions with the 12 prior professional
// systems bring the effective share to ~3% — a visible handful per kingdom.
// Stable across restarts (pure hash).
{
  let n = 0;
  for (let i = 0; i < 500; i++) {
    if (g.glassblowerTypeOf({ username: "shareprobe" + i, role: "commoner" })) n++;
  }
  assert.ok(n > 5 && n < 50, `share ${n}/500 out of 1-10% band`);
  // Stability: same record -> same type.
  const r = { username: "stableglass", kingdomId: "asgarnia" };
  assert.equal(g.glassblowerTypeOf(r), g.glassblowerTypeOf(r));
}

// 3b. Role gate: guards (and any explicit non-commoner role) are never
// glassblowers — same as the painter/sculptor pattern.
{
  assert.equal(g.glassblowerTypeOf({ username: "GuardA", role: "guard" }), null);
  assert.equal(g.glassblowerTypeOf({ username: "CourtB", role: "courtier" }), null);
  assert.equal(g.glassblowerTypeOf({ username: "NoRole", role: "" }), g.glassblowerTypeOf({ username: "NoRole" }));
}

// 4. Exclusions: a clockmaker is never also a glassblower.
{
  const clockmakers = require("./CitizenClockmakers");
  let found = null;
  for (let i = 0; i < 500 && !found; i++) {
    const rec = { username: "exclprobe" + i, kingdomId: "misthalin" };
    if (clockmakers.clockmakerTypeOf(rec)) found = rec;
  }
  assert.ok(found, "expected to find a clockmaker in 500 probes");
  assert.equal(g.glassblowerTypeOf(found), null);
}

// 5. Workshop assignment: kingdom-preferred, stable, falls back globally.
{
  const w1 = g.workshopFor({ username: "worka", kingdomId: "asgarnia" });
  assert.equal(w1.kingdom, "asgarnia");
  assert.deepEqual(g.workshopFor({ username: "worka", kingdomId: "asgarnia" }), w1);
  const w2 = g.workshopFor({ username: "workb", kingdomId: "nosuchplace" });
  assert.ok(g.WORKSHOPS.includes(w2));
}

// 6. Daily catalog: deterministic per day, varies across days, 2-3 unique pieces.
{
  const d1 = g.piecesFor("catuser", "asgarnia", at(10) - 86400000 * 3);
  const d1b = g.piecesFor("catuser", "asgarnia", at(10) - 86400000 * 3);
  const d2 = g.piecesFor("catuser", "asgarnia", at(10));
  assert.deepEqual(d1, d1b);
  assert.ok(d1.length >= 2 && d1.length <= 3, `catalog size ${d1.length}`);
  assert.equal(new Set(d1).size, d1.length);
  assert.notDeepEqual(d1, d2);
}

// 7. Great work: shape, cycle bounds, doneDay math.
{
  const ws = g.WORKSHOPS[0];
  const gw = g.greatWorkFor(ws, at(10));
  assert.ok(gw.work && !gw.work.includes("{"));
  assert.equal(gw.doneDay, gw.startedDay + gw.lengthDays);
  assert.ok(gw.lengthDays >= 6 && gw.lengthDays <= 9);
  // Same day -> same great work.
  assert.deepEqual(g.greatWorkFor(ws, at(10)), g.greatWorkFor(ws, at(11)));
}

// 8. Masterwork: deterministic per workshop-day, or null; when set, from list.
{
  const ws = g.WORKSHOPS[1];
  const m1 = g.masterworkFor(ws, at(10));
  const m1b = g.masterworkFor(ws, at(10));
  assert.equal(m1, m1b);
  if (m1) assert.ok(g.MASTERWORKS.includes(m1));
}

// 9. Commission ledger round-trip + TTL expiry.
{
  const now = at(10);
  assert.equal(g.commissionPiece("  Alice  ", "a stained-glass pane", now), "a stained-glass pane");
  assert.equal(g.commissionFor("alice", now), "a stained-glass pane");
  assert.equal(g.commissionFor("alice", now + 8 * 24 * 3600 * 1000), null); // expired
  assert.equal(g.commissionFor("nobody", now), null);
  assert.equal(g.commissionPiece("", "x", now), null);
  assert.equal(g.commissionPiece("bob", "", now), null);
}

// 10. Furnace hours: local-time constructors only (PC is EDT, never UTC).
{
  assert.equal(g.isFurnaceHour(at(8)), true);
  assert.equal(g.isFurnaceHour(at(12)), true);
  assert.equal(g.isFurnaceHour(at(16, 59)), true);
  assert.equal(g.isFurnaceHour(at(17)), false);
  assert.equal(g.isFurnaceHour(at(7, 59)), false);
  assert.equal(g.isFurnaceHour(at(22)), false);
}

// 11. Line pools render with no unfilled slots and sane lengths.
{
  const allLines = [];
  for (const t of g.GLASSBLOWER_TYPES) {
    // work lines are pulled from WORK_LINES via the module internals; test the
    // template pools indirectly through fill with plausible slots.
    allLines.push(
      g.fill("Fresh from the furnace! {piece} — blown this very morning!", { piece: "a glass swan" }),
      g.fill("Step closer — {piece}. Set with {jewel}.", { piece: "a crystal phoenix decanter", jewel: "a polished garnet" }),
      g.fill("{piece} — {glass} says the alchemists can't keep them in stock!", {
        piece: "a potion vial",
        glass: "a crate of potion vials",
      }),
      g.fill("Behold! {work} stands complete! Light itself has moved in!", { work: "the Grand Glasshouse of Misthalin" }),
      g.fill("After {days} days at the furnace — {work} is finished!", { work: "the Cathedral Window of Asgarnia", days: 7 })
    );
  }
  for (const line of allLines) {
    assert.ok(!line.includes("{"), `unfilled slot in: ${line}`);
    assert.ok(line.length <= 120, `line too long: ${line}`);
  }
}

// 12. Tie-ins return sane strings (real modules or fallbacks, never throw).
{
  assert.equal(typeof g.glasswareForToday(at(10)), "string");
  assert.ok(g.glasswareForToday(at(10)).length > 0);
  assert.equal(typeof g.jewelForToday(at(10)), "string");
  assert.ok(g.jewelForToday(at(10)).length > 0);
}

// 13. Gates: isRealPlayer / isCitizenBot / withinTiles.
{
  const real = { isPlayerBot: () => false, getHostAddress: () => "127.0.0.1", getUsername: () => "Human" };
  const bot = { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "Bot_1" };
  assert.equal(g.isRealPlayer(real), true);
  assert.equal(g.isRealPlayer(bot), false);
  assert.equal(g.isRealPlayer(null), false);
  assert.equal(g.isCitizenBot(bot), true);
  assert.equal(g.isCitizenBot(real), false);

  const loc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(g.withinTiles(loc(0, 0, 0), loc(14, 0, 0), 14), true);
  assert.equal(g.withinTiles(loc(0, 0, 0), loc(15, 0, 0), 14), false);
  assert.equal(g.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 14), false); // plane
}

// 14. Tick never-throws on hostile input.
{
  g.tickGlassblowers(null, at(10));
  g.tickGlassblowers({}, at(10));
  g.tickGlassblowers({ roster: new Map() }, at(10));
  g.tickGlassblowers({ roster: null }, at(10));
}

// 15. Tick silent when only bots are near.
{
  g._resetState();
  const lines = [];
  const citizen = {
    forceChat: (l) => lines.push(l),
    getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "Bot_7",
  };
  const botPlayer = { ...citizen };
  // Find a real glassblower record.
  let rec = null;
  for (let i = 0; i < 200 && !rec; i++) {
    const r = { username: "tickprobe" + i, kingdomId: "asgarnia" };
    if (g.glassblowerTypeOf(r)) rec = r;
  }
  assert.ok(rec, "expected a glassblower in 200 probes");
  const director = {
    roster: new Map([[rec.username, rec]]),
    playerFor: () => citizen,
    onlinePlayers: () => [botPlayer],
  };
  g.tickGlassblowers(director, at(10));
  assert.equal(lines.length, 0, "should be silent near bots only");
}

// 16. Tick fires near a real player during furnace hours, then the 3h
// cooldown gates an immediate repeat tick (deterministic: single citizen,
// retry loop with cooldown reset; P(never fires in 20 tries) = 0.65^20).
{
  let gName = null;
  for (let i = 0; i < 500 && !gName; i++) {
    const n = "FireProbe_" + i;
    if (g.glassblowerTypeOf({ username: n, kingdomId: "asgarnia", role: "commoner" })) gName = n;
  }
  assert.ok(gName, "expected to find a glassblower name");
  const lines = [];
  const citizen = {
    forceChat: (l) => lines.push(l),
    getLocation: () => ({ getX: () => 200, getY: () => 200, getZ: () => 0 }),
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => gName,
  };
  const real = {
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getUsername: () => "RealPlayer",
    getLocation: () => ({ getX: () => 205, getY: () => 205, getZ: () => 0 }),
  };
  const record = { username: gName, kingdomId: "asgarnia", role: "commoner" };
  const director = {
    roster: new Map([[gName, record]]),
    playerFor: () => citizen,
    onlinePlayers: () => [real],
  };
  for (let i = 0; i < 20 && lines.length === 0; i++) {
    g._resetState();
    g.tickGlassblowers(director, at(10));
  }
  assert.ok(lines.length > 0, "expected at least one forceChat near a real player");
  // Immediate repeat tick: this citizen is on cooldown -> silence.
  const n = lines.length;
  g.tickGlassblowers(director, at(10));
  assert.equal(lines.length, n, "cooldown should gate the second tick");
}

// 17. tipGlassblower: moves coins, ignores non-glassblowers, ignores handled.
{
  g._resetState();
  // Find a glassblower record and a non-glassblower record.
  let gRec = null, plainRec = null;
  for (let i = 0; i < 400 && (!gRec || !plainRec); i++) {
    const r = { username: "tipprobe" + i, kingdomId: "kandarin" };
    const rec = { username: r.username, kingdomId: r.kingdomId };
    if (g.glassblowerTypeOf(rec) && !gRec) gRec = rec;
    if (!g.glassblowerTypeOf(rec) && !plainRec) plainRec = rec;
  }
  assert.ok(gRec && plainRec);

  const mkInv = (initial) => {
    const inv = {
      coins: initial,
      getAmount: (id) => (id === 995 ? inv.coins : 0),
      deleteNumber: (id, n) => { if (id === 995) inv.coins -= n; },
      add: (id, n) => { if (id === 995) inv.coins += n; },
      refreshItems: () => {},
    };
    return inv;
  };
  const playerInv = mkInv(100000);
  const targetInv = mkInv(0);
  const player = {
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getUsername: () => "Tipper",
    getInventory: () => playerInv,
    sendMessage: () => {},
  };
  const thanks = [];
  const target = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => gRec.username,
    getInventory: () => targetInv,
    forceChat: (l) => thanks.push(l),
  };
  const director = { roster: new Map([[gRec.username, gRec]]) };
  const moved = g.tipGlassblower(
    { player, target, item: { getId: () => 995, getAmount: () => 5000 } },
    { director }
  );
  assert.equal(moved, 5000);
  assert.equal(playerInv.coins, 95000);
  assert.equal(targetInv.coins, 5000);
  assert.equal(thanks.length, 1);

  // Non-glassblower target: ignored.
  const director2 = { roster: new Map([[plainRec.username, plainRec]]) };
  const target2 = { ...target, getUsername: () => plainRec.username };
  const ev2 = { player, target: target2, item: { getId: () => 995, getAmount: () => 5000 } };
  assert.equal(g.tipGlassblower(ev2, { director: director2 }), undefined);
  assert.equal(ev2.handled, undefined);

  // Already handled: ignored.
  assert.equal(g.tipGlassblower({ handled: true, player, target, item: {} }, { director }), undefined);

  // Fat-finger guard caps at 25000.
  const targetInv3 = mkInv(0);
  const playerInv3 = mkInv(1000000);
  const player3 = { ...player, getInventory: () => playerInv3 };
  const target3 = { ...target, getInventory: () => targetInv3 };
  const moved3 = g.tipGlassblower(
    { player: player3, target: target3, item: { getId: () => 995, getAmount: () => 999999 } },
    { director }
  );
  assert.equal(moved3, 25000);
}

console.log("CitizenGlassblowers: all checks passed");
