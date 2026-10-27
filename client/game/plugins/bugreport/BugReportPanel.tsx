import { useCallback, useSyncExternalStore } from "react";

import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import type { BugReportPlugin, BugReportState } from "./BugReportPlugin";

function BugIcon({ label }: { label: string }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <g stroke="#ef5350">
                <path d="M9 7V6a3 3 0 0 1 6 0v1M9 3 7 1M15 3l2-2" />
                <rect x="7" y="7" width="10" height="14" rx="5" />
                <path d="M12 11v10M7 10 3 8M7 14H2M7 18l-4 3M17 10l4-2M17 14h5M17 18l4 3" />
            </g>
        </svg>
    );
}

/** Report a Bug: describe it here, copy the screenshot, then file it on the prefilled GitHub issue. */
export function BugReportPanel({ plugin }: { plugin: BugReportPlugin }): JSX.Element {
    const subscribe = useCallback((listener: () => void) => plugin.subscribe(listener), [plugin]);
    const getSnapshot = useCallback(() => plugin.getState(), [plugin]);
    const state: BugReportState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return (
        <form
            className="rl-sidebar-panel-content rl-sidebar-scrollable"
            onSubmit={(event) => {
                event.preventDefault();
                plugin.openIssue();
            }}
        >
            <label className="rl-sidebar-field">
                What went wrong?
                <textarea
                    className="rl-sidebar-textarea"
                    rows={6}
                    maxLength={2000}
                    required
                    value={state.description}
                    placeholder="What happened, and what did you expect? Steps to make it happen again help most."
                    onChange={(event) => plugin.setDescription(event.target.value)}
                />
            </label>
            <p className="rl-sidebar-panel-copy">
                {state.capturing
                    ? "Taking a screenshot…"
                    : state.screenshot
                      ? "Screenshot ready."
                      : "No screenshot yet: log in to take one, or paste your own."}
            </p>
            <button
                type="button"
                className="rl-sidebar-text-button"
                disabled={state.capturing}
                onClick={() => void plugin.copyScreenshotToClipboard()}
            >
                Copy game screenshot to clipboard
            </button>
            <p className="rl-sidebar-panel-copy">
                Filing opens a GitHub issue with your description, player and account state
                (position, skills, inventory, equipment), world, client details, game messages
                and recent errors. No address, identifier or browsing data is sent.
            </p>
            {state.notice ? (
                <p className="rl-sidebar-panel-copy" role="status">
                    {state.notice}
                </p>
            ) : null}
            {/* Not disabled on an empty description: a greyed button that ignores clicks reads as
                broken. `required` makes the browser say what is missing instead. */}
            <button type="submit" className="rl-sidebar-text-button">
                Open GitHub issue
            </button>
        </form>
    );
}

/** The Report a Bug button, last on the rail, below every plugin's button. */
export function createBugReportNavigationButton(plugin: BugReportPlugin): NavigationButton {
    return NavigationButton.builder()
        .tooltip("Report a Bug")
        .icon(BugIcon)
        .priority(100)
        .panel(() => <BugReportPanel plugin={plugin} />)
        .build();
}
