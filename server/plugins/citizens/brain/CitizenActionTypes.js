"use strict";

/**
 * CitizenActionTypes — the citizens plugin's registry extension.
 *
 * Registers the citizen brain action types and the `citizen` requires-condition
 * kind with the bot activity catalogue's extension seam (see
 * bots/brain/BotActivityRegistry.js: registerBotActionType /
 * registerBotConditionKind). No existing bot brain files are edited.
 */

const registryModule = require("../../bots/brain/BotActivityRegistry");
const {
  registerBotActionType,
  registerBotConditionKind,
} = registryModule;
const { createGuardPatrolAction } = require("./actions/GuardPatrol");
const { createMerchantAction } = require("./actions/Merchant");
const { createPrimeMerchantAction } = require("./actions/PrimeMerchant");
const { createCitizenRoutineAction } = require("./actions/CitizenRoutine");
const { createCitizenMealAction } = require("./actions/CitizenMeal");
const { createCitizenRestAction } = require("./actions/CitizenRest");
const { createCitizenBankAction } = require("./actions/CitizenBank");
const { createCitizenLightFireAction } = require("./actions/CitizenLightFire");
const { createCitizenSmeltAction } = require("./actions/CitizenSmelt");
const { createCitizenCraftAction } = require("./actions/CitizenCraft");
const { createCitizenCookAction } = require("./actions/CitizenCook");
const { createCitizenHerbAction } = require("./actions/CitizenHerb");
const { createCitizenFletchAction } = require("./actions/CitizenFletch");
const { createCitizenRcAction } = require("./actions/CitizenRc");
const { createCitizenAgilityAction } = require("./actions/CitizenAgility");
const { createCitizenSlayerAction } = require("./actions/CitizenSlayer");
const { createCitizenHuntAction } = require("./actions/CitizenHunt");
const { createCitizenFarmAction } = require("./actions/CitizenFarm");
const { createCitizenThieveAction } = require("./actions/CitizenThieve");
const { createCitizenBuildAction } = require("./actions/CitizenBuild");
const { createCitizenTravelAction } = require("./actions/CitizenTravel");
const { createCitizenEntertainAction } = require("./actions/CitizenEntertain");
const { createCitizenGuildAction } = require("./actions/CitizenGuild");
const { createCitizenPetCareAction } = require("./actions/CitizenPetCare");
const { createCitizenCreateArtAction } = require("./actions/CitizenCreateArt");
const { createCitizenPerformAction } = require("./actions/CitizenPerform");
const { createCitizenTailorWorkAction } = require("./actions/CitizenTailorWork");
const { createCitizenChefWorkAction } = require("./actions/CitizenChefWork");
const { createCitizenCelebrateAction } = require("./actions/CitizenCelebrate");

const { createCitizenCompeteAction } = require("./actions/CitizenCompete");
const { createCitizenDiplomatAction } = require("./actions/CitizenDiplomat");
const { createCitizenExploreAction } = require("./actions/CitizenExplore");
const { createCitizenInventAction } = require("./actions/CitizenInvent");
const { createCitizenPhilosophizeAction } = require("./actions/CitizenPhilosophize");
const { createCitizenLawyerAction } = require("./actions/CitizenLawyer");
const { createCitizenSurgeonAction } = require("./actions/CitizenSurgeon");
const { createCitizenConstructAction } = require("./actions/CitizenConstruct");
const { createCitizenEngineerWorkAction } = require("./actions/CitizenEngineerWork");
const { createCitizenTeamPlayAction } = require("./actions/CitizenTeamPlay");
const { createCitizenResearchAction } = require("./actions/CitizenResearch");
const { createIdleSocialAction } = require("./actions/IdleSocial");
const { createRefugeeFlightAction } = require("./actions/RefugeeFlight");
const { ATTR_KINGDOM_ID, ATTR_CITIZEN_ROLE } = require("../constants");

let registered = false;

/**
 * Condition: { citizen: { roles?: string[], kingdoms?: string[] } }.
 * True only for bots carrying the citizens:* attributes — base bots
 * (wilderness roamers, skillers) never match, so they never pick citizen
 * activities out of the shared registry.
 */
