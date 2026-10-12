// PromptBuilder -- assembles the LLM prompt for one chat reply, token-lean.
//
// Budget: kept lean for free-tier request/token budgets.
//   - INPUT hard cap: 2000 tokens (history is truncated oldest-first to fit).
//   - OUTPUT cap: 32 tokens (~128 chars = ~2 short sentences). Citizens talk
//     like real players: short, but with substance. Mouth.js paces multi-line
//     replies with natural pauses between lines.
// Token estimate: chars / 4 (rough, English-heavy, errs on the safe side).
//
// Typical call math (see DESIGN.md):
//   world grounding ~200 + card ~120 + notes ~150 + history ~300
//   + current line ~100 + output 32 + overhead ~30  =>  ~930 tokens/call.

const TOKEN_CHARS = 4;
const estimateTokens = (text) => Math.ceil(String(text ?? "").length / TOKEN_CHARS);

const INPUT_BUDGET_TOKENS = 2000;
const MAX_OUTPUT_TOKENS = 20; // ~80 chars = one chat line. Multi-chunk utterances
// interleave with other speakers in the chatbox, so generation must fit in a
// single chunk. Shorter is more human anyway.
const MAX_CARD_CHARS = 480; // short personality cards, not long system prompts
const MAX_NOTES_IN_PROMPT = 5;
const MAX_HISTORY_EXCHANGES = 6;

// Fixed world grounding every citizen shares. Short on purpose, but demands
// specificity: generic greetings are the NPC tell. Real players talk about
// what they're doing, what they want, and what's happening.
const WORLD_GROUNDING =
  "You are a citizen of Gielinor, 'the Mortal Age': the gods have gone silent and " +
  "everyone has a theory why. Great powers: Asgarnia (Falador, no king), Misthalin " +
  "(Varrock, aging king), Kandarin (Ardougne, the plague lie), Morytania (vampyres), " +
  "Keldagrim (dwarf mining companies). Stay in character. Never mention you are an AI. " +
  "Reply in one short sentence (under 80 characters), like a real player typing. " +
  "Be specific: mention what you're doing, what you're working toward, or what's " +
  "happening around you. Have opinions — real players complain, brag, and gossip. " +
  "Never give a generic greeting; if you wouldn't say it to a friend, don't say it. " +
  "Never start your message with your own name - the chat already shows who is speaking. " +
  "No lists, no asterisks, no line breaks - one paragraph only.";

const STYLE_LINE =
  "You are roleplaying a RuneScape player-character, not an assistant. " +
  "Sound like a person, not a helpdesk. Keep it brief.";

function clampCard(card) {
  return String(card ?? "").slice(0, MAX_CARD_CHARS);
}

function renderHistory(history) {
  return (history ?? []).slice(-MAX_HISTORY_EXCHANGES).map((exchange) =>
    `Them: ${exchange.playerText}\nYou: ${exchange.replyText}`
  );
}

/**
 * buildSpeakPrompt — the citizen speaks FIRST (no incoming message).
 * Used for citizen-to-citizen conversation openers: one citizen notices
 * another nearby and says something unprompted, like a real player would.
 *
 * { card, context, toName, toRole, toMemory }
 *   toMemory: what this citizen remembers about the other (standing, past
 *   meetings) — strangers get a stranger's greeting, old friends get warmth.
 */
