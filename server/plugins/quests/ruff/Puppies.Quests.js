"use strict";

// The post-quest shelter capture: native adoption, puppy interactions and release.
const ADOPTION_GROUP = 227;
const BREED_ENUM = 5845;
const VARP = { BREED: 5732, COLOUR: 5733, UNLOCKS: 5734 };
const COMPONENT = { BREEDS: 7, COLOURS: 21, CONFIRM: 24 };
const COLUMN = { NAME: 0, MODELS: 1, FREE: 7, UNLOCK: 8 };
const DEFAULT_BREED = 5; // Labrador in enum 5845.
const PRICE = 200;
const OBJECTBOX = 193;
const OBJECTBOX_BUTTON = OBJECTBOX << 16;
const OP1 = 1 << 1;
const uid = child => (ADOPTION_GROUP << 16) | child;

module.exports = function attach(api, quest) {
  const { Animation, DialogueChainBuilder, PlayerDialogue, NpcDialogue, ItemStatementDialogue,
    ActionDialogue, EndDialogue, Task, TaskManager, CacheDefinitions, NpcIdentifiers, ItemIdentifiers } = api.core;
  const choices = new WeakMap();
  const questions = new WeakMap();
  const generations = new WeakMap();
  let breeds = null;

  function later(player, ticks, action) {
    const generation = generations.get(player);
    TaskManager.submit(new class extends Task {
      constructor() { super(ticks, player); }
      execute() {
        this.stop();
        if (generations.get(player) === generation) action();
      }
    }());
  }

  function talk(player, entries, then) {
    const chain = new DialogueChainBuilder();
    for (const [index, entry] of entries.entries()) {
      if (entry.player) chain.add(new PlayerDialogue(index, entry.player, entry.mood ?? 588));
      else if (entry.npc) chain.add(new NpcDialogue(index, entry.npc, entry.text, undefined, entry.mood ?? 588));
      else chain.add(new ItemStatementDialogue(index, entry.item, entry.text));
    }
    if (then) chain.add(new ActionDialogue(entries.length, { execute() { player.getDialogueManager().reset(); then(); } }));
    else chain.add(new EndDialogue(entries.length));
    player.getDialogueManager().startDialogues(chain);
  }

  function ask(player, pet, text, yes) {
    const box = new class extends ItemStatementDialogue {
      send(target) {
        super.send(target);
        target.getPacketSender().sendClientScript(2868, "No.|Yes.");
      }
    }(0, pet.itemId, text);
    questions.set(player, { box, yes });
    const chain = new DialogueChainBuilder();
    chain.add(box);
    player.getDialogueManager().startDialogues(chain);
  }

  function answerQuestion(event) {
    const { player, action } = event;
    const question = questions.get(player);
    if (!question || player.getDialogueManager().getCurrent() !== question.box
        || !player.getPacketSender().isChatboxInterface(OBJECTBOX)) return false;
    if (action !== 0 && action !== 1) return false;
    event.handled = true;
    questions.delete(player);
    player.getDialogueManager().reset();
    player.getPacketSender().sendInterfaceRemoval();
    if (action === 1) question.yes();
    return true;
  }

  function allBreeds() {
    if (breeds) return breeds;
    const request = { pets: [] };
    api.emitCustomEvent("pets:definitions", request);
    const puppies = request.pets.filter(pet => pet.puppy);
    breeds = new Map([...CacheDefinitions.getEnumValues(BREED_ENUM)].map(([index, rowId]) => {
      const row = CacheDefinitions.getDbRow(Number(rowId));
      const pets = row.column(COLUMN.MODELS).map(model => puppies.find(pet =>
        CacheDefinitions.getNpc(pet.petId).modelIds?.includes(model)));
      return [Number(index), { row, pets }];
    }));
    return breeds;
  }

  function unlocked(player, breed) {
    return breed.row.int(COLUMN.FREE) === 1
      || ((player.getPacketSender().getVarp(VARP.UNLOCKS) >>> breed.row.int(COLUMN.UNLOCK)) & 1) !== 0;
  }

  function openAdoption(player) {
    choices.set(player, { breed: DEFAULT_BREED, colour: 0 });
    player.getPacketSender().sendConfig(VARP.BREED, DEFAULT_BREED).sendConfig(VARP.COLOUR, 0)
      .sendClientScript(2524, -1, -2).sendInterface(ADOPTION_GROUP)
      .sendInterfaceFlagsRange(uid(COMPONENT.BREEDS), 0, 60, OP1)
      .sendInterfaceFlagsRange(uid(COMPONENT.COLOURS), 0, 24, OP1)
      .sendInterfaceFlagsRange(uid(COMPONENT.CONFIRM), 0, 10, OP1)
      .closeInterface(player.getPacketSender().getChatboxGroupId());
  }

  function talkChase(event) {
    if (!quest.isComplete(event.player)) return false;
    talk(event.player, [
      { player: "Hello there, Chase. Could I adopt a puppy?" },
      { npc: NpcIdentifiers.CHASE, text: "If you want to." },
    ], () => later(event.player, 1, () => openAdoption(event.player)));
    return true;
  }

  function selectPuppy(event) {
    const { player, buttonId, slot, opId, action } = event;
    if (player.getInterfaceId() !== ADOPTION_GROUP || !quest.isComplete(player)
        || !choices.has(player) || (opId ?? action) !== 1 || !Number.isInteger(slot)) return false;
    const selection = choices.get(player);
    if (buttonId === uid(COMPONENT.BREEDS)) {
      if (slot % 5 !== 0 || !allBreeds().has(slot / 5)) return false;
      selection.breed = slot / 5;
      selection.colour = 0;
      player.getPacketSender().sendConfig(VARP.BREED, selection.breed).sendConfig(VARP.COLOUR, 0);
    } else if (buttonId === uid(COMPONENT.COLOURS)) {
      const breed = allBreeds().get(selection.breed);
      if (slot % 2 !== 0 || !breed?.pets[slot / 2]) return false;
      selection.colour = slot / 2;
      player.getPacketSender().sendConfig(VARP.COLOUR, selection.colour);
    } else {
      const breed = allBreeds().get(selection.breed);
      const pet = breed?.pets[selection.colour];
      if (slot !== 9 || !pet || !unlocked(player, breed)) return false;
      player.getPacketSender().sendClientScript(2524, -1, -1).sendInterfaceRemoval();
      talk(player, [{ npc: NpcIdentifiers.CHASE, text: "That'll be 200 coins." }], () => {
        ask(player, pet, "Pay 200 Coins?", () => adopt(player, pet));
      });
    }
    event.handled = true;
    return true;
  }

  function adopt(player, pet) {
    if (!quest.isComplete(player)) return;
    const inventory = player.getInventory();
    if (inventory.getAmount(ItemIdentifiers.COINS) < PRICE) {
      player.sendMessage("You don't have enough coins.");
      return;
    }
    if (inventory.isFull() && inventory.getAmount(ItemIdentifiers.COINS) !== PRICE) {
      player.sendMessage("You don't have enough inventory space.");
      return;
    }
    inventory.deleteNumber(ItemIdentifiers.COINS, PRICE);
    inventory.adds(pet.itemId, 1);
    const name = CacheDefinitions.getNpc(pet.petId).name;
    talk(player, [{ item: pet.itemId, text: `Chase hands you the ${name}.` }]);
  }

  function current(player, npc) {
    const request = { player, pet: null };
    api.emitCustomEvent("pets:current", request);
    return request.pet === npc && npc.getOwner() === player;
  }

  function petPuppy(player, npc, fromMenu = false) {
    const stroke = () => {
      if (!current(player, npc)) return;
      player.getPacketSender().sendInterfaceRemoval();
      player.setPositionToFace(npc.getLocation());
      player.performAnimation(new Animation(827));
      later(player, 1, () => {
        if (current(player, npc)) player.getPacketSender().sendSoundEffect(652, 1, 0).sendSoundEffect(12122, 1, 0);
      });
    };
    if (fromMenu) later(player, 1, stroke);
    else stroke();
  }

  function guessAge(player, npc, pet) {
    if (!current(player, npc)) return;
    talk(player, [{ player: "I wonder how old you are...", mood: 554 }], () => later(player, 1, () => {
      if (!current(player, npc)) return;
      // shortcut: only age zero is captured; feeding and adulthood need a growth recording.
      talk(player, [{ item: pet.itemId, text: "After taking a good look at your puppy, you estimate<br>their age is <col=ef1020>0 minutes</col>. They will grow into a dog in <col=ef1020>3<br><col=ef1020>hours  00 minutes</col>, assuming you keep feeding them." }]);
    }));
  }

  function releasePuppy(player, npc, pet) {
    if (!current(player, npc)) return;
    ask(player, pet, "Are you sure you want to release your puppy?", () => {
      if (!current(player, npc)) return;
      talk(player, [{ player: "I'm sorry buddy, but we need to part ways.", mood: 610 }], () => later(player, 1, () => {
        if (!current(player, npc)) return;
        talk(player, [
        { npc: pet.petId, text: "Arf?", mood: 610 },
        { player: "You can make your way back to the shelter, right?", mood: 610 },
      ], () => {
        player.getPacketSender().sendInterfaceRemoval();
        later(player, 1, () => {
          const request = { player, npc, released: false };
          api.emitCustomEvent("pets:release", request);
          if (request.released) {
            player.sendMessage("Your puppy has run away.");
            player.getPacketSender().sendSoundEffect(652, 1, 0);
          }
        });
        });
      }));
    });
  }

  function interactPuppy(event) {
    const { player, npc, pet, action } = event;
    if (!pet.puppy || !current(player, npc)) return;
    event.handled = true;
    if (action === "Pet") return petPuppy(player, npc);
    api.sendMultiChatboxPrompt(player, "Interact with puppy",
      "Pet.", () => petPuppy(player, npc, true),
      "Guess age.", () => guessAge(player, npc, pet),
      "Release.", () => releasePuppy(player, npc, pet));
  }

  function closeAdoption({ player, interfaceId }) {
    if (interfaceId === ADOPTION_GROUP) choices.delete(player);
  }

  function logout({ player }) {
    choices.delete(player);
    questions.delete(player);
    generations.set(player, (generations.get(player) ?? 0) + 1);
  }

  api.onInterfaceActionButton([uid(COMPONENT.BREEDS), uid(COMPONENT.COLOURS), uid(COMPONENT.CONFIRM)], selectPuppy);
  api.onInterfaceActionButton(OBJECTBOX_BUTTON, answerQuestion);
  api.onCustomEvent("pets:interact", interactPuppy);
  api.onCustomEvent("interface:closed", closeAdoption);
  api.onPlayerLogout(logout);
  api.onPlayerDisconnect(logout);
  return { talkChase };
};
