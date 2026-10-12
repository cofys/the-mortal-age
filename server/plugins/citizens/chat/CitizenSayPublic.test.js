"use strict";

// CitizenSayPublic unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  sayPublic,
  displayNameOf,
  isRealPlayer,
  stripSelfNamePrefix,
  splitChunks,
  setChunkScheduler,
  resetForTests,
  pickLineAvoidingRepeat,
  normalizeRepeatLine,
  repeatGuardStats,
  applyVoiceStyle,
  CHAT_MAX_LEN,
  CHATBOX_MIN_GAP_MS,
  MAX_CHUNKS,
  REPEAT_SELF_KEEP,
  REPEAT_RETRIES,
} = require("./CitizenSayPublic");

function makeRecipient({ username = "Cofy", index = 7, canReceive = true } = {}) {
  const sent = [];
  return {
    player: {
      getUsername: () => username,
      getIndex: () => index,
      getHostAddress: () => "127.0.0.1",
      isPlayerBot: () => false,
      getRelations: () => ({
        canReceivePublicChatFrom: () => canReceive,
      }),
      getPacketSender: () => ({
        sendPublicChat: (message, from, playerId) => {
          sent.push({ message, from, playerId });
        },
      }),
    },
    sent,
  };
}

function makeCitizen({ username = "Mira", index = 42, locals = [], displayName = null } = {}) {
  const forced = [];
  return {
    player: {
      getUsername: () => username,
      getIndex: () => index,
      isPlayerBot: () => true,
      getHostAddress: () => "bot",
      getAttribute: (k) => (k === "character:display-name" ? displayName : undefined),
      getLocalPlayers: () => locals.map((l) => l.player),
      forceChat: (text) => {
        forced.push(text);
      },
    },
    forced,
  };
}

function run(name, fn) {
  resetForTests();
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// 1. Overhead fires and chat box reaches the real player.
run("overhead + chat box to real player", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r] });
  const ok = sayPublic(c.player, "hello there");
  assert.equal(ok, true);
  assert.deepEqual(c.forced, ["hello there"]);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].message, "hello there");
  assert.equal(r.sent[0].from, "Mira"); // username fallback, no display name set
  assert.equal(r.sent[0].playerId, 42); // citizen's index, like the real path
});

// 2. Display name from character:display-name attribute.
run("display name preferred over username", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Mira Cofy" });
  sayPublic(c.player, "hi");
  assert.equal(r.sent[0].from, "Mira Cofy");
  assert.equal(displayNameOf(c.player), "Mira Cofy");
});

// 3. Bots never get chat-box lines (isRealPlayer filter).
run("citizen bots excluded from recipients", () => {
  const bot = makeRecipient({ username: "OtherBot", index: 9 });
  bot.player.isPlayerBot = () => true;
  bot.player.getHostAddress = () => "bot";
  const real = makeRecipient({ username: "Cofy", index: 7 });
  const c = makeCitizen({ locals: [bot, real] });
  const ok = sayPublic(c.player, "hi all");
  assert.equal(ok, true);
  assert.equal(bot.sent.length, 0);
  assert.equal(real.sent.length, 1);
});

// 4. Dedup by index — same player twice in local list gets one line.
run("recipients deduped by index", () => {
  const r1 = makeRecipient({ username: "Cofy", index: 7 });
  const r2 = makeRecipient({ username: "Cofy", index: 7 });
  const c = makeCitizen({ locals: [r1, r2] });
  sayPublic(c.player, "hi");
  assert.equal(r1.sent.length + r2.sent.length, 1);
});

// 5. Chat privacy respected (canReceivePublicChatFrom false => skipped).
run("privacy: blocked recipients skipped", () => {
  const blocked = makeRecipient({ username: "Busy", index: 8, canReceive: false });
  const open = makeRecipient({ username: "Cofy", index: 7, canReceive: true });
  const c = makeCitizen({ locals: [blocked, open] });
  sayPublic(c.player, "hi");
  assert.equal(blocked.sent.length, 0);
  assert.equal(open.sent.length, 1);
});

