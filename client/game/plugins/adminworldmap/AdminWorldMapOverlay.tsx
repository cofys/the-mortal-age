import { useCallback, useEffect, useRef, useState } from "react";
import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./AdminWorldMapOverlay.css";

interface CitizenDot {
    n: string; x: number; y: number; z: number;
    a: string | null; g: string | null; k: string | null;
    p: string | null; o: number; b: number; t: number;
}
interface PlayerDot { n: string; x: number; y: number; z: number; bot: number; }
interface MapStatus {
    open: boolean;
    citizens?: CitizenDot[];
    players?: PlayerDot[];
    stats?: { roster: number; online: number };
    ok?: string;
    error?: string;
}

// OSRS world bounds (approx) for map projection.
const WORLD_MIN_X = 1000, WORLD_MAX_X = 4000;
const WORLD_MIN_Y = 1000, WORLD_MAX_Y = 4000;

type ActivityCat = "skilling" | "idle" | "social" | "travel" | "combat" | "work" | "other";

function categoryOf(activityId: string | null): ActivityCat {
    if (!activityId) return "idle";
    const a = activityId.toLowerCase();
    if (/mine|chop|fish|gather|fire|smelt|craft|cook|herb|fletch|_rc|agility|hunt|farm|thieve|build|archaeolog|artisan|weav|tailor|chef/.test(a)) return "skilling";
    if (/slayer|pker|patrol|guard|combat|attack|fight|war|siege|raid|boss/.test(a)) return "combat";
    if (/social|tavern|entertain|celebrate|perform|chat|gossip|mingle/.test(a)) return "social";
    if (/travel|stroll|flight|journey|walk|caravan|migrate/.test(a)) return "travel";
    if (/rest|routine|idle|sleep|wait|stand|meal|bank/.test(a)) return "idle";
    if (/merchant|tend|shop|stall|duty|tithe|work|job|service|courtier/.test(a)) return "work";
    return "other";
}

const CAT_COLORS: Record<ActivityCat, string> = {
    skilling: "#4caf50",
    idle: "#8a8a8a",
    social: "#42a5f5",
    travel: "#ffeb3b",
    combat: "#f44336",
    work: "#ff9800",
    other: "#ba68c8",
};
const CAT_LABELS: Record<ActivityCat, string> = {
    skilling: "Skilling", idle: "Idle", social: "Socializing", travel: "Traveling",
    combat: "Combat", work: "Working", other: "Other",
};

