import type { Dispatch, SetStateAction } from "react";

import { timeAgo } from "./useShop";
import type { ShopStatus } from "./useShop";

/**
 * The marketplace content — market board, stall management, and browsing —
 * shared by the in-game overlay (modal frame) and the sidebar Stalls tab
 * (rail panel). Chrome (backdrop, close button) belongs to the wrappers;
 * this is only what both doors show.
 */
export function ShopView({
    status,
    banner,
    qty,
    setQty,
    price,
    setPrice,
    collect,
    setCollect,
    go,
    mutate,
    qtyFor,
}: {
    status: ShopStatus;
    banner: string | null;
    qty: Record<string, string>;
    setQty: Dispatch<SetStateAction<Record<string, string>>>;
    price: Record<string, string>;
    setPrice: Dispatch<SetStateAction<Record<string, string>>>;
    collect: string;
    setCollect: Dispatch<SetStateAction<string>>;
    go: (view: "board" | "manage" | "browse", owner?: string) => void;
    mutate: (extra: string) => Promise<void>;
    qtyFor: (key: string) => number;
}): JSX.Element {
    const view = status.view ?? "board";

    return (
        <>
            <p className="tma-shop-kicker">The Marketplace</p>
            {view === "board" && <h2 className="tma-shop-name">Market Board</h2>}
            {view === "manage" && (
                <h2 className="tma-shop-name">{status.stall?.owner ?? "Your"}&rsquo;s Stall</h2>
            )}
            {view === "browse" && (
                <h2 className="tma-shop-name">{status.stall?.owner ?? "A"}&rsquo;s Stall</h2>
            )}
            {status.stall && (
                <p className="tma-shop-byline">
                    {status.stall.kingdomName}
                    {status.stall.employee ? ` · minded by ${status.stall.employee}` : ""}
                </p>
            )}
            <div className="tma-shop-header-rule" />

            {banner && <div className="tma-shop-banner">{banner}</div>}

            <div className="tma-shop-scroll">
                {view === "board" && <BoardView status={status} go={go} mutate={mutate} />}
                {view === "manage" && (
                    <ManageView
                        status={status}
                        go={go}
                        mutate={mutate}
                        qty={qty}
                        setQty={setQty}
                        price={price}
                        setPrice={setPrice}
                        collect={collect}
                        setCollect={setCollect}
                    />
                )}
                {view === "browse" && (
                    <BrowseView
                        status={status}
                        go={go}
                        mutate={mutate}
                        qty={qty}
                        setQty={setQty}
                        qtyFor={qtyFor}
                    />
                )}
            </div>

            <p className="tma-shop-footnote">Every life is a full game.</p>
        </>
    );
}