// 6. 80-char slice like real chat.
run("text sliced to 80 chars", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r] });
  const long = "x".repeat(200);
  sayPublic(c.player, long);
  assert.equal(r.sent[0].message.length, CHAT_MAX_LEN);
  assert.equal(c.forced[0].length, CHAT_MAX_LEN);
});

// 7. Angle brackets stripped (client tags), like the real path.
run("angle brackets stripped", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r] });
  sayPublic(c.player, "hi <img=5> there");
  assert.equal(r.sent[0].message, "hi img=5 there");
});

// 8. Chat-box throttle: second line within 8s => overhead only, returns false.
run("chat-box throttled per citizen, overhead still fires", () => {
  const r = makeRecipient();
  const c = makeCitizen({ username: "Chatty", locals: [r] });
  assert.equal(sayPublic(c.player, "one"), true);
  assert.equal(sayPublic(c.player, "two"), false); // throttled: no box
  assert.deepEqual(c.forced, ["one", "two"]); // overhead both times
  assert.equal(r.sent.length, 1);
});

// 9. bypassThrottle option for urgent lines.
run("bypassThrottle sends despite throttle", () => {
  const r = makeRecipient();
  const c = makeCitizen({ username: "Urgent", locals: [r] });
  sayPublic(c.player, "one");
  assert.equal(sayPublic(c.player, "two", { bypassThrottle: true }), true);
  assert.equal(r.sent.length, 2);
});

// 10. No real players nearby => overhead only, returns false (not an error).
run("no real players nearby: overhead only", () => {
  const c = makeCitizen({ locals: [] });
  assert.equal(sayPublic(c.player, "hello?"), false);
  assert.deepEqual(c.forced, ["hello?"]);
});

// 11. Null-safety: null citizen, empty text, broken locals.
run("null-safety", () => {
  assert.equal(sayPublic(null, "hi"), false);
  const c = makeCitizen({ locals: [] });
  assert.equal(sayPublic(c.player, ""), false);
  assert.equal(sayPublic(c.player, "   "), false);
  const broken = makeCitizen({ locals: [] });
  broken.player.getLocalPlayers = () => {
    throw new Error("boom");
  };
  assert.equal(sayPublic(broken.player, "hi"), false); // overhead may fail too
});

// 12. isRealPlayer canonical check.
run("isRealPlayer", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({}), false);
  const bot = { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "x" };
  assert.equal(isRealPlayer(bot), false);
  const human = {
    isPlayerBot: () => false,
    getHostAddress: () => "1.2.3.4",
    getUsername: () => "Cofy",
  };
  assert.equal(isRealPlayer(human), true);
});

// 13. LOOP GUARD (structural): sayPublic's signature takes (citizen, text, opts)
// — there is no pluginApi/event-emitter parameter, so it cannot emit social
// packets. Verify the function body never *calls* an emit (mentions in the
// docstring above don't count).
run("loop guard: no social-packet emission possible", () => {
  const src = require("fs").readFileSync(__filename.replace(".test.js", ".js"), "utf8");
  const body = src.slice(src.indexOf("function sayPublic"));
  assert.ok(!body.includes("emitSocialPacket("), "must not call emitSocialPacket");
  assert.ok(!body.includes("emitCustomEvent("), "must not call emitCustomEvent");
  assert.ok(!body.includes("PluginManager"), "must not reach the plugin manager");
});

console.log("ALL CITIZENSAYPUBLIC TESTS DONE");

// --- Self-name prefix stripping (Jon's "Nessa Knot: Nessa Knot: ..." bug) ---

run("name strip: full name with colon stripped", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Nessa Knot" });
  assert.equal(sayPublic(c.player, "Nessa Knot: Funny how a guard attacked"), true);
  assert.equal(r.sent[0].message, "Funny how a guard attacked");
  assert.deepEqual(c.forced, ["Funny how a guard attacked"]);
});

