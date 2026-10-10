/**
 * Shield of Arrav.
 *
 * Words come from npc-dialogues.json, page "Shield of Arrav" (the modern
 * transcript). This plugin supplies the variant selector, the prose-condition
 * answers, the start hook, the gang-choice / hand-in actions and the simple
 * object, item and npc-death interactions from the xrsps reference.
 *
 * Stages (varp 145): 0 not started, 1 started, 2 read the book, 3 gang task,
 * 4 joined a gang, 6 certificate halves, 7 complete. Stage 5 is unused by the
 * reference (the shield half is checked by inventory, not a stage).
 *
 * Supporting state is kept in attributes (the reference's varp flag bits):
 *   gang                    0 none, 1 Phoenix, 2 Black Arm
 *   phoenixLocationKnown    Baraek was paid
 *   charliePaid             Charlie was paid for the hideout tip
 *   reldoMet                Reldo's first-time greeting was used
 *
 * Reachability notes:
 *  - NPC variant selection is only consulted for cache ids the dialogue index
 *    lists against the "Shield of Arrav" page. The reference ids 6203 (Reldo)
 *    and 5211 (Weaponsmaster) are not in the index; 4242/4243 and 14137 are,
 *    so both are handled here.
 *  - The curator (5214) is indexed, but not against Shield of Arrav, so Talk-to
 *    would play The Dig Site instead. An id-specific npc hook intercepts his
 *    Talk-to for the shield-half hand-in and replays the Shield of Arrav page
 *    with startTranscript, which keeps his chathead and the action step ids.
 *  - The world Jonny the Beard (5213) is Talk-to only. When a Phoenix player
 *    takes Straven's task, an owner-only attackable Jonny (14139) spawns on the
 *    Blue Moon Inn spawn tile so the kill and the intel report drop work.
 */
