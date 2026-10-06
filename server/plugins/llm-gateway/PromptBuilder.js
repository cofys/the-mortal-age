// PromptBuilder -- assembles the LLM prompt for one chat reply, token-lean.
//
// Budget: kept lean for free-tier request/token budgets.
//   - INPUT hard cap: 2000 tokens (history is truncated oldest-first to fit).
//   - OUTPUT cap: 60 tokens (~240 chars; public chat lines are capped at 80
//     chars by the client anyway, see Mouth.js).
// Token estimate: chars / 4 (rough, English-heavy, errs on the safe side).
//
// Typical call math (see DESIGN.md):
//   world grounding ~160 + card ~120 + notes ~150 + history ~300
//   + current line ~100 + output 60 + overhead ~30  =>  ~920 tokens/call.

const TOKEN_CHARS = 4;
const estimateTokens = (text) => Math.ceil(String(text ?? "").length / TOKEN_CHARS);

const INPUT_BUDGET_TOKENS = 2000;
const MAX_OUTPUT_TOKENS = 60;
const MAX_CARD_CHARS = 480; // short personality cards, not long system prompts
const MAX_NOTES_IN_PROMPT = 5;
const MAX_HISTORY_EXCHANGES = 6;

// Fixed world grounding every citizen shares. Short on purpose.
const WORLD_GROUNDING =
  "You are a citizen of Gielinor, 'the Mortal Age': the gods have gone silent and " +
  "everyone has a theory why. Great powers: Asgarnia (Falador, no king), Misthalin " +
  "(Varrock, aging king), Kandarin (Ardougne, the plague lie), Morytania (vampyres), " +
  "Keldagrim (dwarf mining companies). Stay in character. Never mention you are an AI. " +
  "Reply in 1-2 short sentences, like a real player typing. No lists, no asterisks.";

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

function buildPrompt({ card, notes = [], history = [], message, worldContext }) {
  const systemParts = [
    worldContext || WORLD_GROUNDING,
    `Who you are: ${clampCard(card)}`,
    STYLE_LINE,
  ];
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
  estimateTokens,
  WORLD_GROUNDING,
  INPUT_BUDGET_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_CARD_CHARS,
};