run("name strip: full name without colon untouched", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Nessa Knot" });
  sayPublic(c.player, "Nessa Knot walked by earlier");
  assert.equal(r.sent[0].message, "Nessa Knot walked by earlier");
});

run("name strip: first name with colon stripped", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Nessa Knot" });
  sayPublic(c.player, "Nessa: hello there");
  assert.equal(r.sent[0].message, "hello there");
});

run("name strip: plain message untouched", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Nessa Knot" });
  sayPublic(c.player, "hello there");
  assert.equal(r.sent[0].message, "hello there");
});

run("name strip: nothing left after strip drops the message", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Nessa Knot" });
  assert.equal(sayPublic(c.player, "Nessa Knot:"), false);
  assert.equal(r.sent.length, 0);
  assert.equal(c.forced.length, 0);
});

run("name strip: case-insensitive", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Nessa Knot" });
  sayPublic(c.player, "nessa knot: hi");
  assert.equal(r.sent[0].message, "hi");
});

run("name strip: regex chars in name escaped", () => {
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Al (the) Great" });
  sayPublic(c.player, "Al (the) Great: hi");
  assert.equal(r.sent[0].message, "hi");
});

run("name strip: unit-level stripSelfNamePrefix", () => {
  assert.equal(stripSelfNamePrefix("Nessa Knot: hi", "Nessa Knot"), "hi");
  assert.equal(stripSelfNamePrefix("Nessa: hi", "Nessa Knot"), "hi");
  assert.equal(stripSelfNamePrefix("Nessa Knot hi", "Nessa Knot"), "Nessa Knot hi");
  assert.equal(stripSelfNamePrefix("hi", "Nessa Knot"), "hi");
  assert.equal(stripSelfNamePrefix("Nessa Knot:", "Nessa Knot"), "");
  assert.equal(stripSelfNamePrefix("nessa knot :  hi", "Nessa Knot"), "hi");
});

// --- Multi-chunk follow-ups (Jon's "cut off sentences" bug) ---

run("chunking: long message splits at word boundaries, never mid-word", () => {
  setChunkScheduler((fn) => fn()); // continuations run immediately
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r] });
  const words = [];
  for (let i = 0; i < 40; i++) words.push("word" + i);
  const text = words.join(" "); // ~270 chars
  assert.equal(sayPublic(c.player, text), true);
  assert.ok(r.sent.length >= 3, `expected >=3 chunks, got ${r.sent.length}`);
  for (const s of r.sent) {
    assert.ok(s.message.length <= CHAT_MAX_LEN, `chunk too long: ${s.message.length}`);
  }
  const joined = r.sent.map((s) => s.message).join(" ");
  const normalized = text.replace(/\s+/g, " ");
  assert.ok(
    normalized.startsWith(joined),
    "chunks rejoin to a word-boundary prefix of the original"
  );
  assert.ok(normalized.startsWith(r.sent.map((s) => s.message).join(" ").slice(0, 40)));
  assert.deepEqual(
    c.forced,
    r.sent.map((s) => s.message),
    "overhead shows each chunk in turn"
  );
});

run("chunking: single 200-char word hard-splits at 80", () => {
  setChunkScheduler((fn) => fn());
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r] });
  sayPublic(c.player, "x".repeat(200));
  assert.equal(r.sent.length, 3);
  assert.equal(r.sent[0].message.length, CHAT_MAX_LEN);
  assert.equal(r.sent[1].message.length, CHAT_MAX_LEN);
  assert.equal(r.sent.map((s) => s.message).join("").length, 200);
});

run("chunking: capped at MAX_CHUNKS, remainder dropped", () => {
  setChunkScheduler((fn) => fn());
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r] });
  sayPublic(c.player, "lorem ipsum ".repeat(60)); // 720 chars
  assert.equal(r.sent.length, MAX_CHUNKS);
  assert.equal(r.sent.length, 3);
});