export function AdminWorldMapOverlay({ osrsClient }: { osrsClient: OsrsClient }) {
    const [status, setStatus] = useState<MapStatus | null>(null);
    const [selected, setSelected] = useState<CitizenDot | null>(null);
    const [filterCat, setFilterCat] = useState<ActivityCat | "all">("all");
    const [filterKingdom, setFilterKingdom] = useState<string>("all");
    const [search, setSearch] = useState("");
    const [flash, setFlash] = useState<string | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const statusRef = useRef<MapStatus | null>(null);
    const selectedRef = useRef<CitizenDot | null>(null);
    const filterRef = useRef({ cat: filterCat, kingdom: filterKingdom, search });
    const username = connectionState.sessionUsername;

    filterRef.current = { cat: filterCat, kingdom: filterKingdom, search };
    selectedRef.current = selected;

    const apiCall = useCallback(async (params: string): Promise<MapStatus | null> => {
        if (!username) return null;
        try {
            const data = (await fetchContent(
                `/api/admin-worldmap?player=${encodeURIComponent(username)}${params}`
            )) as MapStatus;
            return data;
        } catch {
            return null;
        }
    }, [username]);

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) { setStatus(null); return; }
        const data = await apiCall("&action=status");
        if (data) {
            statusRef.current = data;
            setStatus(data);
            // Keep selection fresh
            const sel = selectedRef.current;
            if (sel && data.citizens) {
                const fresh = data.citizens.find((c) => c.n === sel.n);
                if (fresh) setSelected(fresh);
            }
        }
    }, [username, osrsClient, apiCall]);

    useEffect(() => {
        poll();
        const id = window.setInterval(poll, 2000);
        return () => window.clearInterval(id);
    }, [poll]);

    const showFlash = useCallback((msg: string) => {
        setFlash(msg);
        window.setTimeout(() => setFlash(null), 3000);
    }, []);

    const doAction = useCallback(async (params: string) => {
        const data = await apiCall(params);
        if (data?.ok) showFlash(data.ok);
        if (data?.error) showFlash("Error: " + data.error);
        poll();
    }, [apiCall, showFlash, poll]);

    const handleClose = useCallback(async () => {
        setStatus(null);
        statusRef.current = null;
        await apiCall("&action=close");
    }, [apiCall]);

    // ---- Canvas rendering ----
    useEffect(() => {
        const canvas = canvasRef.current;
        const data = statusRef.current;
        if (!canvas || !data?.citizens) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const W = canvas.width, H = canvas.height;
        const { cat, kingdom, search: q } = filterRef.current;
        const ql = q.trim().toLowerCase();

        // Background
        ctx.fillStyle = "#0d0b08";
        ctx.fillRect(0, 0, W, H);

        // Grid
        ctx.strokeStyle = "rgba(107,90,58,0.25)";
        ctx.lineWidth = 1;
        for (let gx = 0; gx <= 10; gx++) {
            const px = (gx / 10) * W;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
        }
        for (let gy = 0; gy <= 10; gy++) {
            const py = (gy / 10) * H;
            ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
        }

        const toPx = (x: number, y: number): [number, number] => [
            ((x - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X)) * W,
            H - ((y - WORLD_MIN_Y) / (WORLD_MAX_Y - WORLD_MIN_Y)) * H,
        ];

        const sel = selectedRef.current;

        // Citizens
        for (const c of data.citizens) {
            const ccat = categoryOf(c.a);
            if (cat !== "all" && ccat !== cat) continue;
            if (kingdom !== "all" && c.k !== kingdom) continue;
            if (ql && !c.n.toLowerCase().includes(ql)) continue;
            const [px, py] = toPx(c.x, c.y);
            const isSel = sel?.n === c.n;
            const r = c.o === 1 ? (isSel ? 6 : 3.5) : (isSel ? 5 : 2.5);
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fillStyle = CAT_COLORS[ccat];
            if (c.o !== 1) ctx.globalAlpha = 0.45;
            if (c.b === 1) ctx.fillStyle = "#ffffff"; // brain paused = white
            ctx.fill();
            ctx.globalAlpha = 1;
            if (isSel) {
                ctx.strokeStyle = "#c9a227";
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }

        // Real players (gold diamonds), bots (hollow)
        for (const p of data.players || []) {
            const [px, py] = toPx(p.x, p.y);
            const isMe = p.n.toLowerCase() === (connectionState.sessionUsername || "").toLowerCase();
            ctx.beginPath();
            const s = isMe ? 8 : 5;
            ctx.moveTo(px, py - s); ctx.lineTo(px + s, py);
            ctx.lineTo(px, py + s); ctx.lineTo(px - s, py);
            ctx.closePath();
            if (p.bot === 1) {
                ctx.strokeStyle = "#c9a227"; ctx.lineWidth = 1.5; ctx.stroke();
            } else {
                ctx.fillStyle = isMe ? "#ffd700" : "#c9a227";
                ctx.fill();
                if (isMe) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
            }
        }
    });

    const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        const data = statusRef.current;
        if (!canvas || !data?.citizens) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;
        const { cat, kingdom, search: q } = filterRef.current;
        const ql = q.trim().toLowerCase();

        let best: CitizenDot | null = null;
        let bestDist = 12;
        for (const c of data.citizens) {
            const ccat = categoryOf(c.a);
            if (cat !== "all" && ccat !== cat) continue;
            if (kingdom !== "all" && c.k !== kingdom) continue;
            if (ql && !c.n.toLowerCase().includes(ql)) continue;
            const px = ((c.x - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X)) * canvas.width;
            const py = canvas.height - ((c.y - WORLD_MIN_Y) / (WORLD_MAX_Y - WORLD_MIN_Y)) * canvas.height;
            const d = Math.hypot(px - mx, py - my);
            if (d < bestDist) { bestDist = d; best = c; }
        }
        setSelected(best);
    }, []);

    if (!status?.open) return null;

    const citizens = status.citizens || [];
    const kingdoms = [...new Set(citizens.map((c) => c.k).filter(Boolean))] as string[];
    const counts: Record<string, number> = {};
    for (const c of citizens) {
        const cc = categoryOf(c.a);
        counts[cc] = (counts[cc] || 0) + 1;
    }

    return (
        <div className="tma-adminmap-backdrop">
            <div className="tma-adminmap-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-adminmap-close" onClick={handleClose} aria-label="Close">✕</button>
                <p className="tma-adminmap-kicker">Administrator</p>
                <h2 className="tma-adminmap-name">World Map — Live Citizens</h2>
                <div className="tma-adminmap-header-rule" />
                {flash && <div className="tma-adminmap-flash">{flash}</div>}

                <div className="tma-adminmap-toolbar">
                    <input
                        className="tma-adminmap-search"
                        placeholder="Search citizen…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    <select value={filterCat} onChange={(e) => setFilterCat(e.target.value as ActivityCat | "all")}>
                        <option value="all">All activities</option>
                        {(Object.keys(CAT_LABELS) as ActivityCat[]).map((cc) => (
                            <option key={cc} value={cc}>{CAT_LABELS[cc]} ({counts[cc] || 0})</option>
                        ))}
                    </select>
                    <select value={filterKingdom} onChange={(e) => setFilterKingdom(e.target.value)}>
                        <option value="all">All kingdoms</option>
                        {kingdoms.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                </div>

                <div className="tma-adminmap-legend">
                    {(Object.keys(CAT_COLORS) as ActivityCat[]).map((cc) => (
                        <span key={cc} className="tma-adminmap-legend-item">
                            <span className="tma-adminmap-dot" style={{ background: CAT_COLORS[cc] }} />
                            {CAT_LABELS[cc]}
                        </span>
                    ))}
                    <span className="tma-adminmap-legend-item">
                        <span className="tma-adminmap-diamond" /> You / players
                    </span>
                </div>

                <div className="tma-adminmap-body">
                    <canvas
                        ref={canvasRef}
                        className="tma-adminmap-canvas"
                        width={900}
                        height={700}
                        onClick={handleCanvasClick}
                    />
                    <div className="tma-adminmap-side">
                        {selected ? (
                            <div className="tma-adminmap-detail">
                                <h3>{selected.n}</h3>
                                <dl>
                                    <dt>Activity</dt><dd>{selected.a || "—"} <span className="tma-adminmap-cat" style={{ color: CAT_COLORS[categoryOf(selected.a)] }}>{CAT_LABELS[categoryOf(selected.a)]}</span></dd>
                                    <dt>Goal</dt><dd>{selected.g || "—"}</dd>
                                    <dt>Kingdom</dt><dd>{selected.k || "—"}</dd>
                                    <dt>Role</dt><dd>{selected.p || "—"}</dd>
                                    <dt>Location</dt><dd>{selected.x}, {selected.y}, {selected.z}</dd>
                                    <dt>Materialized</dt><dd>{selected.o === 1 ? "Yes" : "No (data tier)"}</dd>
                                    <dt>Brain</dt><dd>{selected.b === 1 ? "⏸ Paused" : "▶ Running"}</dd>
                                    <dt>Last tick</dt><dd>{selected.t < 0 ? "never" : selected.t + "s ago"}</dd>
                                </dl>
                                <div className="tma-adminmap-actions">
                                    <button onClick={() => doAction(`&action=teleport&target=${encodeURIComponent(selected.n)}`)}>
                                        Teleport to
                                    </button>
                                    <button onClick={() => doAction(`&action=toggle-brain&target=${encodeURIComponent(selected.n)}`)}>
                                        {selected.b === 1 ? "Resume brain" : "Pause brain"}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="tma-adminmap-hint">
                                <p>Click a dot to inspect a citizen.</p>
                                <p className="tma-adminmap-stats">
                                    {status.stats?.roster ?? citizens.length} citizens ·{" "}
                                    {status.stats?.online ?? 0} materialized
                                </p>
                            </div>
                        )}
                    </div>
                </div>
                <p className="tma-adminmap-footnote">Every life is a full game.</p>
            </div>
        </div>
    );
}
