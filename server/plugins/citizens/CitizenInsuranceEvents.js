"use strict";

/**
 * CitizenInsuranceEvents — player-facing insurance: the ::insurance
 * command and the player-death life-claim hook.
 *
 * Mirrors the PlayerShops command pattern (PlayerRights.NONE so every
 * player can use it). All coin movement is real: premiums leave the
 * player's real inventory, claims land in the real inventory or bank
 * account. Player policies are prepaid 4 weeks at purchase (the slow
 * tick cannot collect from an offline player honestly).
 */

const Insurance = require("./lib/CitizenInsurance");

const COINS_ID = 995;
const PLAYER_PREPAY_WEEKS = 4;

const USAGE =
  "Insurance: ::insurance [quote <type> [face]|buy <type> [face]|policies|cancel <type>|stats]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function kingdomOf(player) {
  try {
    return player?.getAttribute?.("kingdom:id") ?? player?.getAttribute?.("kingdomId") ?? null;
  } catch {
    return null;
  }
}

function typeList() {
  return Object.keys(Insurance.POLICY_TYPES).join(", ");
}

function describePolicy(p) {
  const term = p.nextDueAt
    ? `renews ${new Date(p.nextDueAt).toISOString().slice(0, 10)}`
    : "single journey";
  return `${p.type}: face ${p.faceValue}, premium ${p.premium}/wk (${term})`;
}

function onInsuranceCommand({ player, parts }) {
  if (!player || player.isPlayerBot?.() === true) return true; // citizens don't run this
  const username = usernameOf(player);
  const sub = String(parts[1] ?? "help").toLowerCase();

  try {
    switch (sub) {
      case "help": {
        player.sendMessage("Insurance protects what matters. Types: " + typeList() + ".");
        player.sendMessage("::insurance quote <type> [face] — price a policy.");
        player.sendMessage("::insurance buy <type> [face] — buy it (4 weeks prepaid, real coins).");
        player.sendMessage("::insurance policies — list your cover.");
        player.sendMessage("::insurance cancel <type> — lapse a policy (no refund).");
        player.sendMessage("Claims pay automatically: death and road-robbery are detected.");
        return true;
      }
      case "quote": {
        const type = String(parts[2] ?? "").toLowerCase();
        const face = Math.floor(Number(parts[3]) || 0);
        const def = Insurance.POLICY_TYPES[type];
        if (!def) {
          player.sendMessage(`Unknown type. Choose: ${typeList()}.`);
          return true;
        }
        const q = Insurance.quote(username, type, face || def.minFace, {
          kingdomId: kingdomOf(player),
          isPlayer: true,
        });
        if (!q.ok) {
          player.sendMessage(`Cannot quote: face must be ${q.minFace}-${q.maxFace} coins.`);
          return true;
        }
        const riskBits = q.factors.length ? ` (risk: ${q.factors.join(", ")})` : "";
        player.sendMessage(
          `${type} cover, face ${q.faceValue}: ${q.premium} coins/week${riskBits}. ${def.benefit}`
        );
        return true;
      }
      case "buy": {
        const type = String(parts[2] ?? "").toLowerCase();
        const def = Insurance.POLICY_TYPES[type];
        if (!def) {
          player.sendMessage(`Unknown type. Choose: ${typeList()}.`);
          return true;
        }
        const face = Math.floor(Number(parts[3]) || 0) || def.minFace;
        const r = Insurance.buyPolicy(player, username, type, face, {
          kingdomId: kingdomOf(player),
          isPlayer: true,
        });
        if (!r.ok) {
          const why = {
            "insufficient": `You need ${r.premium} coins for the first premium.`,
            "already-insured": `You already hold an active ${type} policy.`,
            "amount": `Face must be ${Insurance.POLICY_TYPES[type].minFace}-${Insurance.POLICY_TYPES[type].maxFace} coins.`,
            "insurer-insolvent": "The insurer pool is too thin right now — try again later.",
          }[r.reason] ?? `Could not sell that policy (${r.reason}).`;
          player.sendMessage(why);
          return true;
        }
        // Players prepay: the tick cannot honestly collect from an offline player.
        if (def.term === "weekly") {
          const extra = r.policy.premium * (PLAYER_PREPAY_WEEKS - 1);
          const inv = player.getInventory?.();
          const have = inv?.getAmount?.(COINS_ID) ?? 0;
          if (have >= extra && inv?.remove?.(COINS_ID, extra)) {
            const st = Insurance._data();
            st.pool += extra;
            st.totalPremiums += extra;
            r.policy.nextDueAt = Date.now() + PLAYER_PREPAY_WEEKS * Insurance.PREMIUM_TICK_MS;
            r.policy.prepaidWeeks = PLAYER_PREPAY_WEEKS;
            Insurance.markDirty();
            player.sendMessage(
              `${type} policy bought: face ${r.policy.faceValue}, ` +
              `${r.policy.premium * PLAYER_PREPAY_WEEKS} coins for ${PLAYER_PREPAY_WEEKS} weeks prepaid.`
            );
          } else {
            player.sendMessage(
              `${type} policy bought: face ${r.policy.faceValue}, ` +
              `${r.policy.premium} coins for the first week. (Could not prepay ${PLAYER_PREPAY_WEEKS} weeks — carry more coins.)`
            );
          }
        } else {
          player.sendMessage(
            `${type} policy bought: face ${r.policy.faceValue}, premium ${r.policy.premium} coins, covers your next journey.`
          );
        }
        return true;
      }
      case "policies": {
        const mine = Insurance.policiesOf(username);
        if (mine.length === 0) {
          player.sendMessage("You hold no active policies. ::insurance quote <type> to price one.");
          return true;
        }
        for (const p of mine) player.sendMessage(describePolicy(p));
        return true;
      }
      case "cancel": {
        const type = String(parts[2] ?? "").toLowerCase();
        const r = Insurance.cancelPolicy(username, type);
        player.sendMessage(r.ok ? `${type} policy lapsed. No refund on prepaid premiums.` : `No active ${type} policy.`);
        return true;
      }
      case "stats": {
        const s = Insurance.stats();
        player.sendMessage(
          `Insurer pool: ${s.pool} coins. ${s.activePolicies} active policies, ${s.exposure} coins of cover. ` +
          `${s.insurers} insurers underwriting.`
        );
        return true;
      }
      default:
        player.sendMessage(USAGE);
        return true;
    }
  } catch {
    return true;
  }
}

/**
 * A real player died with an active life policy: pay the face value to
 * their estate (bank account, else inventory on respawn via payoutsOwed).
 */
function onPlayerDeathInsured(event) {
  try {
    const player = event?.player;
    if (!player || player.isPlayerBot?.() === true) return;
    const username = usernameOf(player);
    if (!username) return;
    const policy = Insurance.policyFor(username, "life");
    if (!policy || policy.status !== "active") return;
    const r = Insurance.fileClaim(username, "life", "death", { player });
    if (r?.ok) {
      try {
        player.sendMessage?.(
          `Your life insurance paid ${r.paid} coins to your estate.` +
          (r.owed > 0 ? ` ${r.owed} coins still owed — the pool will pay when it recovers.` : "")
        );
      } catch { /* message optional */ }
    }
  } catch { /* never break death handling */ }
}

module.exports = { onInsuranceCommand, onPlayerDeathInsured, USAGE };