run("chunking: continuations refresh throttle, new message can't interleave", () => {
  setChunkScheduler((fn) => fn());
  const r = makeRecipient();
  const c = makeCitizen({ username: "Chunky", locals: [r] });
  const text = "alpha ".repeat(30); // ~180 chars -> 3 chunks
  assert.equal(sayPublic(c.player, text), true);
  const boxLines = r.sent.length;
  assert.ok(boxLines >= 2, `expected multi-chunk, got ${boxLines}`);
  // A brand-new utterance immediately after must be throttled (box quiet).
  assert.equal(sayPublic(c.player, "brand new line"), false);
  assert.equal(
    r.sent.length,
    boxLines,
    "throttled follow-up must not reach the chat box"
  );
});

run("chunking: throttled utterance still shows all chunks as overhead", () => {
  setChunkScheduler((fn) => fn());
  const r = makeRecipient();
  const c = makeCitizen({ username: "Slow", locals: [r] });
  sayPublic(c.player, "first");
  const forcedBefore = c.forced.length;
  const text = "beta ".repeat(30);
  assert.equal(sayPublic(c.player, text), false); // throttled
  assert.equal(r.sent.length, 1, "box stays quiet while throttled");
  assert.ok(
    c.forced.length > forcedBefore + 1,
    "all chunks still show as overhead in turn"
  );
});

run("chunking: name strip composes with chunking", () => {
  setChunkScheduler((fn) => fn());
  const r = makeRecipient();
  const c = makeCitizen({ locals: [r], displayName: "Nessa Knot" });
  const text = "Nessa Knot: " + "gamma ".repeat(30);
  sayPublic(c.player, text);
  assert.ok(!r.sent[0].message.startsWith("Nessa"), "first chunk has no name prefix");
  const joined = r.sent.map((s) => s.message).join(" ");
  assert.ok(!joined.includes("Nessa Knot:"), "no chunk carries the name prefix");
});

run("chunking: splitChunks unit cases", () => {
  assert.deepEqual(splitChunks("short", 80), ["short"]);
  assert.deepEqual(splitChunks("a b c", 3), ["a b", "c"]);
  const chunks = splitChunks("one two three four five", 9);
  assert.ok(chunks.every((c) => c.length <= 9), JSON.stringify(chunks));
  assert.equal(chunks.join(" "), "one two three four five");
  assert.deepEqual(splitChunks("x".repeat(200), 80), [
    "x".repeat(80),
    "x".repeat(80),
    "x".repeat(40),
  ]);
});

console.log("ALL NAME-STRIP + CHUNKING TESTS DONE");

// --- Repetition guard: anti-repeat chatter (Jon's "socializing seems shit") ---

function withTile(c, x, y) {
  c.player.getLocation = () => ({ getX: () => x, getY: () => y });
  return c;
}

run("repeat guard: normalize lowercases, strips own name + punctuation", () => {
  assert.equal(normalizeRepeatLine("Morning!", "Nessa Knot"), "morning");
  assert.equal(normalizeRepeatLine("Nessa Knot: Morning!", "Nessa Knot"), "morning");
  assert.equal(normalizeRepeatLine("MORNING!!", "Nessa Knot"), "morning");
  assert.equal(normalizeRepeatLine("  Alright?  ", "Nessa Knot"), "alright");
  // Someone else's name is kept: "hey Harold!" is not "hey Marta!".
  assert.equal(normalizeRepeatLine("hey Harold!", "Nessa Knot"), "hey harold");
  // No display name: only case/punctuation folding.
  assert.equal(normalizeRepeatLine("Morning!", null), "morning");
  // Short name tokens don't eat real words.
  assert.equal(normalizeRepeatLine("also here", "Al Bo"), "also here");
});

run("repeat guard: same citizen re-rolls a recently said line", () => {
  const r = makeRecipient();
  const c = withTile(makeCitizen({ username: "Repeater", locals: [r] }), 100, 100);
  assert.equal(sayPublic(c.player, "Morning!"), true);
  const pool = ["Morning!", "Alright?"];
  let i = 0;
  const line = pickLineAvoidingRepeat(c.player, () => pool[i++ % pool.length]);
  assert.equal(line, "Alright?");
});

