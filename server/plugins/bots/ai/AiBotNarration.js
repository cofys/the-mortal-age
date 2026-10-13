"use strict";

/**
 * AiBotNarration — post-processing for AI bot chat lines.
 *
 * stripSelfNarration: the model sometimes narrates itself in third person
 * ("Sidney Parker, a commoner from Misthalin, humbly responds: Of course!").
 * The game shows the name above the head; a real player never narrates
 * themselves. Jon 2026-10-13.
 *
 * Dependency-free so unit tests run under plain node.
 */
function stripSelfNarration(text, botName) {
  let out = String(text ?? "").trim();
  if (!out || !botName) return out;
  const full = String(botName).trim();
  const first = full.split(/\s+/)[0];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [full, first].filter((n, i, a) => n && n.length >= 3 && a.indexOf(n) === i);
  for (const name of names) {
    // "Name, a commoner from Misthalin, humbly responds: <line>"
    const narrated = new RegExp(
      "^" + esc(name) + "\\s*,?\\s*(?:an?\\s+)?[^:;.!?]{0,80}?\\b(responds|says|replies|answers|asks|laughs|nods|smiles|shrugs|murmurs|whispers|shouts|exclaims)\\s*:\\s*",
      "i"
    );
    const m = out.match(narrated);
    if (m) {
      out = out.slice(m[0].length).trim();
      break;
    }
    // Fallback: bare "Name: <line>" / "Name, <line>" prefix.
    const bare = new RegExp("^" + esc(name) + "\\s*[:,]\\s*", "i");
    const b = out.match(bare);
    if (b) {
      out = out.slice(b[0].length).trim();
      break;
    }
  }
  return out;
}

module.exports = { stripSelfNarration };
