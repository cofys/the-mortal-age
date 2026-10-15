import type { Player } from "../Player";
import { PlayerSave } from "../persistence/PlayerSave";
const SKIP_PERSISTENCE_ATTRIBUTE = "bot-skip-persistence";



/** A stored copy of a player's save, kept by a backend that keeps a save history. */
export interface PlayerSaveSnapshot {
    id: number;
    savedAt: string;
    reason: string;
    bytes: number;
}

/** The outcome of restoring a snapshot. */
export interface PlayerSaveRestore {
    snapshot: PlayerSaveSnapshot;
    /** True when the player was online: the snapshot is written by their logout save instead. */
    pending: boolean;
}

export abstract class PlayerPersistence {
    private readonly requestedSaves = new Map<Player, Set<string>>();
    private readonly requestErrors = new Map<Player, Error>();

    abstract load(username: string): PlayerSave;
    /** `reason` says why the save happened ("logout", "autosave", "shutdown", ...); a backend with a history records it. */
    abstract save(player: Player, reason?: string): void;
    abstract exists(username: string): boolean;

    /** External stores must use this path instead of editing a live account's saved row. */
    public async updateOffline(username: string, update: (save: PlayerSave) => void, reason = "offline-purchase"): Promise<boolean> {
        const { World } = require("../../../../World") as typeof import("../../../../World");
        if (World.getPlayerByName(username)) throw new Error("Cannot update an online account through offline persistence");
        const save = this.load(username);
        if (!save) return false;
        update(save);
        this.saveOffline(username, save, reason);
        await this.flush();
        return true;
    }

    protected saveOffline(_username: string, _save: PlayerSave, _reason: string): void {
        throw new Error("This persistence backend does not support offline updates");
    }

    /** Snapshot after the current operation finishes; overlapping triggers share one write. */
    public requestSave(player: Player, reason: string): void {
        if (!player || player.getAttribute?.(SKIP_PERSISTENCE_ATTRIBUTE) === true) return;
        if (this.requestedSaves.size === 0) queueMicrotask(() => this.saveRequested());
        const reasons = this.requestedSaves.get(player) ?? new Set<string>();
        reasons.add(reason);
        this.requestedSaves.set(player, reasons);
    }

    /** Logout and full-world saves already snapshot the final state themselves. */
    public cancelRequestedSave(player: Player): void {
        this.requestedSaves.delete(player);
        this.requestErrors.delete(player);
    }

    protected saveRequested(): void {
        const pending = [...this.requestedSaves];
        this.requestedSaves.clear();
        for (const [player, reasons] of pending) {
            try {
                this.save(player, [...reasons].join(","));
                this.requestErrors.delete(player);
            } catch (error) {
                this.requestErrors.set(player, error instanceof Error ? error : new Error(String(error)));
                console.error(`[persistence] Could not snapshot ${player.getUsername()}`, error);
            }
        }
    }

    public async flush(): Promise<void> {
        this.saveRequested();
        if (this.requestErrors.size > 0) throw this.requestErrors.values().next().value;
    }

    /** Whether this backend keeps a history of saves to roll back to. */
    public supportsHistory(): boolean {
        return false;
    }

    /** A player's snapshots, newest first. */
    public listSnapshots(_username: string, _limit?: number): PlayerSaveSnapshot[] {
        return [];
    }

    /**
     * Puts a snapshot back as the player's save; null when there is no such snapshot. With
     * `online`, the player's next save writes it instead (log them out), so their logout save
     * can't overwrite it.
     */
    public restoreSnapshot(_username: string, _id: number, _options?: { online?: boolean }): PlayerSaveRestore | null {
        return null;
    }

    public async encryptPassword(plainPassword: string): Promise<string> {
        const { PasswordUtil } = require(
            "../../../../../util/PasswordUtil"
        ) as typeof import("../../../../../util/PasswordUtil");
        const passwordEncrypt: string = await PasswordUtil.generatePasswordHashWithSalt(plainPassword);
        return passwordEncrypt;
    }

    public async checkPassword(password: string, playerSave: PlayerSave): Promise<boolean> {
        const { PasswordUtil } = require(
            "../../../../../util/PasswordUtil"
        ) as typeof import("../../../../../util/PasswordUtil");
        const passwordHashWithSalt = playerSave.getPasswordHashWithSalt();
        const isMatch: boolean = await PasswordUtil.passwordsMatch(password, passwordHashWithSalt);
        return isMatch;
    }
}
