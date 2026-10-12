// CitizenFollowOption unit checks — pure logic, no running server.
const assert = require("node:assert/strict");

const FollowOption = require("./CitizenFollowOption");
const {
  onFollowPlayerOption,
  syncFollowOption,
  FOLLOW_OPTION_SLOT,
  FOLLOW_OPTION_TEXT,
} = FollowOption;

assert.equal(FOLLOW_OPTION_SLOT, 8, "follow option uses slot 8");
assert.equal(FOLLOW_OPTION_TEXT, "Follow me");

// --- syncFollowOption -------------------------------------------------------
{
  let sent = null;
  const player = {
    isPlayerBot: () => false,
    getPacketSender: () => ({
      sendPlayerOption: (slot, text, priority) => { sent = { slot, text, priority }; },
    }),
  };
  syncFollowOption(player);
  assert.deepEqual(sent, { slot: 8, text: "Follow me", priority: false });

  // Second sync is a no-op (WeakSet dedupe).
  sent = null;
  syncFollowOption(player);
  assert.equal(sent, null, "option sent only once per player");

  // Bots never get the option.
  sent = null;
  const bot = { isPlayerBot: () => true, getPacketSender: () => ({
    sendPlayerOption: (slot, text) => { sent = { slot, text }; },
  }) };
  syncFollowOption(bot);
  assert.equal(sent, null, "bots do not receive the option");
}

// --- onFollowPlayerOption: routing ------------------------------------------
{
  // Wrong slot → ignored.
  const event = { option: 7, player: {}, target: { isPlayerBot: () => true } };
  assert.equal(onFollowPlayerOption(event, {}), false);
  assert.equal(event.handled, undefined);

  // Non-citizen target → ignored.
  const event2 = { option: 8, player: {}, target: { isPlayerBot: () => false } };
  assert.equal(onFollowPlayerOption(event2, {}), false);

  // Missing target → ignored.
  const event3 = { option: 8, player: {}, target: null };
  assert.equal(onFollowPlayerOption(event3, {}), false);
}

// --- onFollowPlayerOption: toggle + request flow ----------------------------
// We can't easily mock the bonds/voice/speech layers without a server, but we
// can verify the handler marks the event handled and returns true for a
// well-formed citizen target (the speech layer is try/caught internally).
{
  const bot = {
    isPlayerBot: () => true,
    getUsername: () => "TestCitizen",
    getAttribute: () => undefined,
    getPacketSender: () => ({ sendPublicChat: () => {} }),
  };
  const player = { getUsername: () => "Jon", isPlayerBot: () => false };
  const event = { option: 8, player, target: bot };
  const result = onFollowPlayerOption(event, {});
  assert.equal(result, true, "handler claims the event");
  assert.equal(event.handled, true, "event marked handled");
}

console.log("CitizenFollowOption tests passed.");
