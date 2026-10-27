import { GameStateChanged } from "@runelite/api/events";
import { GameState } from "@runelite/api/GameState";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import type { NavigationButton } from "@runelite/client/ui/NavigationButton";
import type { OsrsClient } from "../../OsrsClient";
import type { WidgetActionEvent } from "../../widgets/widgetActionPayload";
import { createBugReportNavigationButton } from "./BugReportPanel";
import { ClientLogBuffer, captureConsole } from "./ClientLogBuffer";
import {
    buildIssueUrl,
    openIssueTab,
    redactAddresses,
    formatDiagnosticsSection,
    resolveCopyFrame,
} from "./bugReportLink";
import { collectBugDiagnostics } from "./clientDiagnostics";
import { composeGameFrame, frameToPngBlob } from "./gameScreenshot";

// Cache chatbox: the Report button (162:31), whose op 4 is "Report game bug".
const REPORT_BUTTON = (162 << 16) | 31;
const REPORT_GAME_BUG_OP = 4;
const FRAME_TIMEOUT_MS = 2000;

export type BugReportState = {
    description: string;
    /** The game when the panel opened, for the clipboard. */
    screenshot?: Blob;
    capturing: boolean;
    /** Last opener outcome: clipboard copy confirmed, failed, or waiting on a click. */
    notice?: string;
};

/**
 * Report a Bug: a sidebar button, `::bug [text]` and the chatbox Report button's
 * "Report game bug" open one panel. The panel opens a prefilled GitHub issue — the
 * player files it themselves, so no token exists anywhere and every report is tied
 * to a real GitHub account. The screenshot is copied to the clipboard first, so
 * pasting it into the issue is all it takes.
 */