run("repeat guard: all retries recent -> last candidate allowed, never silent", () => {
  const r = makeRecipient();
  const c = withTile(makeCitizen({ username: "Stuck", locals: [r] }), 100, 100);
  sayPublic(c.player, "Morning!");
  let calls = 0;
  const line = pickLineAvoidingRepeat(c.player, () => {
    calls++;
    return "Morning!";
  });
  assert.equal(line, "Morning!"); // repetition beats muteness
  assert.equal(calls, REPEAT_RETRIES + 1); // initial pick + re-rolls
});

run("repeat guard: nearby citizen's line re-rolls, far citizen's doesn't", () => {
  const r = makeRecipient();
  const a = withTile(makeCitizen({ username: "Ann", locals: [r] }), 0, 0);
  const b = withTile(makeCitizen({ username: "Bob", locals: [r] }), 10, 0); // within 15
  const c = withTile(makeCitizen({ username: "Cat", locals: [r] }), 100, 100); // far
  sayPublic(a.player, "Morning!");
  const pool = ["Morning!", "Alright?"];
  let i = 0;
  assert.equal(
    pickLineAvoidingRepeat(b.player, () => pool[i++ % pool.length]),
    "Alright?"
  );
  let j = 0;
  assert.equal(
    pickLineAvoidingRepeat(c.player, () => pool[j++ % pool.length]),
    "Morning!"
  );
});

run("repeat guard: pending pick blocks a second citizen before sayPublic fires", () => {
  const a = withTile(makeCitizen({ username: "Abe", locals: [] }), 0, 0);
  const b = withTile(makeCitizen({ username: "Bea", locals: [] }), 5, 0);
  // Abe picks "Morning!" but hasn't spoken yet (typing delay) — Bea picking
  // in the same tick must see the reservation and re-roll.
  assert.equal(pickLineAvoidingRepeat(a.player, () => "Morning!"), "Morning!");
  const pool = ["Morning!", "Alright?"];
  let i = 0;
  assert.equal(
    pickLineAvoidingRepeat(b.player, () => pool[i++ % pool.length]),
    "Alright?"
  );
  // When Abe's line actually speaks, the reservation commits (not duplicated).
  const before = repeatGuardStats();
  sayPublic(a.player, "Morning!");
  const after = repeatGuardStats();
  assert.equal(after.pending, before.pending - 1);
  assert.equal(after.area, before.area + 1);
});

run("repeat guard: three citizens picking in one tick don't chant in unison", () => {
  const pool = ["Morning!", "Alright?", "Hey there."];
  const citizens = [0, 1, 2].map((n) =>
    withTile(makeCitizen({ username: "crowd" + n, locals: [] }), n * 3, 0)
  );
  const said = citizens.map((c) => {
    let n = 0;
    return pickLineAvoidingRepeat(c.player, () => pool[n++ % pool.length]);
  });
  const uniq = new Set(said.map((l) => normalizeRepeatLine(l, null)));
  assert.equal(uniq.size, 3, `expected 3 distinct lines, got ${JSON.stringify(said)}`);
});

run("repeat guard: per-citizen memory keeps only the last 8 lines", () => {
  const c = withTile(makeCitizen({ username: "Long", locals: [] }), 0, 0);
  for (let i = 0; i < 10; i++) sayPublic(c.player, "line " + i);
  withTile(c, 999, 999); // moved away: the area memory no longer in play
  // "line 0" fell out of the window — no longer recent, picked immediately.
  let calls = 0;
  const line = pickLineAvoidingRepeat(c.player, () => {
    calls++;
    return calls === 1 ? "line 0" : "line 9";
  });
  assert.equal(line, "line 0");
  assert.equal(calls, 1);
  assert.equal(REPEAT_SELF_KEEP, 8);
  // "line 9" is still inside the window — re-rolls once to a fresh line.
  let calls2 = 0;
  const line2 = pickLineAvoidingRepeat(c.player, () => {
    calls2++;
    return calls2 === 1 ? "line 9" : "fresh line";
  });
  assert.equal(line2, "fresh line");
  assert.equal(calls2, 2);
});

