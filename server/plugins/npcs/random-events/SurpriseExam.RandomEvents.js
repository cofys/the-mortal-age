"use strict";

// Surprise Exam (random event, Dunce / Mr. Mordaut): answer three questions, mixing "what
// comes next" patterns (cache interface 103) with "find three related cards" sets (cache
// interface 559). Three wrong answers fail; passing and leaving through a door awards a Book
// of Knowledge. See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const NEXT_GROUP = 103;
const CARDS_GROUP = 559;
const NEXT_MODELS = { SEQUENCE: [6, 7, 8], CHOICES: [15, 17, 19, 21] };
const CARDS = { MODELS: Array.from({ length: 15 }, (_, i) => 21 + i), SELECTS: Array.from({ length: 15 }, (_, i) => 52 + i),
  HINT: 67, CONFIRM: 68 };
const DOORS = [9316, 9317, 9318, 9319];
const QUESTIONS = 3;
const WRONG_ALLOWED = 3;
const BOOK = 11640;
const FALLBACK = [[995, 20], [995, 40], [995, 80], [995, 160], [995, 320], [995, 640],
  [563, 1], [1623, 1], [1621, 1], [1619, 1], [1617, 1], [985, 1], [987, 1]];

// Themed pools: [id, tier order]. The pattern questions walk one pool.
const THEMES = {
  axes: [1351, 1349, 1353, 1361, 1355, 1357, 1359, 6739],
  food: [2309, 1973, 1891, 1971, 1965, 1957, 1982, 1944, 1963],
  tools: [952, 5343, 5329, 5341, 2347, 1755, 5331, 1925],
  runes: [556, 555, 557, 554, 558, 562, 561, 560, 563],
  ores: [436, 438, 440, 442, 444, 447, 449, 451],
  gems: [1623, 1621, 1619, 1617, 1607, 1605, 1603, 1601],
};
const THEME_NAMES = Object.keys(THEMES);

function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