export class BugReportPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Report a Bug",
        description: "Opens a prefilled GitHub issue for the bug, also with ::bug.",
        tags: ["bug", "report", "feedback"],
        hidden: true,
        configKey: "bugreportplugin",
    };

    private readonly client = inject<OsrsClient>(CLIENT_TOKEN);
    private readonly clientToolbar = inject(ClientToolbar);
    private readonly listeners = new Set<() => void>();
    private readonly logs = new ClientLogBuffer();
    private restoreConsole?: () => void;
    private navButton?: NavigationButton;
    private frameWaiter?: (frame: HTMLCanvasElement | undefined) => void;
    /** Counts screenshot requests, so an older capture that finishes late can't replace a newer one. */
    private captures = 0;
    private state: BugReportState = { description: "", screenshot: undefined, capturing: false };

    protected async startUp(): Promise<void> {
        this.restoreConsole = captureConsole(this.logs);
        this.navButton = createBugReportNavigationButton(this);
        this.clientToolbar.addNavigation(this.navButton);
    }

    protected async shutDown(): Promise<void> {
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
        this.restoreConsole?.();
        this.restoreConsole = undefined;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getState(): BugReportState {
        return this.state;
    }

    /** Opens the panel with a fresh screenshot; the previous frame is never reused. */
    open(description = ""): void {
        if (description && !this.state.description.trim()) this.update({ description });
        if (this.navButton) this.clientToolbar.openPanel(this.navButton);
        void this.takeScreenshot();
    }

    setDescription(description: string): void {
        this.update({ description });
    }

    /**
     * Opens the prefilled issue synchronously (popup blockers eat deferred opens).
     * The screenshot is never attached automatically: copy it first, then paste it in.
     */
    openIssue(): void {
        try {
            const description = redactAddresses(this.state.description.trim());
            if (!description) return;
            const title = description.split("\n")[0] ?? description;
            const diagnostics = collectBugDiagnostics(this.client, this.logs);
            const url = buildIssueUrl(title, description, formatDiagnosticsSection(diagnostics));
            const notice = openIssueTab(url, (target) => window.open(target, "_blank", "noopener,noreferrer"));
            this.update({ notice });
        } catch (error) {
            console.warn("[bug-report] open issue failed", error);
            this.update({
                notice: `Couldn't open the issue page: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    /** Takes a fresh screenshot and copies it; never copies the frame the panel opened with. */
    async copyScreenshotToClipboard(): Promise<void> {
        await this.captureFlight;
        const previous = this.state.screenshot;
        // takeScreenshot() bumps the generation as its first act, so this is the one the click owns.
        const expectedGeneration = this.captures + 1;
        // Always capture again: a copy on click is "the game as it is now", not the frame the
        // panel opened with. `resolveCopyFrame` only falls back to that older frame while the
        // session is still the one the click started in.
        await this.takeScreenshot();
        const screenshot = resolveCopyFrame({
            fresh: this.state.screenshot,
            previous,
            expectedGeneration,
            generation: this.captures,
            loggedIn: this.client.isLoggedIn(),
        });
        if (!screenshot) {
            this.update({ notice: "No screenshot to copy: log in to take one, or paste your own." });
            return;
        }
        try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": screenshot })]);
            this.update({ notice: "Game screenshot copied: paste it into the issue with Ctrl+V." });
        } catch (error) {
            console.warn("[bug-report] clipboard copy failed", error);
            this.update({ notice: "Couldn't reach the clipboard: right-click the game and copy the screenshot manually." });
        }
    }

    private captureFlight?: Promise<void>;

    private async takeScreenshot(): Promise<void> {
        // A new attempt always drops the previous frame first: after a logout this
        // clears the old session's screenshot instead of leaving it reusable.
        const capture = ++this.captures;
        this.update({ screenshot: undefined });
        if (!this.client.isLoggedIn()) {
            this.update({ capturing: false });
            return;
        }
        this.update({ capturing: true });
        const flight = this.captureFrame(capture);
        this.captureFlight = flight;
        await flight;
        if (this.captureFlight === flight) this.captureFlight = undefined;
    }

    private async captureFrame(capture: number): Promise<void> {
        let screenshot: Blob | undefined;
        try {
            const frame = await this.nextFrame();
            screenshot = frame ? await frameToPngBlob(frame) : undefined;
        } catch (error) {
            console.warn("[bug-report] screenshot failed", error);
        }
        if (capture !== this.captures) return;
        // A logout during the capture must not publish the old session's frame.
        if (!this.client.isLoggedIn()) screenshot = undefined;
        this.update({ capturing: false, screenshot });
    }

    /** A session change drops the previous session's screenshot and pending capture. */
    onGameStateChanged(event: GameStateChanged): void {
        if (event.getGameState() === GameState.LOGGED_IN) return;
        this.captures++;
        this.update({ screenshot: undefined, capturing: false, notice: undefined });
    }

    handleClientCommand(command: string): boolean {
        const [name, ...words] = command.trim().split(/\s+/);
        if (name.toLowerCase() !== "bug") return false;
        this.open(words.join(" "));
        return true;
    }

    handleWidgetAction(event: WidgetActionEvent): boolean {
        if (event.widget?.uid !== REPORT_BUTTON) return false;
        const option = String(event.option ?? "").replace(/<[^>]*>/g, "").trim().toLowerCase();
        if (event.opIndex !== REPORT_GAME_BUG_OP && option !== "report game bug") return false;
        this.open();
        return true;
    }

    afterFrame(scene: HTMLCanvasElement): void {
        const waiter = this.frameWaiter;
        if (!waiter) return;
        this.frameWaiter = undefined;
        // Now, in the task that drew it: WebGL clears the canvas once the frame is presented.
        let frame: HTMLCanvasElement | undefined;
        try {
            frame = composeGameFrame(scene);
        } catch (error) {
            console.warn("[bug-report] screenshot failed", error);
        }
        waiter(frame);
    }

    /** The next frame drawn, composed for a screenshot, or undefined if none is drawn soon. */
    private nextFrame(): Promise<HTMLCanvasElement | undefined> {
        this.frameWaiter?.(undefined);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.frameWaiter !== waiter) return;
                this.frameWaiter = undefined;
                resolve(undefined);
            }, FRAME_TIMEOUT_MS);
            const waiter = (frame: HTMLCanvasElement | undefined): void => {
                clearTimeout(timer);
                resolve(frame);
            };
            this.frameWaiter = waiter;
        });
    }

    private update(patch: Partial<BugReportState>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of [...this.listeners]) listener();
    }
}
