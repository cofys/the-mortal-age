import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./QuestOverlay.css";

interface QuestDialogue {
    speaker: string;
    title: string;
    lines: string[];
    choices: { text: string }[] | null;
}

interface QuestTask {
    verb: string;
    has: number;
    need: number;
}

interface QuestRewards {
    items: [string, number][];
    xp: [string, number][];
    message: string;
}

interface QuestInfo {
    id: string;
    name: string;
    blurb: string;
    stageIndex: number;
    stageTotal: number;
    objective: string;
    arrived: boolean;
    dialogue: QuestDialogue | null;
    task: QuestTask | null;
    complete: boolean;
    rewards: QuestRewards | null;
}

interface QuestsStatus {
    quest: QuestInfo | null;
}

export function QuestOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<QuestsStatus | null>(null);
    const [lineIndex, setLineIndex] = useState(0);
    const [busy, setBusy] = useState(false);
    const pollRef = useRef<number | undefined>(undefined);
    const lastQuestId = useRef<string | null>(null);

    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/quests-status?player=${encodeURIComponent(username)}`
            )) as QuestsStatus;
            // Reset dialogue pagination when the quest or stage changes.
            const qid = data.quest ? `${data.quest.id}:${data.quest.stageIndex}` : null;
            if (qid !== lastQuestId.current) {
                lastQuestId.current = qid;
                setLineIndex(0);
            }
            setStatus(data);
        } catch {
            // Server unreachable or endpoint missing — stay hidden, retry next poll.
        }
    }, [username, osrsClient]);

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 2000);
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    const sendAction = useCallback(
        async (action: string, option?: number) => {
            if (busy) return;
            setBusy(true);
            try {
                const params = new URLSearchParams({
                    player: username,
                    action,
                });
                if (option !== undefined) params.set("option", String(option));
                await fetchContent(`/api/quests-status?${params.toString()}`);
            } catch {
                // Fall through; next poll picks up state.
            }
            setLineIndex(0);
            window.setTimeout(() => {
                poll();
                setBusy(false);
            }, 800);
        },
        [busy, username, poll]
    );

    const quest = status?.quest;
    if (!quest) return null;

    // ---- Completion overlay ----
    if (quest.complete && quest.rewards) {
        return (
            <div className="tma-quest-backdrop">
                <div className="tma-quest-panel tma-quest-complete">
                    <div className="tma-quest-complete-title">Quest Complete</div>
                    <div className="tma-quest-complete-name">{quest.name}</div>
                    {quest.rewards.message && (
                        <p className="tma-quest-complete-msg">{quest.rewards.message}</p>
                    )}
                    <div className="tma-quest-rewards">
                        {quest.rewards.items.map(([name, amt]) => (
                            <div key={`i-${name}`} className="tma-quest-reward">
                                {amt} × {name}
                            </div>
                        ))}
                        {quest.rewards.xp.map(([skill, amt]) => (
                            <div key={`x-${skill}`} className="tma-quest-reward">
                                {amt} {skill} XP
                            </div>
                        ))}
                    </div>
                    <button
                        className="tma-quest-btn"
                        onClick={() => sendAction("dismiss")}
                        disabled={busy}
                    >
                        Continue
                    </button>
                </div>
            </div>
        );
    }

    const dialogue = quest.dialogue;
    const showDialogue = quest.arrived && dialogue;

    return (
        <>
            {/* Objective banner — always visible while quest is active */}
            <div className="tma-quest-banner">
                <span className="tma-quest-banner-name">{quest.name}</span>
                <span className="tma-quest-banner-obj">{quest.objective}</span>
                <span className="tma-quest-banner-stage">
                    {quest.stageIndex + 1} / {quest.stageTotal}
                </span>
            </div>

            {/* Dialogue panel */}
            {showDialogue && (
                <div className="tma-quest-backdrop tma-quest-backdrop-light">
                    <div className="tma-quest-panel">
                        <div className="tma-quest-speaker">
                            <span className="tma-quest-speaker-name">{dialogue.speaker}</span>
                            {dialogue.title && (
                                <span className="tma-quest-speaker-title">{dialogue.title}</span>
                            )}
                        </div>
                        <p className="tma-quest-line">
                            {dialogue.lines[Math.min(lineIndex, dialogue.lines.length - 1)]}
                        </p>
                        {dialogue.choices && lineIndex >= dialogue.lines.length - 1 ? (
                            <div className="tma-quest-choices">
                                {dialogue.choices.map((c, i) => (
                                    <button
                                        key={i}
                                        className="tma-quest-btn tma-quest-choice"
                                        onClick={() => sendAction("choice", i)}
                                        disabled={busy}
                                    >
                                        {c.text}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <button
                                className="tma-quest-btn"
                                onClick={() => {
                                    if (lineIndex < dialogue.lines.length - 1) {
                                        setLineIndex(lineIndex + 1);
                                    } else {
                                        sendAction("continue");
                                    }
                                }}
                                disabled={busy}
                            >
                                Continue
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Travel hint when the player hasn't reached the stage location */}
            {!quest.arrived && !quest.task && (
                <div className="tma-quest-travel-hint">Make your way to the marked location…</div>
            )}

            {/* Task progress */}
            {quest.arrived && quest.task && (
                <div className="tma-quest-travel-hint">
                    {quest.task.has} / {quest.task.need} — keep going…
                </div>
            )}
        </>
    );
}
