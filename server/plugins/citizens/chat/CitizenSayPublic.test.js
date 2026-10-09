"use strict";

// CitizenSayPublic unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  sayPublic,
  displayNameOf,
  isRealPlayer,
  resetForTests,
  CHAT_MAX_LEN,
  CHATBOX_MIN_GAP_MS,
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
