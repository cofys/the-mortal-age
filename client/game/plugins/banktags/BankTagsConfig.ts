import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** RuneLite 1.13.3 BankTagsConfig: group, keys and defaults as in RuneLite. */
export const BankTagsConfig = ConfigGroup("banktags", {
    tabs: ConfigItem({
        keyName: "useTabs",
        name: "Use tag tabs",
        description: "Enable the ability to add tabs to your bank which allow fast access to tags.",
        position: 1,
        default: true,
    }),
    rememberTab: ConfigItem({
        name: "Remember last tag tab",
        description: "Enable the ability to remember last tag tab when closing/opening the bank.",
        position: 2,
        default: true,
    }),
    removeSeparators: ConfigItem({
        keyName: "removeTabSeparators",
        name: "Remove tab separators",
        description: "Remove the tab separators normally present in tag tabs.",
        position: 3,
        default: false,
    }),
    preventTagTabDrags: ConfigItem({
        name: "Prevent tag tab item dragging",
        description: "Ignore dragged items to prevent unwanted bank item reordering.",
        position: 4,
        default: false,
    }),
    position: ConfigItem({ name: "", description: "", hidden: true, default: 0 }),
    tab: ConfigItem({ name: "", description: "", hidden: true, default: "" }),
});