function createCitizenCondition(config) {
  const roles = Array.isArray(config?.roles) ? config.roles : null;
  const kingdoms = Array.isArray(config?.kingdoms) ? config.kingdoms : null;
  const id = `citizen:${(roles ?? []).join("+") || "*"}:${(kingdoms ?? []).join("+") || "*"}`;
  return {
    id,
    check(ctx) {
      const player = ctx?.player;
      if (!player) {
        return false;
      }
      const role = player.getAttribute?.(ATTR_CITIZEN_ROLE);
      if (typeof role !== "string" || role.length === 0) {
        return false;
      }
      if (roles && !roles.includes(role)) {
        return false;
      }
      if (kingdoms) {
        const kingdomId = player.getAttribute?.(ATTR_KINGDOM_ID);
        if (!kingdoms.includes(kingdomId)) {
          return false;
        }
      }
      return true;
    },
  };
}

function registerCitizenActionTypes() {
  if (registered) {
    return;
  }
  if (
    typeof registerBotActionType !== "function" ||
    typeof registerBotConditionKind !== "function"
  ) {
    throw new Error(
      "[citizens] the bot activity catalogue's extension seam is missing " +
        "(registerBotActionType/registerBotConditionKind) — the bots plugin's " +
        "BotActivityRegistry.js must include the catalogue extension functions"
    );
  }
  registered = true;
  registerBotActionType("guardPatrol", createGuardPatrolAction);
  registerBotActionType("merchant", createMerchantAction);
  registerBotActionType("primeMerchant", createPrimeMerchantAction);
  registerBotActionType("citizenRoutine", createCitizenRoutineAction);
  registerBotActionType("citizenMeal", createCitizenMealAction);
  registerBotActionType("citizenRest", createCitizenRestAction);
  registerBotActionType("citizenBank", createCitizenBankAction);
  registerBotActionType("citizenLightFire", createCitizenLightFireAction);
  registerBotActionType("citizenSmelt", createCitizenSmeltAction);
  registerBotActionType("citizenCraft", createCitizenCraftAction);
  registerBotActionType("citizenCook", createCitizenCookAction);
  registerBotActionType("citizenHerb", createCitizenHerbAction);
  registerBotActionType("citizenFletch", createCitizenFletchAction);
  registerBotActionType("citizenRc", createCitizenRcAction);
  registerBotActionType("citizenAgility", createCitizenAgilityAction);
  registerBotActionType("citizenSlayer", createCitizenSlayerAction);
  registerBotActionType("citizenHunt", createCitizenHuntAction);
  registerBotActionType("citizenFarm", createCitizenFarmAction);
  registerBotActionType("citizenThieve", createCitizenThieveAction);
  registerBotActionType("citizenBuild", createCitizenBuildAction);
  registerBotActionType("citizenTravel", createCitizenTravelAction);
  registerBotActionType("citizenEntertain", createCitizenEntertainAction);
  registerBotActionType("citizenGuild", createCitizenGuildAction);
  registerBotActionType("citizenPetCare", createCitizenPetCareAction);
  registerBotActionType("citizenCreateArt", createCitizenCreateArtAction);
  registerBotActionType("citizenPerform", createCitizenPerformAction);
  registerBotActionType("citizenTailorWork", createCitizenTailorWorkAction);
  registerBotActionType("citizenChefWork", createCitizenChefWorkAction);
  registerBotActionType("citizenCelebrate", createCitizenCelebrateAction);

registerBotActionType("citizenCompete", createCitizenCompeteAction);
  registerBotActionType("citizenDiplomat", createCitizenDiplomatAction);
  registerBotActionType("citizenExplore", createCitizenExploreAction);
  registerBotActionType("citizenInvent", createCitizenInventAction);
  registerBotActionType("citizenPhilosophize", createCitizenPhilosophizeAction);
  registerBotActionType("citizenLawyer", createCitizenLawyerAction);
  registerBotActionType("citizenSurgeon", createCitizenSurgeonAction);
  registerBotActionType("citizenConstruct", createCitizenConstructAction);
  registerBotActionType("citizenEngineerWork", createCitizenEngineerWorkAction);
  registerBotActionType("citizenTeamPlay", createCitizenTeamPlayAction);
  registerBotActionType("citizenResearch", createCitizenResearchAction);
  registerBotActionType("idleSocial", createIdleSocialAction);
  registerBotActionType("refugeeFlight", createRefugeeFlightAction);
  registerBotConditionKind("citizen", createCitizenCondition);
}

module.exports = {
  registerCitizenActionTypes,
};