module.exports = function attach(api, Events) {
  const N = api.core.NpcIdentifiers;

  const definition = {
    id: N.DUNCE_2,
    kind: "exam",
    greeting: "Surprise exam,",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: definition.id,
        lines: [`Hey, ${player.getUsername()}, the teacher wants you to come to school for a test.`],
        options: [
          ["Sure, I fancy an exam.", () => teleport({
            kind: "exam",
            arrive: { x: 1887, y: 5029, z: 0 },
            teleportRefusal: "Use the doors if you want to leave the exam!",
            onStart: start,
          })],
          ["I don't want to.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    session.data.correct = 0;
    session.data.wrong = 0;
    session.data.passed = false;
    Flow.chat(api, {
      player: session.player,
      npcId: N.MR_MORDAUT,
      lines: [`Ah, it's you ${session.player.getUsername()}. You've been slacking in your studies, so it's time for an exam.`,
        "Answer three questions correctly and you shall be rewarded."],
    });
    question(session);
  }

  function question(session) {
    const cards = Math.random() < 0.5;
    session.data.pattern = makePattern();
    if (cards) openCards(session);
    else openNext(session);
  }

  function makePattern() {
    const theme = THEME_NAMES[Math.floor(Math.random() * THEME_NAMES.length)];
    const pool = THEMES[theme];
    const start = Math.floor(Math.random() * Math.max(1, pool.length - 3));
    const sequence = pool.slice(start, start + 3);
    const answer = pool[start + 3] ?? pool[start];
    const distractors = shuffled(pool.filter(item => item !== answer)).slice(0, 3);
    return { theme, sequence, answer, choices: shuffled([answer, ...distractors]) };
  }

  function openNext(session) {
    const { player } = session;
    const pattern = session.data.pattern;
    session.interfaceId = NEXT_GROUP;
    const sender = player.getPacketSender();
    sender.sendInterface(NEXT_GROUP);
    pattern.sequence.forEach((item, index) =>
      sender.sendItemOnInterfaces((NEXT_GROUP << 16) | NEXT_MODELS.SEQUENCE[index], item, 1));
    pattern.choices.forEach((item, index) =>
      sender.sendItemOnInterfaces((NEXT_GROUP << 16) | NEXT_MODELS.CHOICES[index], item, 1));
    for (const component of NEXT_MODELS.CHOICES) {
      sender.sendInterfaceFlagsRange((NEXT_GROUP << 16) | component, -1, -1, 1 << 1);
    }
  }

  function chooseNext(event) {
    const { player, buttonId } = event;
    if ((buttonId >>> 16) !== NEXT_GROUP) return;
    const index = NEXT_MODELS.CHOICES.indexOf(buttonId & 0xffff);
    if (index < 0) return;
    event.handled = true;
    const session = Teleports.sessionOf(player);
    if (event.action !== 1 || !session || session.kind !== "exam" || !session.data.pattern) return;
    if (player.getInterfaceId?.() === NEXT_GROUP) player.getPacketSender().sendInterfaceRemoval();
    answer(session, session.data.pattern.choices[index] === session.data.pattern.answer);
  }

  function openCards(session) {
    const { player } = session;
    const theme = THEME_NAMES[Math.floor(Math.random() * THEME_NAMES.length)];
    const pool = THEMES[theme];
    const related = shuffled(pool).slice(0, 3);
    const others = shuffled(Object.values(THEMES).flat().filter(item => !related.includes(item))).slice(0, 12);
    const cards = shuffled([...related, ...others]);
    session.data.cards = { related, cards, selected: [] };
    session.interfaceId = CARDS_GROUP;
    const sender = player.getPacketSender();
    sender.sendInterface(CARDS_GROUP);
    cards.forEach((item, index) => sender.sendItemOnInterfaces((CARDS_GROUP << 16) | CARDS.MODELS[index], item, 1));
    sender.sendString("Pick the three cards that fit this theme.", (CARDS_GROUP << 16) | CARDS.HINT);
    for (const component of CARDS.SELECTS) {
      sender.sendInterfaceFlagsRange((CARDS_GROUP << 16) | component, -1, -1, 1 << 1);
    }
    sender.sendInterfaceFlagsRange((CARDS_GROUP << 16) | CARDS.CONFIRM, -1, -1, 1 << 1);
  }

  function chooseCard(event) {
    const { player, buttonId } = event;
    if ((buttonId >>> 16) !== CARDS_GROUP) return;
    const child = buttonId & 0xffff;
    const select = CARDS.SELECTS.indexOf(child);
    const confirm = child === CARDS.CONFIRM;
    if (select < 0 && !confirm) return;
    event.handled = true;
    const session = Teleports.sessionOf(player);
    if (event.action !== 1 || !session || session.kind !== "exam" || !session.data.cards) return;
    const state = session.data.cards;
    if (select >= 0) {
      const index = state.selected.indexOf(select);
      if (index >= 0) state.selected.splice(index, 1);
      else if (state.selected.length < 3) state.selected.push(select);
      return;
    }
    if (state.selected.length !== 3) {
      player.sendMessage("Select three cards first.");
      return;
    }
    const chosen = state.selected.map(index => state.cards[index]);
    const right = chosen.every(item => state.related.includes(item));
    if (player.getInterfaceId?.() === CARDS_GROUP) player.getPacketSender().sendInterfaceRemoval();
    answer(session, right);
  }

  const PRAISE = ["Wonderful! Keep up the good work. Next question.",
    "Finally, a pupil using their brains rather than trying to eat them. Next question.",
    "That's correct! Next question."];
  const SCOLD = ["No. No, that's not right at all. Okay, next question.",
    "That's WRONG. Take your time and think about the next question.",
    "No, no, no... That's WRONG! Okay, next question."];

  function answer(session, correct) {
    const player = session.player;
    if (correct) {
      session.data.correct++;
      if (session.data.correct >= QUESTIONS) {
        session.data.passed = true;
        Flow.chat(api, { player, npcId: N.MR_MORDAUT,
          lines: ["WELL DONE! You've proven your aptitude for pattern recognition.",
            "You'll receive a book once you leave the classroom. To exit, use any of the doors in this room."] });
        return;
      }
      player.sendMessage(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
      question(session);
      return;
    }
    session.data.wrong++;
    if (session.data.wrong >= WRONG_ALLOWED) {
      Flow.chat(api, { player, npcId: N.MR_MORDAUT,
        lines: ["How unfortunate, you FAILED. You'd better hit the books and study up for next time.",
          "To exit, use any of the doors in this room."] });
      return;
    }
    player.sendMessage(SCOLD[Math.floor(Math.random() * SCOLD.length)]);
    question(session);
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));
  api.onInterfaceActionClick(chooseNext);
  api.onInterfaceActionClick(chooseCard);
  api.onObjectInteraction("Door", { Open: leave });
  api.onObjectInteraction("Door", { Walk: leave });

  function leave(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "exam") return false;
    if (!DOORS.includes(event.object.getId?.())) return false;
    event.handled = true;
    if (session.data.passed) reward(session);
    else Teleports.finish(session, { message: "You leave the classroom." });
    return true;
  }

  function reward(session) {
    const player = session.player;
    if (!Teleports.owns(player, BOOK)) {
      Teleports.finish(session, { reward: [{ id: BOOK, amount: 1 }],
        message: "Mr. Mordaut gives you a Book of Knowledge." });
      return;
    }
    const [item, amount] = FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
    player.sendMessage("You already own a Book of Knowledge, so you receive something else.");
    Teleports.finish(session, { reward: [{ id: item, amount }] });
  }
};
