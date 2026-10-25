/** Where RuneLite's Notifier sends a notification here: the game's chat and the browser. */
type NotifierClient = { addGameMessage(message: string): void };

/** ChatColorType.HIGHLIGHT for a console message (opaque chatbox). */
const HIGHLIGHT = "ff0000";
const APP_NAME = "RuneLite";

let permissionAsked = false;

/**
 * The browser asks for notification permission only after a user gesture, so it is asked on the
 * first click in the page after something first wants to notify.
 */
function askPermissionOnNextClick(): void {
    if (permissionAsked || typeof window === "undefined" || typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    permissionAsked = true;
    window.addEventListener("pointerdown", () => {
        try {
            void Notification.requestPermission();
        } catch {}
    }, { once: true, capture: true });
}

/**
 * RuneLite's Notifier.notify: a highlighted game message, and (in place of the tray
 * notification) a browser notification while the page is in the background, once allowed.
 */
export class Notifier {
    constructor(private readonly client: NotifierClient) {}

    notify(message: string): void {
        try {
            this.client.addGameMessage(`<col=${HIGHLIGHT}>${message}</col>`);
        } catch {}
        if (typeof Notification === "undefined" || typeof document === "undefined") return;
        if (Notification.permission === "default") {
            askPermissionOnNextClick();
            return;
        }
        if (Notification.permission !== "granted" || !document.hidden) return;
        try {
            new Notification(APP_NAME, { body: message });
        } catch {}
    }
}
