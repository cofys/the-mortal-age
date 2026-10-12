// CitizenTrading unit checks — pure logic, no running server.
const assert = require("node:assert/strict");

const Trading = require("./CitizenTrading");
const { attachTradingInteraction, createTradingInteraction } = Trading;

function mockBot(name = "TestCitizen") {
  const tradingCalls = [];
  return {
    bot: {
      _calls: tradingCalls,
      isPlayerBot: () => true,
      getUsername: () => name,
      getAttribute: () => undefined,
      getPacketSender: () => ({ sendPublicChat: () => {} }),
      getTrading: () => ({
        getState: () => ({ isTrading: () => false }),
        requestTrade: (requester) => {
          tradingCalls.push(["requestTrade", requester?.getUsername?.()]);
          return true;
        },
        acceptTrade: () => { tradingCalls.push(["acceptTrade"]); },
      }),
    },
  };
}

// --- attachTradingInteraction ------------------------------------------------
{
  const { bot } = mockBot();
  attachTradingInteraction(bot);
  assert.equal(typeof bot.getTradingInteraction, "function", "interaction attached");

  // Idempotent — second attach is a no-op.
  const first = bot.getTradingInteraction;
  attachTradingInteraction(bot);
  assert.equal(bot.getTradingInteraction, first, "attach is idempotent");

  // Non-bots are skipped.
  const human = { isPlayerBot: () => false };
  attachTradingInteraction(human);
  assert.equal(human.getTradingInteraction, undefined, "humans untouched");
}

// --- interaction shape --------------------------------------------------------
{
  const { bot } = mockBot();
  attachTradingInteraction(bot);
  const interaction = bot.getTradingInteraction();
  for (const method of ["acceptTradeRequest", "addItemsToTrade", "acceptTrade", "receivedItems"]) {
    assert.equal(typeof interaction[method], "function", `${method} implemented`);
  }
}

// --- acceptTradeRequest: happy path -------------------------------------------
{
  const { bot } = mockBot();
  attachTradingInteraction(bot);
  const interaction = bot.getTradingInteraction();
  const requester = { getUsername: () => "Jon", isPlayerBot: () => false };
  const ok = interaction.acceptTradeRequest(requester);
  assert.equal(ok, true, "trade request accepted");
  assert.deepEqual(bot._calls[0], ["requestTrade", "Jon"], "handshake completed via requestTrade");
}

// --- acceptTradeRequest: enemy refused -----------------------------------------
{
  // isEnemy comes from CitizenBonds — with no bonds data, everyone is neutral.
  // We verify the refusal path structurally via a bot whose trading state
  // reports "already trading".
  const { bot } = mockBot();
  bot.getTrading = () => ({
    getState: () => ({ isTrading: () => true }),
    requestTrade: () => { throw new Error("must not request while trading"); },
    acceptTrade: () => {},
  });
  attachTradingInteraction(bot);
  const interaction = bot.getTradingInteraction();
  const ok = interaction.acceptTradeRequest({ getUsername: () => "Jon" });
  assert.equal(ok, false, "refused while already trading");
}

// --- acceptTrade: delegates ------------------------------------------------------
{
  const { bot } = mockBot();
  attachTradingInteraction(bot);
  bot.getTradingInteraction().acceptTrade();
  assert.deepEqual(bot._calls[0], ["acceptTrade"], "acceptTrade delegates to engine");
}

// --- addItemsToTrade: v1 no-op ------------------------------------------------------
{
  const { bot } = mockBot();
  attachTradingInteraction(bot);
  // Must not throw; citizen offers nothing in v1.
  bot.getTradingInteraction().addItemsToTrade({}, {});
}

// --- receivedItems: no throw -------------------------------------------------------
{
  const { bot } = mockBot();
  attachTradingInteraction(bot);
  const from = { getUsername: () => "Jon" };
  bot.getTradingInteraction().receivedItems([{ getId: () => 995, getAmount: () => 100 }], from);
}

console.log("CitizenTrading tests passed.");
