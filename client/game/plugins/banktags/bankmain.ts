/**
 * What Bank Tags uses of the bank interface: RuneLite's InterfaceID.Bankmain components (group
 * 12), and the ScriptIDs, varbits and ids its code names. Values from RuneLite 1.13.3's gameval
 * and api.
 */
const component = (child: number) => (12 << 16) | child;

export const Bankmain = {
    UNIVERSE: component(0x01),
    TITLE: component(0x03),
    ITEMS_CONTAINER: component(0x09),
    ITEMS: component(0x0c),
    SCROLLBAR: component(0x0d),
    SEARCH_BUTTON: component(0x2a),
    DEPOSITINV: component(0x2f),
    DEPOSITWORN: component(0x31),
    POPUP_BUTTON_OUT: component(0x34),
    STORAGE_POPUP_TAB: component(0x35),
    INCINERATOR_TARGET: component(0x36),
    GIM_STORAGE: component(0x7d),
    POTIONSTORE_BUTTON: component(0x7e),
} as const;

export const BANKSIDE = 15;

export const ScriptID = {
    MESSAGE_LAYER_CLOSE: 299,
    BANKMAIN_INIT: 274,
    BANKMAIN_BUILD: 277,
    BANKMAIN_SEARCH_TOGGLE: 281,
    BANKMAIN_DRAGSCROLL: 284,
    BANKMAIN_FINISHBUILDING: 505,
    BANKMAIN_SIZE_CHECK: 840,
    BANKMAIN_POPUP_TAB_DRAW: 9221,
} as const;

/** RuneLite's InputType.NONE, for varc MESLAYERMODE. */
export const INPUT_TYPE_NONE = 0;

/** EquipmentInventorySlot indices. */
export const EquipmentSlot = {
    HEAD: 0, CAPE: 1, AMULET: 2, WEAPON: 3, BODY: 4, SHIELD: 5, LEGS: 7, GLOVES: 9, BOOTS: 10, RING: 12, AMMO: 13,
} as const;

/** ParamID.BANK_AUTOCHARGE and QUIVER_AMMO_AVAILABLE. */
export const PARAM_BANK_AUTOCHARGE = 2257;
export const PARAM_QUIVER_AMMO_AVAILABLE = 1910;
/** EnumID.RUNEPOUCH_RUNE. */
export const ENUM_RUNEPOUCH_RUNE = 982;
/** SoundEffectID.UI_BOOP. */
export const SOUND_UI_BOOP = 2266;
/** Constants.ITEM_SPRITE_WIDTH / HEIGHT. */
export const ITEM_SPRITE_WIDTH = 36;
export const ITEM_SPRITE_HEIGHT = 32;

/** BankTagsPlugin's bank grid metrics. */
export const BANK_ITEM_WIDTH = 36;
export const BANK_ITEM_HEIGHT = 32;
export const BANK_ITEM_X_PADDING = 12;
export const BANK_ITEM_Y_PADDING = 4;
export const BANK_ITEMS_PER_ROW = 8;
export const BANK_ITEM_START_X = 51;
export const BANK_ITEM_START_Y = 0;
