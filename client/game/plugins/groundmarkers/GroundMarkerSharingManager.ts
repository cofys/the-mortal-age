import { WidgetMenuOption } from "@runelite/client/menus/WidgetMenuOption";
import { chatHistory } from "../../../rs/cs2/ChatHistory";
import { byRegion, mergeImported, parsePoints, serializePoints, type GroundMarkerPoint } from "./groundMarkerPoints";
import type { GroundMarkerPlugin } from "./GroundMarkerPlugin";

/** InterfaceID.Orbs.WORLDMAP and InterfaceID.OrbsNomap.WORLDMAP. */
export const ORBS_WORLDMAP = (160 << 16) | 55;
export const ORBS_NOMAP_WORLDMAP = (895 << 16) | 53;

/** RuneLite's GroundMarkerSharingManager: Export, Import and Clear on the world map orb. */
export class GroundMarkerSharingManager {
    private readonly exportOption = new WidgetMenuOption("Export", "Ground Markers", ORBS_WORLDMAP, ORBS_NOMAP_WORLDMAP);
    private readonly importOption = new WidgetMenuOption("Import", "Ground Markers", ORBS_WORLDMAP, ORBS_NOMAP_WORLDMAP);
    private readonly clearOption = new WidgetMenuOption("Clear", "Ground Markers", ORBS_WORLDMAP, ORBS_NOMAP_WORLDMAP);

    constructor(private readonly plugin: GroundMarkerPlugin) {}

    addImportExportMenuOptions(): void {
        this.plugin.menuManager.addManagedCustomMenu(this.exportOption, () => void this.exportGroundMarkers());
        this.plugin.menuManager.addManagedCustomMenu(this.importOption, () => void this.promptForImport());
    }

    addClearMenuOption(): void {
        this.plugin.menuManager.addManagedCustomMenu(this.clearOption, () => this.promptForClear());
    }

    removeMenuOptions(): void {
        this.plugin.menuManager.removeManagedCustomMenu(this.exportOption);
        this.plugin.menuManager.removeManagedCustomMenu(this.importOption);
        this.plugin.menuManager.removeManagedCustomMenu(this.clearOption);
    }

    async exportGroundMarkers(): Promise<void> {
        const activePoints = this.plugin.getMapRegions().flatMap((regionId) => this.plugin.getPoints(regionId));
        if (activePoints.length === 0) {
            this.sendChatMessage("You have no ground markers to export.");
            return;
        }
        const exportDump = serializePoints(activePoints);
        try {
            await navigator.clipboard.writeText(exportDump);
        } catch (error) {
            console.warn("[ground-markers] unable to set clipboard", error);
            return;
        }
        this.sendChatMessage(`${activePoints.length} ground markers were copied to your clipboard.`);
    }

    async promptForImport(): Promise<void> {
        let clipboardText: string;
        try {
            clipboardText = await navigator.clipboard.readText();
        } catch (error) {
            this.sendChatMessage("Unable to read system clipboard.");
            console.warn("[ground-markers] error reading clipboard", error);
            return;
        }
        if (!clipboardText) {
            this.sendChatMessage("You do not have any ground markers copied in your clipboard.");
            return;
        }
        let importPoints: GroundMarkerPoint[];
        try {
            importPoints = parsePoints(clipboardText);
        } catch {
            this.sendChatMessage("You do not have any ground markers copied in your clipboard.");
            return;
        }
        if (importPoints.length === 0) {
            this.sendChatMessage("You do not have any ground markers copied in your clipboard.");
            return;
        }
        this.plugin.chatboxPanelManager.openTextMenuInput(`Are you sure you want to import ${importPoints.length} ground markers?`)
            .option("Yes", () => this.importGroundMarkers(importPoints))
            .option("No", () => {})
            .build();
    }

    /** Each region straight into the config, as the regions may not be loaded. */
    importGroundMarkers(importPoints: GroundMarkerPoint[]): void {
        for (const [regionId, groupedPoints] of byRegion(importPoints)) {
            this.plugin.savePoints(regionId, mergeImported(this.plugin.getPoints(regionId), groupedPoints));
        }
        this.plugin.loadPoints();
        this.sendChatMessage(`${importPoints.length} ground markers were imported from the clipboard.`);
    }

    promptForClear(): void {
        const regions = this.plugin.getMapRegions();
        const numActivePoints = regions.reduce((n, regionId) => n + this.plugin.getPoints(regionId).length, 0);
        if (numActivePoints === 0) {
            this.sendChatMessage("You have no ground markers to clear.");
            return;
        }
        this.plugin.chatboxPanelManager.openTextMenuInput(`Are you sure you want to clear the<br>${numActivePoints} currently loaded ground markers?`)
            .option("Yes", () => {
                for (const regionId of regions) this.plugin.savePoints(regionId, null);
                this.plugin.loadPoints();
                this.sendChatMessage(`${numActivePoints} ground marker${numActivePoints === 1 ? " was cleared." : "s were cleared."}`);
            })
            .option("No", () => {})
            .build();
    }

    private sendChatMessage(message: string): void {
        chatHistory.addMessage("game", message);
    }
}