run("repeat guard: null citizen skips the guard, pool miss stays null", () => {
  assert.equal(pickLineAvoidingRepeat(null, () => "hi"), "hi");
  const c = makeCitizen({ locals: [] });
  assert.equal(pickLineAvoidingRepeat(c.player, () => null), null);
  assert.equal(pickLineAvoidingRepeat(c.player, () => ""), "");
});

run("repeat guard: area + citizen stores are capped", () => {
  const r = makeRecipient();
  for (let i = 0; i < 2100; i++) {
    const c = withTile(makeCitizen({ username: "cap" + i, locals: [r] }), i, i);
    sayPublic(c.player, "line " + i);
  }
  const s = repeatGuardStats();
  assert.ok(s.area <= 2000, `area capped, got ${s.area}`);
  assert.ok(s.citizens <= 2000, `citizens capped, got ${s.citizens}`);
});

console.log("ALL REPEAT-GUARD TESTS DONE");

// --- Voice backstop: per-citizen voice signature at the sayPublic choke point ---

function makeVoicedCitizen({ username = "Gruff", locals = [], personality } = {}) {
  const forced = [];
  const base = makeCitizen({ username, locals });
  base.player.getAttribute = (k) =>
    k === "citizens:personality" ? personality : undefined;
  return base;
}

run("voice backstop: terse voice strips exclamation marks", () => {
  const c = makeVoicedCitizen({
    personality: { traits: ["gruff"], speechStyle: "short clipped sentences" },
  });
  assert.equal(applyVoiceStyle(c.player, "Hey there!"), "hey there.");
});

run("voice backstop: street-slang voice lowercases", () => {
  const c = makeVoicedCitizen({
    personality: { traits: [], speechStyle: "rough street slang" },
  });
  assert.equal(applyVoiceStyle(c.player, "Selling Lobsters!"), "selling lobsters!");
});

run("voice backstop: plain voice leaves the line alone", () => {
  const c = makeVoicedCitizen({
    personality: { traits: ["dutiful"], speechStyle: "careful formal phrasing" },
  });
  assert.equal(applyVoiceStyle(c.player, "Hey there!"), "Hey there!");
});

run("voice backstop: missing personality degrades to unchanged", () => {
  const c = makeCitizen({ locals: [] }); // no citizens:personality attribute
  assert.equal(applyVoiceStyle(c.player, "Hey there!"), "Hey there!");
  assert.equal(applyVoiceStyle(null, "Hey there!"), "Hey there!");
});

run("voice backstop: idempotent over voiceLine-styled lines", () => {
  const c = makeVoicedCitizen({
    personality: { traits: ["gruff"], speechStyle: "short clipped sentences" },
  });
  // Already styled by a pick-time voiceLine: second application is a no-op.
  assert.equal(applyVoiceStyle(c.player, "hey."), "hey.");
});

run("voice backstop: sayPublic speaks the voiced line, not the raw one", () => {
  const r = makeRecipient();
  const c = makeVoicedCitizen({
    locals: [r],
    personality: { traits: ["gruff"], speechStyle: "short clipped sentences" },
  });
  const ok = sayPublic(c.player, "Morning!");
  assert.equal(ok, true);
  assert.deepEqual(c.forced, ["morning."]);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].message, "morning.");
});

run("voice backstop: voiced lines land in the repeat memory as spoken", () => {
  const r = makeRecipient();
  const c = makeVoicedCitizen({
    locals: [r],
    personality: { traits: ["gruff"], speechStyle: "short clipped sentences" },
  });
  sayPublic(c.player, "Morning!");
  // "morning." (styled) is recent — the raw "Morning!" form re-rolls.
  let calls = 0;
  const line = pickLineAvoidingRepeat(c.player, () => {
    calls++;
    return calls === 1 ? "Morning!" : "fresh";
  });
  assert.equal(line, "fresh");
});

console.log("ALL VOICE-BACKSTOP TESTS DONE");