function BoardView({
    status,
    go,
    mutate,
}: {
    status: ShopStatus;
    go: (view: "board" | "manage" | "browse", owner?: string) => void;
    mutate: (extra: string) => Promise<void>;
}): JSX.Element {
    return (
        <>
            <section className="tma-shop-section">
                <h3 className="tma-shop-section-title">Your Stall</h3>
                <div className="tma-shop-inset">
                    {status.hasStall && status.myStall ? (
                        <div className="tma-shop-mystall">
                            <div>
                                <p className="tma-shop-mystall-line">
                                    {status.myStall.kingdomName} ·{" "}
                                    <span className="tma-shop-gold">{status.myStall.till} coins</span>{" "}
                                    in the till
                                </p>
                                <p className="tma-shop-mystall-sub">
                                    {status.myStall.employee
                                        ? `Minded by ${status.myStall.employee}`
                                        : "No hand hired — the stall only trades while you're about"}
                                </p>
                            </div>
                            <button
                                className="tma-shop-button"
                                onClick={() => go("manage")}
                            >
                                Manage
                            </button>
                        </div>
                    ) : (
                        <>
                            <p className="tma-shop-empty">
                                No stall yet — lease a pitch in a kingdom&rsquo;s market.
                            </p>
                            {(status.kingdoms ?? []).map((k) => (
                                <div key={k.id} className="tma-shop-row">
                                    <div className="tma-shop-row-main">
                                        <span className="tma-shop-row-name">{k.name}</span>
                                        <span className="tma-shop-row-sub">
                                            {k.upfront} coins down · {k.weeklyRent}/week rent
                                        </span>
                                    </div>
                                    <button
                                        className="tma-shop-button"
                                        onClick={() =>
                                            mutate(`&do=lease&kingdom=${encodeURIComponent(k.id)}`)
                                        }
                                    >
                                        Lease
                                    </button>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </section>

            <section className="tma-shop-section">
                <h3 className="tma-shop-section-title">Stalls Open for Trade</h3>
                <div className="tma-shop-inset">
                    {(status.stalls ?? []).length === 0 && (
                        <p className="tma-shop-empty">
                            No player owns a stall yet — be the first to set up shop.
                        </p>
                    )}
                    {(status.stalls ?? []).map((s) => (
                        <div key={s.owner} className="tma-shop-row">
                            <div className="tma-shop-row-main">
                                <span className="tma-shop-row-name">
                                    {s.owner}
                                    {s.mine && <span className="tma-shop-tag">yours</span>}
                                </span>
                                <span className="tma-shop-row-sub">
                                    {s.kingdomName} · {s.wares} ware{s.wares === 1 ? "" : "s"} ·{" "}
                                    {s.open ? (
                                        <span className="tma-shop-open">open</span>
                                    ) : (
                                        <span className="tma-shop-closed">closed</span>
                                    )}
                                </span>
                            </div>
                            <button
                                className="tma-shop-button"
                                disabled={!s.open}
                                onClick={() => go("browse", s.owner)}
                            >
                                Browse
                            </button>
                        </div>
                    ))}
                </div>
            </section>
        </>
    );
}

function ManageView({
    status,
    go,
    mutate,
    qty,
    setQty,
    price,
    setPrice,
    collect,
    setCollect,
}: {
    status: ShopStatus;
    go: (view: "board" | "manage" | "browse", owner?: string) => void;
    mutate: (extra: string) => Promise<void>;
    qty: Record<string, string>;
    setQty: Dispatch<SetStateAction<Record<string, string>>>;
    price: Record<string, string>;
    setPrice: Dispatch<SetStateAction<Record<string, string>>>;
    collect: string;
    setCollect: Dispatch<SetStateAction<string>>;
}): JSX.Element {
    const stall = status.stall;
    const wares = status.wares ?? [];
    return (
        <>
            <button className="tma-shop-backlink" onClick={() => go("board")}>
                ← Market board
            </button>

            <section className="tma-shop-section">
                <h3 className="tma-shop-section-title">Wares on the Stall</h3>
                <div className="tma-shop-inset">
                    {wares.length === 0 && (
                        <p className="tma-shop-empty">
                            Nothing stocked — pick goods from your pack below.
                        </p>
                    )}
                    {wares.map((w) => (
                        <div key={w.id} className="tma-shop-row">
                            <div className="tma-shop-row-main">
                                <span className="tma-shop-row-name">{w.name}</span>
                                <span className="tma-shop-row-sub">
                                    {w.stock} in stock ·{" "}
                                    <span className="tma-shop-gold">{w.price} coins</span> each
                                </span>
                            </div>
                            <input
                                className="tma-shop-input tma-shop-input-narrow"
                                value={price[`p${w.id}`] ?? String(w.price)}
                                onChange={(e) =>
                                    setPrice((p) => ({ ...p, [`p${w.id}`]: e.target.value }))
                                }
                                inputMode="numeric"
                                aria-label={`Price for ${w.name}`}
                            />
                            <button
                                className="tma-shop-button tma-shop-button-small"
                                onClick={() =>
                                    mutate(
                                        `&do=price&item=${w.id}&price=${encodeURIComponent(
                                            price[`p${w.id}`] ?? String(w.price)
                                        )}`
                                    )
                                }
                            >
                                Set
                            </button>
                            <input
                                className="tma-shop-input tma-shop-input-narrow"
                                value={qty[`u${w.id}`] ?? ""}
                                placeholder="all"
                                onChange={(e) =>
                                    setQty((q) => ({ ...q, [`u${w.id}`]: e.target.value }))
                                }
                                inputMode="numeric"
                                aria-label={`Take back quantity of ${w.name}`}
                            />
                            <button
                                className="tma-shop-button tma-shop-button-small tma-shop-button-muted"
                                onClick={() => {
                                    const raw = (qty[`u${w.id}`] ?? "").trim();
                                    mutate(
                                        `&do=unstock&item=${w.id}${raw ? `&qty=${encodeURIComponent(raw)}` : ""}`
                                    );
                                }}
                            >
                                Take
                            </button>
                        </div>
                    ))}
                    {wares.length > 0 && wares.length < (status.maxWares ?? 4) && (
                        <p className="tma-shop-hint">
                            Room for {(status.maxWares ?? 4) - wares.length} more ware
                            {(status.maxWares ?? 4) - wares.length === 1 ? "" : "s"}.
                        </p>
                    )}
                </div>
            </section>

            <section className="tma-shop-section">
                <h3 className="tma-shop-section-title">From Your Pack</h3>
                <div className="tma-shop-inset">
                    {(status.inventory ?? []).length === 0 && (
                        <p className="tma-shop-empty">Your pack holds nothing worth selling.</p>
                    )}
                    {(status.inventory ?? []).map((item) => (
                        <div key={item.id} className="tma-shop-row">
                            <div className="tma-shop-row-main">
                                <span className="tma-shop-row-name">{item.name}</span>
                                <span className="tma-shop-row-sub">carrying {item.qty}</span>
                            </div>
                            <input
                                className="tma-shop-input tma-shop-input-narrow"
                                value={qty[`s${item.id}`] ?? ""}
                                placeholder="all"
                                onChange={(e) =>
                                    setQty((q) => ({ ...q, [`s${item.id}`]: e.target.value }))
                                }
                                inputMode="numeric"
                                aria-label={`Stock quantity of ${item.name}`}
                            />
                            <button
                                className="tma-shop-button tma-shop-button-small"
                                onClick={() => {
                                    const raw = (qty[`s${item.id}`] ?? "").trim();
                                    mutate(
                                        `&do=stock&item=${item.id}${raw ? `&qty=${encodeURIComponent(raw)}` : ""}`
                                    );
                                }}
                            >
                                Stock
                            </button>
                        </div>
                    ))}
                </div>
            </section>

            <div className="tma-shop-columns">
                <section className="tma-shop-section">
                    <h3 className="tma-shop-section-title">Till</h3>
                    <div className="tma-shop-inset">
                        <p className="tma-shop-till">
                            <span className="tma-shop-gold">{stall?.till ?? 0}</span> coins
                        </p>
                        <div className="tma-shop-inline">
                            <input
                                className="tma-shop-input tma-shop-input-narrow"
                                value={collect}
                                onChange={(e) => setCollect(e.target.value)}
                                inputMode="numeric"
                                aria-label="Coins to collect"
                                placeholder="all"
                            />
                            <button
                                className="tma-shop-button tma-shop-button-small"
                                onClick={() =>
                                    mutate(
                                        `&do=collect${collect.trim() ? `&amount=${encodeURIComponent(collect.trim())}` : ""}`
                                    )
                                }
                            >
                                Collect
                            </button>
                        </div>
                        <p className="tma-shop-hint">
                            Rent {stall?.weeklyRent ?? 0}/week · the crown takes{" "}
                            {Math.round((stall?.taxRate ?? 0.05) * 100)}% of every sale.
                        </p>
                        {(status.returns ?? []).length > 0 && (
                            <>
                                <p className="tma-shop-hint">Waiting to be claimed:</p>
                                {(status.returns ?? []).map((r) => (
                                    <p key={r.id} className="tma-shop-row-sub">
                                        {r.qty} x {r.name}
                                    </p>
                                ))}
                                <button
                                    className="tma-shop-button tma-shop-button-small"
                                    onClick={() => mutate("&do=claim")}
                                >
                                    Claim all
                                </button>
                            </>
                        )}
                    </div>
                </section>

                <section className="tma-shop-section">
                    <h3 className="tma-shop-section-title">Shop Hand</h3>
                    <div className="tma-shop-inset">
                        {stall?.employee ? (
                            <>
                                <p className="tma-shop-row-name">{stall.employee}</p>
                                <p className="tma-shop-row-sub">
                                    {stall.dailyWage} coins a day, from the till
                                </p>
                                <button
                                    className="tma-shop-button tma-shop-button-small tma-shop-button-muted"
                                    onClick={() => mutate("&do=fire")}
                                >
                                    Let go
                                </button>
                            </>
                        ) : (
                            <>
                                <p className="tma-shop-empty">
                                    No hand hired — your stall only trades while you&rsquo;re
                                    about.
                                </p>
                                {(status.hireCandidates ?? []).map((name) => (
                                    <div key={name} className="tma-shop-inline">
                                        <span className="tma-shop-row-name">{name}</span>
                                        <button
                                            className="tma-shop-button tma-shop-button-small"
                                            onClick={() =>
                                                mutate(`&do=hire&name=${encodeURIComponent(name)}`)
                                            }
                                        >
                                            Hire
                                        </button>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </section>
            </div>

            <section className="tma-shop-section">
                <h3 className="tma-shop-section-title">Recent Sales</h3>
                <div className="tma-shop-inset">
                    {(status.sales ?? []).length === 0 && (
                        <p className="tma-shop-empty">No sales yet — stock the stall and spread the word.</p>
                    )}
                    {(status.sales ?? []).map((s, i) => (
                        <p key={`${s.at}-${i}`} className="tma-shop-sale">
                            <span className="tma-shop-gold">◆</span> {s.qty} x {s.name} →{" "}
                            <span className="tma-shop-gold">{s.total} coins</span>
                            <span className="tma-shop-row-sub">
                                {" "}
                                · {s.buyer} · {timeAgo(s.at)}
                            </span>
                        </p>
                    ))}
                </div>
            </section>

            <button
                className="tma-shop-danger"
                onClick={() => {
                    if (window.confirm("Give up your stall? Stock and till will wait for you to claim.")) {
                        void mutate("&do=close-stall");
                    }
                }}
            >
                Give up the stall
            </button>
        </>
    );
}

function BrowseView({
    status,
    go,
    mutate,
    qty,
    setQty,
    qtyFor,
}: {
    status: ShopStatus;
    go: (view: "board" | "manage" | "browse", owner?: string) => void;
    mutate: (extra: string) => Promise<void>;
    qty: Record<string, string>;
    setQty: Dispatch<SetStateAction<Record<string, string>>>;
    qtyFor: (key: string) => number;
}): JSX.Element {
    const wares = status.wares ?? [];
    return (
        <>
            <button className="tma-shop-backlink" onClick={() => go("board")}>
                ← Market board
            </button>

            <section className="tma-shop-section">
                <h3 className="tma-shop-section-title">Wares</h3>
                <div className="tma-shop-inset">
                    {wares.length === 0 && (
                        <p className="tma-shop-empty">Nothing on the stall right now.</p>
                    )}
                    {wares.map((w) => (
                        <div key={w.id} className="tma-shop-row">
                            <div className="tma-shop-row-main">
                                <span className="tma-shop-row-name">{w.name}</span>
                                <span className="tma-shop-row-sub">
                                    <span className="tma-shop-gold">{w.price} coins</span> each ·{" "}
                                    {w.stock > 0 ? `${w.stock} in stock` : "sold out"}
                                </span>
                            </div>
                            <input
                                className="tma-shop-input tma-shop-input-narrow"
                                value={qty[`b${w.id}`] ?? "1"}
                                onChange={(e) =>
                                    setQty((q) => ({ ...q, [`b${w.id}`]: e.target.value }))
                                }
                                inputMode="numeric"
                                aria-label={`Buy quantity of ${w.name}`}
                            />
                            <button
                                className="tma-shop-button"
                                disabled={w.stock <= 0}
                                onClick={() =>
                                    mutate(
                                        `&do=buy&owner=${encodeURIComponent(status.stall?.owner ?? "")}&item=${w.id}&qty=${qtyFor(`b${w.id}`)}`
                                    )
                                }
                            >
                                Buy
                            </button>
                        </div>
                    ))}
                </div>
            </section>

            <p className="tma-shop-hint">
                Profits land in the owner&rsquo;s till · 5% market tax goes to the crown.
            </p>
        </>
    );
}