module.exports = function registerShieldOfArravQuest(api) {
  const { Location, Item, ItemIdentifiers, NpcIdentifiers, ObjectIdentifiers } = api.core;
  const { registerQuest, startTranscript } = require("../QuestRuntime");

  const VARP_SHIELD_OF_ARRAV = 145;

  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 1;
  const STAGE_READ_BOOK = 2;
  const STAGE_GANG_TASK = 3;
  const STAGE_JOINED_GANG = 4;
  const STAGE_CERTIFICATE = 6;
  const STAGE_COMPLETE = 7;

  const BOOK_ID = ItemIdentifiers.BOOK;
  const KEY_ID = ItemIdentifiers.WEAPON_STORE_KEY;
  const REPORT_ID = ItemIdentifiers.INTEL_REPORT;
  const PHOENIX_HALF_ID = ItemIdentifiers.BROKEN_SHIELD;
  const BLACKARM_HALF_ID = ItemIdentifiers.BROKEN_SHIELD_2;
  const CROSSBOW_ID = ItemIdentifiers.PHOENIX_CROSSBOW;
  const CERTIFICATE_ID = ItemIdentifiers.CERTIFICATE;
  const PHOENIX_CERT_ID = ItemIdentifiers.HALF_CERTIFICATE;
  const BLACKARM_CERT_ID = ItemIdentifiers.HALF_CERTIFICATE_2;
  const COINS_ID = ItemIdentifiers.COINS;

  // Reference cache ids the generated NpcIdentifiers enum has no member for
  // (grep by number found nothing); kept as named constants.
  const RELDO_REFERENCE_NPC_ID = 6203;
  const WEAPONSMASTER_REFERENCE_NPC_ID = 5211;
  const JONNY_REFERENCE_NPC_ID = 5213;

  const RELDO_NPC_IDS = new Set([RELDO_REFERENCE_NPC_ID, NpcIdentifiers.RELDO, NpcIdentifiers.RELDO_2]);
  const BARAEK_NPC_IDS = new Set([NpcIdentifiers.BARAEK, NpcIdentifiers.BARAEK_2]);
  const CHARLIE_NPC_ID = NpcIdentifiers.CHARLIE_THE_TRAMP;
  const KATRINE_NPC_ID = NpcIdentifiers.KATRINE;
  const STRAVEN_NPC_ID = NpcIdentifiers.STRAVEN;
  const WEAPONSMASTER_NPC_IDS = new Set([WEAPONSMASTER_REFERENCE_NPC_ID, NpcIdentifiers.WEAPONSMASTER]);
  const CURATOR_NPC_ID = NpcIdentifiers.CURATOR_HAIG_HALEN;
  const KING_ROALD_NPC_IDS = new Set([
    NpcIdentifiers.KING_ROALD,
    NpcIdentifiers.KING_ROALD_3,
    NpcIdentifiers.KING_ROALD_5,
    NpcIdentifiers.KING_ROALD_6,
    NpcIdentifiers.KING_ROALD_7,
  ]);
  const JONNY_NPC_IDS = new Set([JONNY_REFERENCE_NPC_ID, NpcIdentifiers.JONNY_THE_BEARD, NpcIdentifiers.JONNY_THE_BEARD_2]);
  const JONNY_ATTACKABLE_NPC_ID = NpcIdentifiers.JONNY_THE_BEARD_2;
  const JONNY_SPAWN_X = 3223;
  const JONNY_SPAWN_Y = 3395;

  const BOOKCASE_ID = ObjectIdentifiers.BOOKCASE_10;
  const PHOENIX_CHEST_ID = ObjectIdentifiers.CHEST_11;
  const BLACKARM_CUPBOARD_ID = ObjectIdentifiers.CUPBOARD_12;
  const WEAPON_STORE_DOOR_ID = ObjectIdentifiers.DOOR_70;
  const BLACKARM_DOOR_ID = ObjectIdentifiers.DOOR_71;
  const PHOENIX_HIDEOUT_DOOR_ID = ObjectIdentifiers.DOOR_69;

  const WEAPON_STORE_DOOR_X = 3251;
  const BLACKARM_DOOR_X = 3185;
  const PHOENIX_HIDEOUT_DOOR_Y = 9779;

  const GANG_PHOENIX = 1;
  const GANG_BLACKARM = 2;

  const GANG_ATTRIBUTE = "shield-of-arrav.gang";
  const PHOENIX_LOCATION_ATTRIBUTE = "shield-of-arrav.phoenix-location-known";
  const CHARLIE_PAID_ATTRIBUTE = "shield-of-arrav.charlie-paid";
  const RELDO_MET_ATTRIBUTE = "shield-of-arrav.reldo-met";

  const PAGE = "Shield of Arrav";
  const START_HOOK = "quest:shield-of-arrav:start";

  // Transcript step ids. Message steps keep handled=false so their text still
  // shows; action-type steps are consumed with handled=true.
  const BARAEK_PAY_ACTIONS = new Set(["6ECylA", "5UTIVW"]);
  const CHARLIE_TEN_COIN_MESSAGES = new Set(["-YbdFO", "OfFGS6"]);
  const CHARLIE_FIVE_COIN_MESSAGES = new Set(["24Nlqb", "Fo_zeD", "DSC-L4", "7GfBwz"]);
  const STRAVEN_HANDIN_ACTIONS = new Set(["XSi6qr"]);
  const STRAVEN_KEY_MESSAGE = "G02Ai7";
  const STRAVEN_LOST_KEY_MESSAGES = new Set(["zyd3U3", "xWwA_D"]);
  const KATRINE_HANDIN_MESSAGE = "i8Y3sS";
  const KATRINE_HANDIN_ACTION = "q34K2Z";
  const CURATOR_CERT_MESSAGE = "2pltJk";
  const CURATOR_REPLACE_MESSAGE = "g7REXu";
  const CURATOR_SHIELD_VARIANT = "finishing-up-talking-to-curator-haig-halen";
  const CURATOR_REPLACE_VARIANT = "finishing-up-talking-to-the-curator-again-after-giving-him-the-shield-half";
  const KING_COMPLETE_ACTIONS = new Set(["25_j1f", "e0pTWp"]);

  const CHARLIE_ALLEY_OPTION = "Is there anything down this alleyway?";

  let quest;
  let groundItems;

  const jonnyByPlayer = new Map();
  const reldoFirstTalk = new WeakMap();

  const attr = (player, key) => Number(player.getAttribute(key)) || 0;
  const gang = (player) => attr(player, GANG_ATTRIBUTE);
  const gangChosen = (player) => gang(player) !== 0;
  const isPhoenix = (player) => gang(player) === GANG_PHOENIX;
  const isBlackArm = (player) => gang(player) === GANG_BLACKARM;
  const hasItem = (player, itemId, amount = 1) => player.getInventory().getAmount(itemId) >= amount;
  const coins = (player) => player.getInventory().getAmount(COINS_ID);

  function setGang(player, value) {
    player.setAttribute(GANG_ATTRIBUTE, value);
  }

  function giveItem(player, itemId, message) {
    if (player.getInventory().isFull()) {
      player.sendMessage("You need a free inventory space.");
      return false;
    }
    player.getInventory().adds(itemId, 1);
    if (message) player.sendMessage(message);
    return true;
  }

  function freeSlots(player) {
    const inventory = player.getInventory();
    if (typeof inventory.getFreeSlots === "function") return inventory.getFreeSlots();
    return inventory.isFull() ? 0 : 1;
  }

  function giveItems(player, itemId, quantity, message) {
    if (freeSlots(player) < quantity) {
      player.sendMessage("You need more inventory space.");
      return false;
    }
    player.getInventory().adds(itemId, quantity);
    if (message) player.sendMessage(message);
    return true;
  }

  function ownShieldAndCert(player) {
    if (!gangChosen(player)) return undefined;
    return isPhoenix(player)
      ? { shield: PHOENIX_HALF_ID, half: PHOENIX_CERT_ID }
      : { shield: BLACKARM_HALF_ID, half: BLACKARM_CERT_ID };
  }

  function hasShieldHalf(player) {
    return hasItem(player, PHOENIX_HALF_ID) || hasItem(player, BLACKARM_HALF_ID);
  }

  function hasCertHalf(player) {
    return hasItem(player, PHOENIX_CERT_ID) || hasItem(player, BLACKARM_CERT_ID);
  }

  function handInReport(player, questHandle) {
    if (!isPhoenix(player) || questHandle.getStage(player) !== STAGE_GANG_TASK) return false;
    if (!hasItem(player, REPORT_ID)) return false;
    if (player.getInventory().isFull()) return false;
    player.getInventory().deleteNumber(REPORT_ID, 1);
    giveItem(player, KEY_ID);
    questHandle.setStage(player, STAGE_JOINED_GANG);
    removeJonny(player);
    return true;
  }

  /**
   * The world Jonny (5213) only has Talk-to, so a Phoenix player on the gang
   * task gets a private attackable copy (14139) on the same tile. Kept while
   * the task is open, respawned after a kill so a lost report is recoverable.
   */
  function ensureJonny(player) {
    if (!isPhoenix(player) || quest.getStage(player) !== STAGE_GANG_TASK) return;
    if (jonnyByPlayer.has(player)) return;
    const npc = api.spawnNpc({
      id: JONNY_ATTACKABLE_NPC_ID,
      x: JONNY_SPAWN_X,
      y: JONNY_SPAWN_Y,
      z: 0,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (!npc) return;
    // Without this the death task queues the definition's own respawn, leaving an
    // untracked copy behind alongside the one handleNpcDeath spawns.
    npc.__skipDefaultRespawn = true;
    jonnyByPlayer.set(player, npc);
  }

  function removeJonny(player) {
    const npc = jonnyByPlayer.get(player);
    if (!npc) return;
    jonnyByPlayer.delete(player);
    api.removeNpc(npc);
  }

  function handInShieldHalf(player, questHandle) {
    const own = ownShieldAndCert(player);
    if (!own || questHandle.getStage(player) !== STAGE_JOINED_GANG) return false;
    if (!hasItem(player, own.shield)) return false;
    if (freeSlots(player) < 1) {
      player.sendMessage("You need a free inventory space.");
      return false;
    }
    player.getInventory().deleteNumber(own.shield, 1);
    giveItems(player, own.half, 2);
    questHandle.setStage(player, STAGE_CERTIFICATE);
    return true;
  }

  function handInCrossbows(player, questHandle) {
    if (!isBlackArm(player) || questHandle.getStage(player) !== STAGE_GANG_TASK) return false;
    if (!hasItem(player, CROSSBOW_ID, 2)) return false;
    player.getInventory().deleteNumber(CROSSBOW_ID, 2);
    questHandle.setStage(player, STAGE_JOINED_GANG);
    return true;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage === STAGE_NOT_STARTED) {
      return ["I can start this quest by speaking to", "<col=800000>Reldo</col> in Varrock Palace library."];
    }
    if (stage >= STAGE_COMPLETE) {
      return ["<str>I returned the Shield of Arrav to Varrock.</str>", "", "<col=ff0000>QUEST COMPLETE!</col>"];
    }

    const lines = ["Reldo told me about the stolen Shield of Arrav."];
    if (stage === STAGE_STARTED) {
      lines.push("I should search the marked bookcase and read the book.");
      return lines;
    }
    if (stage === STAGE_READ_BOOK && !gangChosen(player)) {
      lines.push("I can investigate the Phoenix Gang through Baraek,", "or the Black Arm Gang through Charlie the Tramp.");
      return lines;
    }

    const phoenix = isPhoenix(player);
    lines.push(`I chose to work with the <col=800000>${phoenix ? "Phoenix" : "Black Arm"} Gang</col>.`);
    if (stage === STAGE_READ_BOOK) {
      lines.push(phoenix ? "I should find Straven at the Phoenix hideout." : "I should speak to Katrine in the Black Arm hideout.");
    } else if (stage === STAGE_GANG_TASK) {
      lines.push(
        phoenix
          ? "I must kill Jonny the Beard and return his intel report."
          : "I must bring Katrine two Phoenix crossbows."
      );
    } else if (stage === STAGE_JOINED_GANG) {
      const shield = phoenix ? PHOENIX_HALF_ID : BLACKARM_HALF_ID;
      lines.push(
        hasItem(player, shield)
          ? "I have my half of the shield and should take it to the curator."
          : `I should search the ${phoenix ? "Phoenix chest" : "Black Arm cupboard"} for my half of the shield.`
      );
    } else if (stage >= STAGE_CERTIFICATE) {
      if (hasItem(player, CERTIFICATE_ID)) {
        lines.push("I have a completed certificate to show King Roald.");
      } else {
        lines.push("I need to exchange a certificate half with a member", "of the opposite gang, then combine the two halves.");
      }
    }
    return lines;
  }

  function reward(player) {
    player.getInventory().adds(COINS_ID, 600);
  }

  function selectDialogueVariant({ npcId, player }) {
    const stage = quest.getStage(player);

    if (RELDO_NPC_IDS.has(npcId)) {
      if (stage === STAGE_NOT_STARTED) {
        // The first-time and "otherwise" branches are sibling conditions in one
        // transcript; remember which one this talk is before they are resolved.
        reldoFirstTalk.set(player, !attr(player, RELDO_MET_ATTRIBUTE));
        player.setAttribute(RELDO_MET_ATTRIBUTE, true);
        return { page: PAGE, variant: "shared-starting-talking-to-reldo" };
      }
      if (stage === STAGE_STARTED) {
        return hasItem(player, BOOK_ID)
          ? { page: PAGE, variant: "shared-starting-talking-to-reldo-before-reading-the-book" }
          : { page: PAGE, variant: "shared-starting-talking-to-reldo-before-finding-the-book" };
      }
      if (stage === STAGE_READ_BOOK) {
        return { page: PAGE, variant: "shared-starting-talking-to-reldo-after-reading-the-book" };
      }
      return null;
    }

    if (BARAEK_NPC_IDS.has(npcId)) {
      if (stage === STAGE_READ_BOOK && !gangChosen(player)) {
        return { page: PAGE, variant: "phoenix-gang-talking-to-baraek" };
      }
      return null;
    }

    if (npcId === CHARLIE_NPC_ID) {
      if (isPhoenix(player) && stage >= STAGE_READ_BOOK) {
        return { page: PAGE, variant: "phoenix-gang-learning-the-location-of-the-black-arm-gang-from-charlie-the-tramp" };
      }
      // Before a gang is chosen Charlie must play his standard transcript: its
      // "Is there anything down this alleyway?" option is what picks Black Arm
      // (handleGangChoice). The Shield of Arrav Charlie branches below only
      // apply once the choice is made.
      if (stage === STAGE_GANG_TASK && isBlackArm(player)) {
        return { page: PAGE, variant: "black-arm-gang-talking-to-charlie-the-tramp-after-accepting-katrine-s-task" };
      }
      return null;
    }

    if (npcId === KATRINE_NPC_ID) {
      if (isPhoenix(player)) {
        return { page: PAGE, variant: "phoenix-gang-talking-to-katrine-after-joining-the-phoenix-gang" };
      }
      if (isBlackArm(player)) {
        if (stage === STAGE_READ_BOOK) {
          quest.setStage(player, STAGE_GANG_TASK);
          return { page: PAGE, variant: "black-arm-gang-talking-to-katrine" };
        }
        if (stage === STAGE_GANG_TASK) {
          return { page: PAGE, variant: "black-arm-gang-talking-to-katrine-again-after-accepting-her-task" };
        }
        if (stage >= STAGE_JOINED_GANG && stage < STAGE_COMPLETE) {
          return { page: PAGE, variant: "black-arm-gang-talking-to-katrine-after-joining-the-black-arm-gang" };
        }
        if (stage >= STAGE_COMPLETE) {
          return { page: PAGE, variant: "post-quest-talking-to-katrine-as-a-member-of-the-black-arm-gang" };
        }
      }
      return null;
    }

    if (npcId === STRAVEN_NPC_ID) {
      if (isBlackArm(player)) {
        return { page: PAGE, variant: "black-arm-gang-talking-to-straven-after-joining-the-black-arm-gang" };
      }
      if (isPhoenix(player)) {
        if (stage === STAGE_READ_BOOK) {
          quest.setStage(player, STAGE_GANG_TASK);
          ensureJonny(player);
          return { page: PAGE, variant: "phoenix-gang-talking-to-straven-or-attempting-to-open-the-door" };
        }
        if (stage === STAGE_GANG_TASK) {
          return { page: PAGE, variant: "phoenix-gang-talking-to-straven-or-opening-the-door-after-accepting-his-task" };
        }
        if (stage >= STAGE_JOINED_GANG && stage < STAGE_COMPLETE) {
          return hasItem(player, KEY_ID)
            ? { page: PAGE, variant: "phoenix-gang-talking-to-straven-after-joining-the-phoenix-gang" }
            : { page: PAGE, variant: "phoenix-gang-talking-to-straven-after-losing-the-weapon-store-key" };
        }
        if (stage >= STAGE_COMPLETE) {
          return hasItem(player, KEY_ID)
            ? { page: PAGE, variant: "post-quest-talking-to-straven-as-a-member-of-the-phoenix-gang" }
            : { page: PAGE, variant: "post-quest-if-you-lost-the-weapon-store-key" };
        }
      }
      return null;
    }

    if (WEAPONSMASTER_NPC_IDS.has(npcId)) {
      return isPhoenix(player)
        ? { page: PAGE, variant: "phoenix-gang-talking-to-the-weaponsmaster-after-joining-the-phoenix-gang" }
        : { page: PAGE, variant: "black-arm-gang-talking-to-the-weaponsmaster" };
    }

    if (npcId === CURATOR_NPC_ID) {
      const own = ownShieldAndCert(player);
      if (!own || stage < STAGE_JOINED_GANG || stage >= STAGE_COMPLETE) return null;
      if (stage === STAGE_JOINED_GANG && hasItem(player, own.shield)) {
        return { page: PAGE, variant: "finishing-up-talking-to-curator-haig-halen" };
      }
      if (stage === STAGE_CERTIFICATE && !hasItem(player, CERTIFICATE_ID) && !hasItem(player, own.half)) {
        return { page: PAGE, variant: "finishing-up-talking-to-the-curator-again-after-giving-him-the-shield-half" };
      }
      return null;
    }

    if (KING_ROALD_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_JOINED_GANG && stage < STAGE_COMPLETE && hasItem(player, CERTIFICATE_ID)) {
        return { page: PAGE, variant: "finishing-up-talking-to-king-roald-with-a-full-certificate" };
      }
      if (stage >= STAGE_JOINED_GANG && stage < STAGE_COMPLETE && (hasShieldHalf(player) || hasCertHalf(player))) {
        return { page: PAGE, variant: "finishing-up-talking-to-king-roald-without-a-full-certificate" };
      }
      return null;
    }

    return null;
  }

  function answerDialogueCondition({ npcId, player, text }) {
    const value = String(text).toLowerCase();

    if (RELDO_NPC_IDS.has(npcId)) {
      if (value.includes("combat level is less than 10")) return player.getSkillManager().getCombatLevel() < 10;
      if (value.includes("first time ever") || value.includes("otherwise")) {
        const first = reldoFirstTalk.has(player) ? reldoFirstTalk.get(player) : !attr(player, RELDO_MET_ATTRIBUTE);
        return value.includes("first time ever") ? first : !first;
      }
      return null;
    }

    if (BARAEK_NPC_IDS.has(npcId)) {
      if (value.includes("doesn't have 20 coins") || value.includes("does not have 20 coins")) return coins(player) < 20;
      if (value.includes("has 20 coins")) return coins(player) >= 20;
      return null;
    }

    if (npcId === CHARLIE_NPC_ID) {
      if (value.includes("combat level is less than 10")) return player.getSkillManager().getCombatLevel() < 10;
      if (value.includes("haven't yet paid charlie") || value.includes("hasn't yet paid charlie")) {
        return !attr(player, CHARLIE_PAID_ATTRIBUTE);
      }
      if (value.includes("already paying charlie")) return attr(player, CHARLIE_PAID_ATTRIBUTE) !== 0;
      if (value.includes("first time")) return true;
      if (value.includes("otherwise")) return true;
      return null;
    }

    if (npcId === KATRINE_NPC_ID) {
      const crossbows = player.getInventory().getAmount(CROSSBOW_ID);
      if (value.includes("no phoenix crossbows")) return crossbows < 1;
      if (value.includes("one phoenix crossbow")) return crossbows === 1;
      if (value.includes("two phoenix crossbows")) return crossbows >= 2;
      return null;
    }

    if (npcId === STRAVEN_NPC_ID) {
      const report = hasItem(player, REPORT_ID);
      if (value.includes("doesn't have the intel report") || value.includes("does not have the intel report")) return !report;
      if (value.includes("has the intel report")) return report;
      if (value.includes("intel report is in the bank")) return false;
      if (value.includes("intel report is in the inventory")) return report;
      return null;
    }

    if (KING_ROALD_NPC_IDS.has(npcId)) {
      if (value.includes("has a half-certificate")) return hasCertHalf(player);
      if (value.includes("has a shield half")) return hasShieldHalf(player);
      if (value.includes("has no certificate")) return !hasItem(player, CERTIFICATE_ID);
      return null;
    }

    return null;
  }

  function handleStartHook({ player, hook }) {
    if (hook !== START_HOOK) return;
    if (quest.getStage(player) >= STAGE_STARTED) return;
    quest.setStage(player, STAGE_STARTED);
  }

  function handleGangChoice({ player, npcId, option }) {
    if (npcId !== CHARLIE_NPC_ID || option !== CHARLIE_ALLEY_OPTION) return;
    if (quest.getStage(player) !== STAGE_READ_BOOK || gangChosen(player)) return;
    setGang(player, GANG_BLACKARM);
  }

  function handleDialogueAction(event) {
    const { player, npcId, stepId } = event;

    // The full-certificate transcript marks its final line "end" before the
    // "Congratulations! Quest complete!" action step. The runtime's end marker
    // closes the chain, so let that action run instead of swallowing it.
    if (
      KING_ROALD_NPC_IDS.has(npcId) &&
      event.step?.type === "end" &&
      quest.getStage(player) === STAGE_CERTIFICATE &&
      hasItem(player, CERTIFICATE_ID)
    ) {
      event.handled = true;
      event.end = false;
      return;
    }

    if (!stepId) return;

    if (BARAEK_NPC_IDS.has(npcId) && BARAEK_PAY_ACTIONS.has(stepId)) {
      if (coins(player) < 20) return;
      player.getInventory().deleteNumber(COINS_ID, 20);
      setGang(player, GANG_PHOENIX);
      player.setAttribute(PHOENIX_LOCATION_ATTRIBUTE, true);
      player.sendMessage("Baraek directs you to an alley near Varrock's south gate.");
      event.handled = true;
      return;
    }

    if (npcId === CHARLIE_NPC_ID && (CHARLIE_TEN_COIN_MESSAGES.has(stepId) || CHARLIE_FIVE_COIN_MESSAGES.has(stepId))) {
      const cost = CHARLIE_TEN_COIN_MESSAGES.has(stepId) ? 10 : 5;
      if (coins(player) < cost) return;
      player.getInventory().deleteNumber(COINS_ID, cost);
      player.setAttribute(CHARLIE_PAID_ATTRIBUTE, true);
      return; // leave the message to the runtime
    }

    if (npcId === STRAVEN_NPC_ID) {
      if (stepId === STRAVEN_KEY_MESSAGE || STRAVEN_HANDIN_ACTIONS.has(stepId)) {
        handInReport(player, quest);
        if (STRAVEN_HANDIN_ACTIONS.has(stepId)) event.handled = true;
        return;
      }
      if (STRAVEN_LOST_KEY_MESSAGES.has(stepId)) {
        giveItem(player, KEY_ID);
        return;
      }
    }

    if (npcId === KATRINE_NPC_ID && (stepId === KATRINE_HANDIN_MESSAGE || stepId === KATRINE_HANDIN_ACTION)) {
      handInCrossbows(player, quest);
      if (stepId === KATRINE_HANDIN_ACTION) event.handled = true;
      return;
    }

    if (npcId === CURATOR_NPC_ID) {
      // A message step emits the generic action first, then the message itself;
      // act once so the transcript line still shows and nothing is granted twice.
      const isMessageStep = event.kind === "message";
      if (stepId === CURATOR_CERT_MESSAGE) {
        if (isMessageStep) return;
        if (!handInShieldHalf(player, quest)) event.handled = true;
        return;
      }
      if (stepId === CURATOR_REPLACE_MESSAGE) {
        if (isMessageStep) return;
        const own = ownShieldAndCert(player);
        if (!own || quest.getStage(player) !== STAGE_CERTIFICATE || hasItem(player, own.half)) {
          event.handled = true;
          return;
        }
        if (!giveItems(player, own.half, 2)) event.handled = true;
        return;
      }
    }

    if (KING_ROALD_NPC_IDS.has(npcId) && KING_COMPLETE_ACTIONS.has(stepId)) {
      if (!hasItem(player, CERTIFICATE_ID)) return;
      player.getInventory().deleteNumber(CERTIFICATE_ID, 1);
      quest.complete(player);
      event.handled = true;
      event.end = true;
    }
  }

  /**
   * The curator is not indexed to the Shield of Arrav page, so his own Talk-to
   * would play The Dig Site. While the player is on the shield half-in, replay
   * the curator's Shield of Arrav variant instead; the action steps then reach
   * the hand-in above with the real curator id and chathead.
   */
  function handleNpcInteraction(event) {
    if (event.npcId !== CURATOR_NPC_ID) return;
    const action = String(event.definition?.getActions?.()?.[event.clickType - 1] ?? "");
    if (action.toLowerCase() !== "talk-to") return;

    const { player } = event;
    const stage = quest.getStage(player);
    const own = ownShieldAndCert(player);
    if (!own || stage < STAGE_JOINED_GANG || stage >= STAGE_COMPLETE) return;

    if (stage === STAGE_JOINED_GANG && hasItem(player, own.shield)) {
      event.handled = true;
      startTranscript(api, player, CURATOR_NPC_ID, PAGE, CURATOR_SHIELD_VARIANT);
      return;
    }
    if (stage === STAGE_CERTIFICATE && !hasItem(player, CERTIFICATE_ID) && !hasItem(player, own.half)) {
      event.handled = true;
      startTranscript(api, player, CURATOR_NPC_ID, PAGE, CURATOR_REPLACE_VARIANT);
    }
  }

  /** Fill the wiki transcript's "[player name]" blanks in Reldo's lines. */
  function fillReldoPlayerName(request) {
    if (!request?.player || typeof request.text !== "string") return;
    if (!RELDO_NPC_IDS.has(request.npcId)) return;
    if (!request.text.includes("[player name]")) return;
    request.text = request.text.replace(/\[player name\]/gi, request.player.getUsername());
  }

  function handleLogin({ player }) {
    ensureJonny(player);
  }

  function handleLogout({ player }) {
    if (player) removeJonny(player);
  }

  function readBook(event) {
    if (event.itemId !== BOOK_ID) return;
    const option = String(event.option ?? "").toLowerCase();
    if (!option.includes("read")) return;
    event.player.sendMessage("The book tells how the Phoenix Gang stole Arrav's shield and later split in two.");
    if (quest.getStage(event.player) === STAGE_STARTED) {
      quest.setStage(event.player, STAGE_READ_BOOK);
    }
    event.handled = true;
  }

  function combineCertificateHalves(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const pair = new Set([usedItemId, usedWithItemId]);
    if (!pair.has(PHOENIX_CERT_ID) || !pair.has(BLACKARM_CERT_ID)) return;
    if (quest.getStage(player) !== STAGE_CERTIFICATE) return;
    if (!hasItem(player, PHOENIX_CERT_ID) || !hasItem(player, BLACKARM_CERT_ID)) return;
    if (player.getInventory().isFull()) {
      player.sendMessage("You need a free inventory space.");
      return;
    }
    player.getInventory().deleteNumber(PHOENIX_CERT_ID, 1);
    player.getInventory().deleteNumber(BLACKARM_CERT_ID, 1);
    player.getInventory().adds(CERTIFICATE_ID, 1);
    player.sendMessage("You fit the two certificate halves together.");
    event.handled = true;
  }

  function handReportToStraven(event) {
    if (event.itemId !== REPORT_ID) return;
    if ((event.npcId ?? event.target?.getId?.()) !== STRAVEN_NPC_ID) return;
    if (handInReport(event.player, quest)) event.handled = true;
  }

  function useKeyOnDoor(event) {
    if (event.itemId !== KEY_ID || event.objectId !== WEAPON_STORE_DOOR_ID) return;
    if (!hasItem(event.player, KEY_ID)) return;
    crossDoor(event.player, "x", WEAPON_STORE_DOOR_X);
    event.handled = true;
  }

  // Tradeable quest items: using a certificate half on another player swaps it
  // for their opposite half; the weapon store key can just be handed over.
  function handleItemOnPlayer(event) {
    const { player, target, itemId } = event;
    if (!target?.getInventory) return;
    if (itemId === KEY_ID) {
      if (!hasItem(player, KEY_ID)) return;
      if (target.getInventory().isFull()) {
        player.sendMessage("That player has no inventory space.");
        event.handled = true;
        return;
      }
      player.getInventory().deleteNumber(KEY_ID, 1);
      target.getInventory().adds(KEY_ID, 1);
      player.sendMessage(`You give the weapon store key to ${target.getUsername?.() ?? "the other player"}.`);
      event.handled = true;
      return;
    }
    if (itemId !== PHOENIX_CERT_ID && itemId !== BLACKARM_CERT_ID) return;
    const opposite = itemId === PHOENIX_CERT_ID ? BLACKARM_CERT_ID : PHOENIX_CERT_ID;
    if (quest.getStage(player) !== STAGE_CERTIFICATE || quest.getStage(target) !== STAGE_CERTIFICATE) return;
    if (!hasItem(player, itemId) || !hasItem(target, opposite)) {
      player.sendMessage("That player does not have the opposite certificate half.");
      return;
    }
    if (player.getInventory().isFull() || target.getInventory().isFull()) {
      player.sendMessage("Both players need a free inventory space.");
      return;
    }
    player.getInventory().deleteNumber(itemId, 1);
    target.getInventory().deleteNumber(opposite, 1);
    player.getInventory().adds(opposite, 1);
    target.getInventory().adds(itemId, 1);
    player.sendMessage(`You exchange certificate halves with ${target.getUsername?.() ?? "the other player"}.`);
    target.sendMessage?.(`You exchange certificate halves with ${player.getUsername?.() ?? "the other player"}.`);
    event.handled = true;
  }

  function handleObjectInteraction(event) {
    const option = String(event.definition?.getInteractions?.()?.[event.clickType - 1] ?? "").toLowerCase();
    const { player, objectId } = event;

    if (objectId === BOOKCASE_ID && option.includes("search")) {
      searchBookcase(player, quest);
      event.handled = true;
      return;
    }
    if (objectId === PHOENIX_CHEST_ID && (option.includes("open") || option.includes("search"))) {
      searchShieldCache(player, quest, true);
      event.handled = true;
      return;
    }
    if (objectId === BLACKARM_CUPBOARD_ID && (option.includes("open") || option.includes("search"))) {
      searchShieldCache(player, quest, false);
      event.handled = true;
      return;
    }
    if (objectId === WEAPON_STORE_DOOR_ID && option.includes("open")) {
      if (!hasItem(player, KEY_ID)) {
        player.sendMessage("The door is securely locked.");
      } else {
        crossDoor(player, "x", WEAPON_STORE_DOOR_X);
      }
      event.handled = true;
      return;
    }
    if (objectId === BLACKARM_DOOR_ID && option.includes("open")) {
      if (!isBlackArm(player) || quest.getStage(player) < STAGE_JOINED_GANG) {
        player.sendMessage("This door is locked from the inside.");
      } else {
        crossDoor(player, "x", BLACKARM_DOOR_X);
      }
      event.handled = true;
      return;
    }
    if (objectId === PHOENIX_HIDEOUT_DOOR_ID && option.includes("open")) {
      if (!isPhoenix(player) || quest.getStage(player) < STAGE_JOINED_GANG) {
        player.sendMessage("Only Phoenix Gang members may pass.");
      } else {
        crossDoor(player, "y", PHOENIX_HIDEOUT_DOOR_Y);
      }
      event.handled = true;
    }
  }

  function handleNpcDeath({ killer, npc, npcId }) {
    if (!killer || !npc || !groundItems) return;
    const location = npc.getLocation?.() ?? npc.getSpawnLocation?.();
    if (!location) return;

    if (JONNY_NPC_IDS.has(npcId)) {
      if (jonnyByPlayer.get(killer) === npc) {
        jonnyByPlayer.delete(killer);
        ensureJonny(killer);
      }
      if (!isPhoenix(killer) || quest.getStage(killer) !== STAGE_GANG_TASK) return;
      if (hasItem(killer, REPORT_ID)) return;
      groundItems.registerLocation(killer, new Item(REPORT_ID, 1), location);
      return;
    }
    if (WEAPONSMASTER_NPC_IDS.has(npcId)) {
      groundItems.registerLocation(killer, new Item(CROSSBOW_ID, 1), location);
      groundItems.registerLocation(killer, new Item(CROSSBOW_ID, 1), location);
    }
  }

  function searchBookcase(player, questHandle) {
    if (questHandle.getStage(player) !== STAGE_STARTED) {
      player.sendMessage("A large collection of books.");
      return;
    }
    if (hasItem(player, BOOK_ID)) {
      player.sendMessage("You already have The Shield of Arrav.");
      return;
    }
    giveItem(player, BOOK_ID, "You take The Shield of Arrav from the bookcase.");
  }

  function searchShieldCache(player, questHandle, phoenix) {
    if (questHandle.getStage(player) !== STAGE_JOINED_GANG || isPhoenix(player) !== phoenix) {
      player.sendMessage("You find nothing of interest.");
      return;
    }
    const itemId = phoenix ? PHOENIX_HALF_ID : BLACKARM_HALF_ID;
    if (hasItem(player, itemId)) {
      player.sendMessage("You already have this half of the Shield of Arrav.");
      return;
    }
    giveItem(player, itemId, "You find half of the Shield of Arrav.");
  }

  function crossDoor(player, axis, coordinate) {
    const location = player.getLocation();
    if (axis === "x") {
      player.moveTo(
        new Location(location.getX() >= coordinate ? coordinate - 1 : coordinate + 1, location.getY(), location.getZ())
      );
    } else {
      player.moveTo(
        new Location(location.getX(), location.getY() >= coordinate ? coordinate - 1 : coordinate + 1, location.getZ())
      );
    }
  }

  quest = registerQuest(api, {
    key: "shield_of_arrav",
    name: "Shield of Arrav",
    varpId: VARP_SHIELD_OF_ARRAV,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [],
    scrollItemId: CERTIFICATE_ID,
    rewardItemLabel: "600 Coins",
    buildJournal,
    onReward: reward,
  });

  api.persistAttribute(GANG_ATTRIBUTE);
  api.persistAttribute(PHOENIX_LOCATION_ATTRIBUTE);
  api.persistAttribute(CHARLIE_PAID_ATTRIBUTE);
  api.persistAttribute(RELDO_MET_ATTRIBUTE);

  groundItems = api.getItemOnGroundManager();

  api.onNpcDialogueVariant(selectDialogueVariant);
  api.onNpcDialogueCondition(answerDialogueCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleGangChoice);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onCustomEvent("npc-dialogue:line", fillReldoPlayerName);
  api.onNpcInteraction(handleNpcInteraction);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
  api.onItemAction(readBook);
  api.onItemOnItem(combineCertificateHalves);
  api.onItemOnNpc(handReportToStraven);
  api.onItemOnObject(useKeyOnDoor);
  api.onItemOnPlayer(handleItemOnPlayer);
  api.onObjectInteraction(handleObjectInteraction);
  api.onNpcDeath(handleNpcDeath);
  /**
   * Gaps (not selectable / not covered by the dump):
   *  - Curator Haig Halen (5214) is indexed but the index does not list the
   *    "Shield of Arrav" page against it; handleNpcInteraction replays the page
   *    through startTranscript so the hand-in is reachable without a data fix.
   *  - Reference ids 6203 (Reldo) and 5211 (Weaponsmaster) are not in the index;
   *    the indexed cache ids 4242/4243 and 14137 are handled instead, so the
   *    spawned ids must be the indexed ones for the overrides to apply.
   *  - The modern page's bookcase search ("shared-starting-searching-the-right-
   *    bookcase") and the "attempting to take a phoenix crossbow" variants are
   *    object/dispenser interactions the object runtime cannot play; the bookcase
   *    is implemented as a plain object search, the crossbow theft is skipped.
   *  - The Weaponsmaster "starts attacking" action and the phoenix door
   *    auto-open message are not modelled (no combat trigger / spawn control).
   *  - stage 5 (RECOVERED_SHIELD) from the reference is never set; the shield
   *    half is checked by inventory, matching the reference.
   */
};
