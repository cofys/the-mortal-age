"use strict";

/**
 * JobsApi — HTTP data layer for the web client's Job Board overlay.
 *
 * Mirrors MyKingdomApi: the Town crier's "Look for work." sets the
 * `jobs:open` flag, the client polls this endpoint while it is set, and
 * state-changing actions (claim / complete / abandon) require the
 * per-session token via ContentApiAuth, exactly like My Kingdom's
 * renounce. The board itself is read model only — Jobs.Kingdoms
 * generates postings from real state and verifies every completion.
 *
 *   GET /api/jobs-status?player=<username>
 *     -> { open, jobs, myClaims }
 *   ...&action=open|close
 *   ...&action=claim|complete|abandon&job=<jobId>   (authed)
 */

const Store = require("./KingdomStore");
const Jobs = require("./Jobs.Kingdoms");
const ContentApiAuth = require("../interface/ContentApiAuth");

const JOBS_OPEN_ATTRIBUTE = "jobs:open";

function findPlayer(api, name) {
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kingdomId: job.kingdomId,
    type: job.type,
    title: job.title,
    detail: job.detail,
    rewardGold: job.rewardGold ?? 0,
    rewardInfluence: job.rewardInfluence ?? 0,
    units: job.units ?? 0,
    deliveredUnits: job.deliveredUnits ?? 0,
    claimedBy: job.claimedBy ?? null,
    status: job.status,
    expiresAt: job.expiresAt ?? null,
  };
}

function statusPayload(player) {
  let homeId = null;
  try {
    homeId = player ? player.getAttribute("kingdom:id") || null : null;
  } catch {
    homeId = null;
  }
  const username = (() => {
    try {
      return player?.getUsername?.() ?? null;
    } catch {
      return null;
    }
  })();
  let jobs = [];
  try {
    jobs = Jobs.boardFor(homeId, Store).map(publicJob);
  } catch {
    jobs = [];
  }
  let myClaims = [];
  try {
    myClaims = username ? Jobs.claimsOf(username, Store).map(publicJob) : [];
  } catch {
    myClaims = [];
  }
  return { open: true, jobs, myClaims };
}

function attach(api) {
  console.info("[jobs-api] registering jobs-status endpoint");
  ContentApiAuth.setPluginApi(api);
  api.registerContentEndpoint("jobs-status", (query) => {
    const player = findPlayer(api, query.get("player"));
    const action = (query.get("action") || "").trim().toLowerCase();

    if (action === "claim" || action === "complete" || action === "abandon") {
      // State-changing: the session token must name the player.
      const authed = ContentApiAuth.requireAuth(query);
      if (!authed) return { open: false, error: "unauthorized" };
      const jobId = (query.get("job") || "").trim();
      if (!jobId) return { ...statusPayload(authed), actionResult: { ok: false, reason: "no-job" } };
      let result = null;
      try {
        if (action === "claim") result = Jobs.claim(authed, jobId, Store);
        else if (action === "complete") result = Jobs.complete(authed, jobId, Store);
        else result = Jobs.abandon(authed, jobId, Store);
      } catch (e) {
        console.warn("[jobs-api] action failed", action, e?.message ?? e);
        result = { ok: false, reason: "error" };
      }
      return {
        ...statusPayload(authed),
        actionResult: result
          ? { ok: !!result.ok, reason: result.reason ?? null, paidGold: result.paidGold ?? null }
          : { ok: false, reason: "error" },
      };
    }

    if (player && (action === "open" || action === "close")) {
      try {
        player.setAttribute(JOBS_OPEN_ATTRIBUTE, action === "open" ? "1" : "");
      } catch (e) {
        console.warn("[jobs-api] flag update failed", e?.message ?? e);
      }
      if (action === "close") return { open: false };
      return statusPayload(player);
    }

    if (!player) return { open: false };
    let open = "";
    try {
      open = String(player.getAttribute(JOBS_OPEN_ATTRIBUTE) || "").trim();
    } catch {
      return { open: false };
    }
    if (!open) return { open: false };

    try {
      return statusPayload(player);
    } catch (e) {
      console.warn("[jobs-api] payload failed", e?.message ?? e);
      return { open: false };
    }
  });
}

module.exports = attach;
module.exports.attach = attach;
module.exports.JOBS_OPEN_ATTRIBUTE = JOBS_OPEN_ATTRIBUTE;
module.exports._test = { statusPayload, publicJob };