function buildSpeakPrompt({ card, context, toName, toRole, toMemory, toKind, playerNote, worldContext, citizenName }) {
  const systemParts = [
    worldContext || WORLD_GROUNDING,
    `Who you are: ${clampCard(card)}`,
    STYLE_LINE,
  ];
  const displayName = String(citizenName ?? "").trim();
  if (displayName) {
    systemParts.push(`Your name is "${displayName}". If anyone asks your name or who you are, say "${displayName}" — that is who you are, no other name.`);
  }
  const liveContext = String(context ?? "").trim().slice(0, 400);
  if (liveContext) {
    systemParts.push(`Right now: ${liveContext}`);
  }
  const system = systemParts.join("\n\n");

  let user;
  if (toKind === "player") {
    // A citizen notices a REAL player nearby and speaks first: a greeting,
    // a comment, a reaction. This is what makes the world feel alive.
    // Anchor it in what they're actually doing — that's what real players
    // talk about, not generic hellos.
    const note = String(playerNote ?? "").trim();
    user =
      `You notice ${toName}, a real traveler, nearby. ` +
      (toMemory ? `${toMemory} ` : "") +
      (note ? `${note} ` : "") +
      `Say something to them grounded in your current moment — what you're ` +
      `doing, working toward, or noticing. Mention it specifically, like ` +
      `"almost 70 fishing" or "these yews are packed today". Have an opinion ` +
      `or ask them something real. One short sentence (under 80 characters), like a real player ` +
      `typing. Speak directly, no narration, no asterisks.`;
  } else {
    user =
      `You notice ${toName}, ${toRole ?? "a fellow citizen"}, nearby. ` +
      (toMemory ? `${toMemory} ` : "") +
      `Say something grounded in your current moment — what you're doing, ` +
      `working toward, or noticing. Be specific, have an opinion, or share ` +
      `a bit of gossip. One short sentence (under 80 characters), like a real player typing. ` +
      `Speak directly, no narration, no asterisks.`;
  }

  const inputTokens = estimateTokens(system) + estimateTokens(user);
  return {
    system,
    user,
    maxTokens: MAX_OUTPUT_TOKENS,
    inputTokens,
    outputTokens: MAX_OUTPUT_TOKENS,
    totalBudgetTokens: inputTokens + MAX_OUTPUT_TOKENS,
    tier: "lite", // citizen-to-citizen never burns flagship/standard quota
  };
}

function buildPrompt({ card, notes = [], history = [], message, worldContext, context, citizenName }) {
  const systemParts = [
    worldContext || WORLD_GROUNDING,
    `Who you are: ${clampCard(card)}`,
    STYLE_LINE,
  ];
  // Explicit identity: the model must know its own name cold. If asked
  // "what's your name" or "who are you", it answers with this — no hedging,
  // no "I'm an AI", no making one up.
  const displayName = String(citizenName ?? "").trim();
  if (displayName) {
    systemParts.push(`Your name is "${displayName}". If anyone asks your name or who you are, say "${displayName}" — that is who you are, no other name.`);
  }
  // The citizen's live moment: mood, activity, goal, relationship. This is
  // what makes a reply sound like a person living a life, not a chatbot.
  const liveContext = String(context ?? "").trim().slice(0, 400);
  if (liveContext) {
    systemParts.push(`Right now: ${liveContext}`);
  }
  const noteLines = (notes ?? []).slice(0, MAX_NOTES_IN_PROMPT);
  if (noteLines.length > 0) {
    systemParts.push(`What you remember about this player:\n- ${noteLines.join("\n- ")}`);
  }
  let system = systemParts.join("\n\n");

  let historyLines = renderHistory(history);
  let user = [...historyLines, `Them: ${message}`].join("\n");

  // Truncate oldest history first until the input budget fits.
  while (
    historyLines.length > 0 &&
    estimateTokens(system) + estimateTokens(user) > INPUT_BUDGET_TOKENS
  ) {
    historyLines = historyLines.slice(1);
    user = [...historyLines, `Them: ${message}`].join("\n");
  }
  // Last resort: cut the incoming message (should never happen with 2000).
  if (estimateTokens(system) + estimateTokens(user) > INPUT_BUDGET_TOKENS) {
    const room = INPUT_BUDGET_TOKENS - estimateTokens(system) - estimateTokens("Them: ");
    user = `Them: ${String(message).slice(0, Math.max(0, room * TOKEN_CHARS))}`;
  }

  const inputTokens = estimateTokens(system) + estimateTokens(user);
  return {
    system,
    user,
    maxTokens: MAX_OUTPUT_TOKENS,
    inputTokens,
    outputTokens: MAX_OUTPUT_TOKENS,
    totalBudgetTokens: inputTokens + MAX_OUTPUT_TOKENS,
  };
}

module.exports = {
  buildPrompt,
  buildSpeakPrompt,
  estimateTokens,
  WORLD_GROUNDING,
  INPUT_BUDGET_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_CARD_CHARS,
};
