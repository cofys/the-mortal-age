/*
 * Copyright (c) 2019 Abex
 * All rights reserved.
 *
 * Ported to TypeScript. Generated from runelite-api/src/main/java/net/runelite/api/Quest.java
 * at RuneLite ${commit}.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
import type { Client } from "./Client";
import { QuestState } from "./QuestState";

/** RuneLite's ScriptID.QUEST_STATUS_GET: the cache script the quest list colours its names by. */
export const QUEST_STATUS_GET = 4029;

/** RuneLite's `net.runelite.api.Quest`: every quest and miniquest, with its quest list id. */
export class Quest {
    private static readonly all: Quest[] = [];

    static readonly ANIMAL_MAGNETISM = new Quest(0, "Animal Magnetism");
    static readonly ANOTHER_SLICE_OF_HAM = new Quest(1, "Another Slice of H.A.M.");
    static readonly THE_ASCENT_OF_ARCEUUS = new Quest(3, "The Ascent of Arceuus");
    static readonly ALFRED_GRIMHANDS_BARCRAWL = new Quest(4, "Alfred Grimhand's Barcrawl");
    static readonly BEAR_YOUR_SOUL = new Quest(5, "Bear Your Soul");
    static readonly BELOW_ICE_MOUNTAIN = new Quest(6, "Below Ice Mountain");
    static readonly BETWEEN_A_ROCK = new Quest(7, "Between a Rock...");
    static readonly BIG_CHOMPY_BIRD_HUNTING = new Quest(8, "Big Chompy Bird Hunting");
    static readonly BIOHAZARD = new Quest(9, "Biohazard");
    static readonly BLACK_KNIGHTS_FORTRESS = new Quest(10, "Black Knights' Fortress");
    static readonly BONE_VOYAGE = new Quest(11, "Bone Voyage");
    static readonly CABIN_FEVER = new Quest(12, "Cabin Fever");
    static readonly CLIENT_OF_KOUREND = new Quest(13, "Client of Kourend");
    static readonly CLOCK_TOWER = new Quest(14, "Clock Tower");
    static readonly COLD_WAR = new Quest(15, "Cold War");
    static readonly CONTACT = new Quest(16, "Contact!");
    static readonly COOKS_ASSISTANT = new Quest(17, "Cook's Assistant");
    static readonly THE_CORSAIR_CURSE = new Quest(18, "The Corsair Curse");
    static readonly CREATURE_OF_FENKENSTRAIN = new Quest(19, "Creature of Fenkenstrain");
    static readonly CURSE_OF_THE_EMPTY_LORD = new Quest(20, "Curse of the Empty Lord");
    static readonly DADDYS_HOME = new Quest(21, "Daddy's Home");
    static readonly DARKNESS_OF_HALLOWVALE = new Quest(22, "Darkness of Hallowvale");
    static readonly DEATH_PLATEAU = new Quest(23, "Death Plateau");
    static readonly DEATH_TO_THE_DORGESHUUN = new Quest(24, "Death to the Dorgeshuun");
    static readonly DEMON_SLAYER = new Quest(25, "Demon Slayer");
    static readonly THE_DEPTHS_OF_DESPAIR = new Quest(26, "The Depths of Despair");
    static readonly DESERT_TREASURE_I = new Quest(27, "Desert Treasure I");
    static readonly DEVIOUS_MINDS = new Quest(28, "Devious Minds");
    static readonly THE_DIG_SITE = new Quest(29, "The Dig Site");
    static readonly DORICS_QUEST = new Quest(30, "Doric's Quest");
    static readonly DRAGON_SLAYER_I = new Quest(31, "Dragon Slayer I");
    static readonly DRAGON_SLAYER_II = new Quest(32, "Dragon Slayer II");
    static readonly DREAM_MENTOR = new Quest(33, "Dream Mentor");
    static readonly DRUIDIC_RITUAL = new Quest(34, "Druidic Ritual");
    static readonly DWARF_CANNON = new Quest(35, "Dwarf Cannon");
    static readonly EADGARS_RUSE = new Quest(36, "Eadgar's Ruse");
    static readonly EAGLES_PEAK = new Quest(37, "Eagles' Peak");
    static readonly ELEMENTAL_WORKSHOP_I = new Quest(38, "Elemental Workshop I");
    static readonly ELEMENTAL_WORKSHOP_II = new Quest(39, "Elemental Workshop II");
    static readonly ENAKHRAS_LAMENT = new Quest(40, "Enakhra's Lament");
    static readonly THE_ENCHANTED_KEY = new Quest(41, "The Enchanted Key");
    static readonly ENLIGHTENED_JOURNEY = new Quest(42, "Enlightened Journey");
    static readonly ENTER_THE_ABYSS = new Quest(43, "Enter the Abyss");
    static readonly ERNEST_THE_CHICKEN = new Quest(44, "Ernest the Chicken");
    static readonly THE_EYES_OF_GLOUPHRIE = new Quest(45, "The Eyes of Glouphrie");
    static readonly FAIRYTALE_I__GROWING_PAINS = new Quest(46, "Fairytale I - Growing Pains");
    static readonly FAIRYTALE_II__CURE_A_QUEEN = new Quest(47, "Fairytale II - Cure a Queen");
    static readonly FAMILY_CREST = new Quest(48, "Family Crest");
    static readonly FAMILY_PEST = new Quest(49, "Family Pest");
    static readonly THE_FEUD = new Quest(50, "The Feud");
    static readonly FIGHT_ARENA = new Quest(51, "Fight Arena");
    static readonly FISHING_CONTEST = new Quest(52, "Fishing Contest");
    static readonly FORGETTABLE_TALE = new Quest(53, "Forgettable Tale...");
    static readonly THE_FORSAKEN_TOWER = new Quest(54, "The Forsaken Tower");
    static readonly THE_FREMENNIK_EXILES = new Quest(55, "The Fremennik Exiles");
    static readonly THE_FREMENNIK_ISLES = new Quest(56, "The Fremennik Isles");
    static readonly THE_FREMENNIK_TRIALS = new Quest(57, "The Fremennik Trials");
    static readonly GARDEN_OF_TRANQUILLITY = new Quest(58, "Garden of Tranquillity");
    static readonly THE_GENERALS_SHADOW = new Quest(59, "The General's Shadow");
    static readonly GERTRUDES_CAT = new Quest(60, "Gertrude's Cat");
    static readonly GETTING_AHEAD = new Quest(61, "Getting Ahead");
    static readonly GHOSTS_AHOY = new Quest(62, "Ghosts Ahoy");
    static readonly THE_GIANT_DWARF = new Quest(63, "The Giant Dwarf");
    static readonly GOBLIN_DIPLOMACY = new Quest(64, "Goblin Diplomacy");
    static readonly THE_GOLEM = new Quest(65, "The Golem");
    static readonly THE_GRAND_TREE = new Quest(66, "The Grand Tree");
    static readonly THE_GREAT_BRAIN_ROBBERY = new Quest(67, "The Great Brain Robbery");
    static readonly GRIM_TALES = new Quest(68, "Grim Tales");
    static readonly THE_HAND_IN_THE_SAND = new Quest(69, "The Hand in the Sand");
    static readonly HAUNTED_MINE = new Quest(70, "Haunted Mine");
    static readonly HAZEEL_CULT = new Quest(71, "Hazeel Cult");
    static readonly HEROES_QUEST = new Quest(72, "Heroes' Quest");
    static readonly HOLY_GRAIL = new Quest(73, "Holy Grail");
    static readonly HORROR_FROM_THE_DEEP = new Quest(74, "Horror from the Deep");
    static readonly ICTHLARINS_LITTLE_HELPER = new Quest(75, "Icthlarin's Little Helper");
    static readonly IMP_CATCHER = new Quest(76, "Imp Catcher");
    static readonly IN_AID_OF_THE_MYREQUE = new Quest(77, "In Aid of the Myreque");
    static readonly IN_SEARCH_OF_KNOWLEDGE = new Quest(78, "In Search of Knowledge");
    static readonly IN_SEARCH_OF_THE_MYREQUE = new Quest(79, "In Search of the Myreque");
    static readonly JUNGLE_POTION = new Quest(80, "Jungle Potion");
    static readonly A_KINGDOM_DIVIDED = new Quest(81, "A Kingdom Divided");
    static readonly KINGS_RANSOM = new Quest(82, "King's Ransom");
    static readonly THE_KNIGHTS_SWORD = new Quest(83, "The Knight's Sword");
    static readonly LAIR_OF_TARN_RAZORLOR = new Quest(84, "Lair of Tarn Razorlor");
    static readonly LEGENDS_QUEST = new Quest(85, "Legends' Quest");
    static readonly LOST_CITY = new Quest(86, "Lost City");
    static readonly THE_LOST_TRIBE = new Quest(87, "The Lost Tribe");
    static readonly LUNAR_DIPLOMACY = new Quest(88, "Lunar Diplomacy");
    static readonly MAGE_ARENA_I = new Quest(89, "Mage Arena I");
    static readonly MAGE_ARENA_II = new Quest(90, "Mage Arena II");
    static readonly MAKING_FRIENDS_WITH_MY_ARM = new Quest(91, "Making Friends with My Arm");
    static readonly MAKING_HISTORY = new Quest(92, "Making History");
    static readonly MERLINS_CRYSTAL = new Quest(93, "Merlin's Crystal");
    static readonly MISTHALIN_MYSTERY = new Quest(94, "Misthalin Mystery");
    static readonly MONKEY_MADNESS_I = new Quest(95, "Monkey Madness I");
    static readonly MONKEY_MADNESS_II = new Quest(96, "Monkey Madness II");
    static readonly MONKS_FRIEND = new Quest(97, "Monk's Friend");
    static readonly MOUNTAIN_DAUGHTER = new Quest(98, "Mountain Daughter");
    static readonly MOURNINGS_END_PART_I = new Quest(99, "Mourning's End Part I");
    static readonly MOURNINGS_END_PART_II = new Quest(100, "Mourning's End Part II");
    static readonly MURDER_MYSTERY = new Quest(101, "Murder Mystery");
    static readonly MY_ARMS_BIG_ADVENTURE = new Quest(102, "My Arm's Big Adventure");
    static readonly NATURE_SPIRIT = new Quest(103, "Nature Spirit");
    static readonly A_NIGHT_AT_THE_THEATRE = new Quest(104, "A Night at the Theatre");
    static readonly OBSERVATORY_QUEST = new Quest(105, "Observatory Quest");
    static readonly OLAFS_QUEST = new Quest(106, "Olaf's Quest");
    static readonly ONE_SMALL_FAVOUR = new Quest(107, "One Small Favour");
    static readonly PIRATES_TREASURE = new Quest(108, "Pirate's Treasure");
    static readonly PLAGUE_CITY = new Quest(109, "Plague City");
    static readonly A_PORCINE_OF_INTEREST = new Quest(110, "A Porcine of Interest");
    static readonly PRIEST_IN_PERIL = new Quest(111, "Priest in Peril");
    static readonly PRINCE_ALI_RESCUE = new Quest(112, "Prince Ali Rescue");
    static readonly THE_QUEEN_OF_THIEVES = new Quest(113, "The Queen of Thieves");
    static readonly RAG_AND_BONE_MAN_I = new Quest(114, "Rag and Bone Man I");
    static readonly RAG_AND_BONE_MAN_II = new Quest(115, "Rag and Bone Man II");
    static readonly RATCATCHERS = new Quest(116, "Ratcatchers");
    static readonly RECIPE_FOR_DISASTER = new Quest(117, "Recipe for Disaster");
    static readonly RECRUITMENT_DRIVE = new Quest(118, "Recruitment Drive");
    static readonly REGICIDE = new Quest(119, "Regicide");
    static readonly THE_RESTLESS_GHOST = new Quest(120, "The Restless Ghost");
    static readonly ROMEO__JULIET = new Quest(121, "Romeo & Juliet");
    static readonly ROVING_ELVES = new Quest(122, "Roving Elves");
    static readonly ROYAL_TROUBLE = new Quest(123, "Royal Trouble");
    static readonly RUM_DEAL = new Quest(124, "Rum Deal");
    static readonly RUNE_MYSTERIES = new Quest(125, "Rune Mysteries");
    static readonly SCORPION_CATCHER = new Quest(126, "Scorpion Catcher");
    static readonly SEA_SLUG = new Quest(127, "Sea Slug");
    static readonly SHADES_OF_MORTTON = new Quest(128, "Shades of Mort'ton");
    static readonly SHADOW_OF_THE_STORM = new Quest(129, "Shadow of the Storm");
    static readonly SHEEP_HERDER = new Quest(130, "Sheep Herder");
    static readonly SHEEP_SHEARER = new Quest(131, "Sheep Shearer");
    static readonly SHIELD_OF_ARRAV = new Quest(132, "Shield of Arrav");
    static readonly SHILO_VILLAGE = new Quest(133, "Shilo Village");
    static readonly SINS_OF_THE_FATHER = new Quest(134, "Sins of the Father");
    static readonly SKIPPY_AND_THE_MOGRES = new Quest(135, "Skippy and the Mogres");
    static readonly THE_SLUG_MENACE = new Quest(136, "The Slug Menace");
    static readonly SONG_OF_THE_ELVES = new Quest(137, "Song of the Elves");
    static readonly A_SOULS_BANE = new Quest(138, "A Soul's Bane");
    static readonly SPIRITS_OF_THE_ELID = new Quest(139, "Spirits of the Elid");
    static readonly SWAN_SONG = new Quest(140, "Swan Song");
    static readonly TAI_BWO_WANNAI_TRIO = new Quest(141, "Tai Bwo Wannai Trio");
    static readonly A_TAIL_OF_TWO_CATS = new Quest(142, "A Tail of Two Cats");
    static readonly TALE_OF_THE_RIGHTEOUS = new Quest(143, "Tale of the Righteous");
    static readonly A_TASTE_OF_HOPE = new Quest(144, "A Taste of Hope");
    static readonly TEARS_OF_GUTHIX = new Quest(145, "Tears of Guthix");
    static readonly TEMPLE_OF_IKOV = new Quest(146, "Temple of Ikov");
    static readonly THRONE_OF_MISCELLANIA = new Quest(147, "Throne of Miscellania");
    static readonly THE_TOURIST_TRAP = new Quest(148, "The Tourist Trap");
    static readonly TOWER_OF_LIFE = new Quest(149, "Tower of Life");
    static readonly TREE_GNOME_VILLAGE = new Quest(150, "Tree Gnome Village");
    static readonly TRIBAL_TOTEM = new Quest(151, "Tribal Totem");
    static readonly TROLL_ROMANCE = new Quest(152, "Troll Romance");
    static readonly TROLL_STRONGHOLD = new Quest(153, "Troll Stronghold");
    static readonly UNDERGROUND_PASS = new Quest(154, "Underground Pass");
    static readonly VAMPYRE_SLAYER = new Quest(155, "Vampyre Slayer");
    static readonly WANTED = new Quest(156, "Wanted!");
    static readonly WATCHTOWER = new Quest(157, "Watchtower");
    static readonly WATERFALL_QUEST = new Quest(158, "Waterfall Quest");
    static readonly WHAT_LIES_BELOW = new Quest(159, "What Lies Below");
    static readonly WITCHS_HOUSE = new Quest(160, "Witch's House");
    static readonly WITCHS_POTION = new Quest(161, "Witch's Potion");
    static readonly X_MARKS_THE_SPOT = new Quest(162, "X Marks the Spot");
    static readonly ZOGRE_FLESH_EATERS = new Quest(163, "Zogre Flesh Eaters");
    static readonly THE_FROZEN_DOOR = new Quest(164, "The Frozen Door");
    static readonly LAND_OF_THE_GOBLINS = new Quest(165, "Land of the Goblins");
    static readonly HOPESPEARS_WILL = new Quest(166, "Hopespear's Will");
    static readonly TEMPLE_OF_THE_EYE = new Quest(167, "Temple of the Eye");
    static readonly BENEATH_CURSED_SANDS = new Quest(168, "Beneath Cursed Sands");
    static readonly SLEEPING_GIANTS = new Quest(169, "Sleeping Giants");
    static readonly THE_GARDEN_OF_DEATH = new Quest(180, "The Garden of Death");
    static readonly INTO_THE_TOMBS = new Quest(2306, "Into the Tombs");
    static readonly RECIPE_FOR_DISASTER__ANOTHER_COOKS_QUEST = new Quest(2307, "Recipe for Disaster - Another Cook's Quest");
    static readonly RECIPE_FOR_DISASTER__MOUNTAIN_DWARF = new Quest(2308, "Recipe for Disaster - Mountain Dwarf");
    static readonly RECIPE_FOR_DISASTER__WARTFACE__BENTNOZE = new Quest(2309, "Recipe for Disaster - Wartface & Bentnoze");
    static readonly RECIPE_FOR_DISASTER__PIRATE_PETE = new Quest(2310, "Recipe for Disaster - Pirate Pete");
    static readonly RECIPE_FOR_DISASTER__LUMBRIDGE_GUIDE = new Quest(2311, "Recipe for Disaster - Lumbridge Guide");
    static readonly RECIPE_FOR_DISASTER__EVIL_DAVE = new Quest(2312, "Recipe for Disaster - Evil Dave");
    static readonly RECIPE_FOR_DISASTER__SKRACH_UGLOGWEE = new Quest(2313, "Recipe for Disaster - Skrach Uglogwee");
    static readonly RECIPE_FOR_DISASTER__SIR_AMIK_VARZE = new Quest(2314, "Recipe for Disaster - Sir Amik Varze");
    static readonly RECIPE_FOR_DISASTER__KING_AWOWOGEI = new Quest(2315, "Recipe for Disaster - King Awowogei");
    static readonly RECIPE_FOR_DISASTER__CULINAROMANCER = new Quest(2316, "Recipe for Disaster - Culinaromancer");
    static readonly SECRETS_OF_THE_NORTH = new Quest(2338, "Secrets of the North");
    static readonly DESERT_TREASURE_II__THE_FALLEN_EMPIRE = new Quest(2343, "Desert Treasure II - The Fallen Empire");
    static readonly HIS_FAITHFUL_SERVANTS = new Quest(3250, "His Faithful Servants");
    static readonly THE_PATH_OF_GLOUPHRIE = new Quest(3425, "The Path of Glouphrie");
    static readonly CHILDREN_OF_THE_SUN = new Quest(3450, "Children of the Sun");
    static readonly BARBARIAN_TRAINING = new Quest(3451, "Barbarian Training");
    static readonly DEFENDER_OF_VARROCK = new Quest(3466, "Defender of Varrock");
    static readonly WHILE_GUTHIX_SLEEPS = new Quest(3467, "While Guthix Sleeps");
    static readonly TWILIGHTS_PROMISE = new Quest(3512, "Twilight's Promise");
    static readonly AT_FIRST_LIGHT = new Quest(3513, "At First Light");
    static readonly PERILOUS_MOONS = new Quest(3514, "Perilous Moons");
    static readonly THE_RIBBITING_TALE_OF_A_LILY_PAD_LABOUR_DISPUTE = new Quest(3515, "The Ribbiting Tale of a Lily Pad Labour Dispute");
    static readonly THE_HEART_OF_DARKNESS = new Quest(3710, "The Heart of Darkness");
    static readonly DEATH_ON_THE_ISLE = new Quest(3711, "Death on the Isle");
    static readonly MEAT_AND_GREET = new Quest(3712, "Meat and Greet");
    static readonly ETHICALLY_ACQUIRED_ANTIQUITIES = new Quest(3713, "Ethically Acquired Antiquities");
    static readonly THE_CURSE_OF_ARRAV = new Quest(3937, "The Curse of Arrav");
    static readonly THE_FINAL_DAWN = new Quest(5189, "The Final Dawn");
    static readonly SHADOWS_OF_CUSTODIA = new Quest(5190, "Shadows of Custodia");
    static readonly SCRAMBLED = new Quest(5191, "Scrambled!");
    static readonly VALE_TOTEMS = new Quest(5194, "Vale Totems");
    static readonly PANDEMONIUM = new Quest(7103, "Pandemonium");
    static readonly PRYING_TIMES = new Quest(7104, "Prying Times");
    static readonly CURRENT_AFFAIRS = new Quest(7105, "Current Affairs");
    static readonly TROUBLED_TORTUGANS = new Quest(7106, "Troubled Tortugans");
    static readonly THE_RED_REEF = new Quest(7107, "The Red Reef");
    static readonly FALLEN_FROM_GRACE = new Quest(7133, "Fallen From Grace");
    static readonly LEARNING_THE_ROPES = new Quest(9643, "Learning the Ropes");
    static readonly THE_IDES_OF_MILK = new Quest(9645, "The Ides of Milk");
    static readonly THE_BLOOD_MOON_RISES = new Quest(16414, "The Blood Moon Rises");
    static readonly A_RUFF_SITUATION = new Quest(16971, "A Ruff Situation");
    static readonly CRAB_QUEST = new Quest(16972, "Crab Quest");
    static readonly THE_FRACTURED_ARCHIVE = new Quest(17027, "The Fractured Archive");

    private constructor(
        private readonly id: number,
        private readonly name: string,
    ) {
        Quest.all.push(this);
    }

    static values(): readonly Quest[] {
        return Quest.all;
    }

    getId(): number {
        return this.id;
    }

    getName(): string {
        return this.name;
    }

    getState(client: Client): QuestState {
        client.runScript(QUEST_STATUS_GET, this.id);
        switch (client.getIntStack()[0]) {
            case 2:
                return QuestState.FINISHED;
            case 1:
                return QuestState.NOT_STARTED;
            default:
                return QuestState.IN_PROGRESS;
        }
    }
}
