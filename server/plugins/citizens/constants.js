"use strict";

/**
 * constants — attribute keys, roles, modes and event names for the CITIZEN SYSTEM.
 *
 * Kingdom membership reuses the kingdoms plugin's attributes (kingdom:id,
 * kingdom:rank); citizens:* keys are this plugin's own, kebab-case and
 * namespaced per AGENTS.md.
 */

const ATTR_KINGDOM_ID = "kingdom:id";
const ATTR_KINGDOM_RANK = "kingdom:rank";
const ATTR_CITIZEN_ROLE = "citizens:role";
const ATTR_CITIZEN_PERSONALITY = "citizens:personality";
const ATTR_CITIZEN_GOAL = "citizens:goal";
const ATTR_CITIZEN_SEED = "citizens:seed";
const ATTR_CITIZEN_NEEDS = "citizens:needs";
// Per-merchant stall overrides. Unset means the default bread stall
// (see the merchant_tend spec in data/citizen-activities.json).
const ATTR_WARE_ITEM = "citizens:ware-item";
const ATTR_WARE_PRICE = "citizens:ware-price";
// Merchant specializations. Per capital: one prime (fully-real stall,
// restocks wholesale from the supplier), one supplier (wholesaler), one
// provisioner (default bread stall).
const ATTR_PRIME_MERCHANT = "citizens:prime-merchant";
const ATTR_SUPPLIER_MERCHANT = "citizens:supplier-merchant";

const ROLE_GUARD = "guard";
const ROLE_MERCHANT = "merchant";
const ROLE_COMMONER = "commoner";
const ROLE_COURTIER = "courtier";

const ROLES = Object.freeze([ROLE_GUARD, ROLE_MERCHANT, ROLE_COMMONER, ROLE_COURTIER]);

const MODE_GUARD = "citizen_guard";
const MODE_MERCHANT = "citizen_merchant";
const MODE_ROUTINE = "citizen_routine";
const MODE_SOCIAL = "citizen_social";

const ACTIVITY_GUARD_PATROL = "guard_patrol";
const ACTIVITY_MERCHANT_TEND = "merchant_tend";
const ACTIVITY_CITIZEN_ROUTINE = "citizen_routine";
const ACTIVITY_COURTIER_ATTEND = "courtier_attend";
const ACTIVITY_TAVERN_SOCIAL = "tavern_social";
const ACTIVITY_LEISURE_STROLL = "leisure_stroll";
const ACTIVITY_PRIME_MERCHANT = "prime_merchant";

// Role -> default brain activity. The director overrides by time of day.
const ROLE_ACTIVITY = Object.freeze({
  [ROLE_GUARD]: ACTIVITY_GUARD_PATROL,
  [ROLE_MERCHANT]: ACTIVITY_MERCHANT_TEND,
  [ROLE_COMMONER]: ACTIVITY_CITIZEN_ROUTINE,
  [ROLE_COURTIER]: ACTIVITY_COURTIER_ATTEND,
});

// Kingdom events this plugin listens to (emitted by the kingdoms plugin).
const EVENT_WAR_DECLARED = "kingdom:war-declared";
const EVENT_WAR_ENDED = "kingdom:war-ended";
const EVENT_RANK_GRANTED = "kingdom:rank-granted";
const EVENT_OFFICE_ASSIGNED = "kingdom:office-assigned";
const EVENT_OFFICE_VACATED = "kingdom:office-vacated";

// llm-gateway contract (see server/plugins/llm-gateway/LlmGateway.plugin.js).
const EVENT_LLM_CITIZEN_REGISTER = "llm:citizen-register";
const EVENT_LLM_CHAT_REQUEST = "llm:chat-request";

// Citizens-side chat-heard interface. The llm-gateway owns LLM replies; this
// event is what the citizens plugin would emit if a public-chat hook ever
// lands in core (see llm-gateway/ChatInterceptor.js notes). Stubbed in v1.
const EVENT_CITIZEN_CHAT_HEARD = "citizens:chat-heard";

module.exports = {
  ATTR_KINGDOM_ID,
  ATTR_KINGDOM_RANK,
  ATTR_CITIZEN_ROLE,
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_GOAL,
  ATTR_CITIZEN_SEED,
  ATTR_CITIZEN_NEEDS,
  ATTR_WARE_ITEM,
  ATTR_WARE_PRICE,
  ATTR_PRIME_MERCHANT,
  ATTR_SUPPLIER_MERCHANT,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_COMMONER,
  ROLE_COURTIER,
  ROLES,
  MODE_GUARD,
  MODE_MERCHANT,
  MODE_ROUTINE,
  MODE_SOCIAL,
  ACTIVITY_GUARD_PATROL,
  ACTIVITY_MERCHANT_TEND,
  ACTIVITY_CITIZEN_ROUTINE,
  ACTIVITY_COURTIER_ATTEND,
  ACTIVITY_TAVERN_SOCIAL,
  ACTIVITY_LEISURE_STROLL,
  ACTIVITY_PRIME_MERCHANT,
  ROLE_ACTIVITY,
  EVENT_WAR_DECLARED,
  EVENT_WAR_ENDED,
  EVENT_RANK_GRANTED,
  EVENT_OFFICE_ASSIGNED,
  EVENT_OFFICE_VACATED,
  EVENT_LLM_CITIZEN_REGISTER,
  EVENT_LLM_CHAT_REQUEST,
  EVENT_CITIZEN_CHAT_HEARD,
};
