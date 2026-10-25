import { useEffect, useMemo, useState } from "react";

import {
    type ConfigGroupDescriptor,
    type ConfigItemDef,
    type ConfigSectionDef,
} from "@runelite/client/config/ConfigItem";
import { parseConfigValue } from "@runelite/client/config/ConfigManager";
import { Keybind } from "@runelite/client/config/Keybind";
import type { ConfigManager } from "@runelite/client/config/ConfigManager";

const DEFAULT_SECTION = "";

type OrderedItem = {
    property: string;
    item: ConfigItemDef;
    section: string;
};

function toColorInput(value: unknown): string {
    const color = Number(value) >>> 0;
    const hex = (color & 0xffffff).toString(16).padStart(6, "0");
    return `#${hex}`;
}

function orderItems(descriptor: ConfigGroupDescriptor): OrderedItem[] {
    const items = Object.entries(descriptor.items)
        .filter(([, item]) => !item.hidden)
        .map(([property, item], index) => ({
            property,
            item,
            section: item.section ?? DEFAULT_SECTION,
            index,
        }));
    items.sort((a, b) => {
        const sectionA = a.section === DEFAULT_SECTION ? -1 : descriptor.sections?.[a.section]?.position ?? 0;
        const sectionB = b.section === DEFAULT_SECTION ? -1 : descriptor.sections?.[b.section]?.position ?? 0;
        if (sectionA !== sectionB) return sectionA - sectionB;
        const positionA = a.item.position ?? a.index;
        const positionB = b.item.position ?? b.index;
        return positionA - positionB;
    });
    return items.map(({ property, item, section }) => ({ property, item, section }));
}

function groupBySection(
    descriptor: ConfigGroupDescriptor,
    items: OrderedItem[],
): Array<{ id: string; section?: ConfigSectionDef; items: OrderedItem[] }> {
    const groups: Array<{ id: string; section?: ConfigSectionDef; items: OrderedItem[] }> = [];
    for (const entry of items) {
        let group = groups.find((candidate) => candidate.id === entry.section);
        if (!group) {
            group = {
                id: entry.section,
                section: entry.section === DEFAULT_SECTION ? undefined : descriptor.sections?.[entry.section],
                items: [],
            };
            groups.push(group);
        }
        group.items.push(entry);
    }
    return groups;
}

function ConfigField({
    descriptor,
    property,
    item,
    configManager,
}: {
    descriptor: ConfigGroupDescriptor;
    property: string;
    item: ConfigItemDef;
    configManager: ConfigManager;
}): JSX.Element {
    const key = item.keyName ?? property;
    const raw = configManager.getConfiguration(descriptor.group, key);
    const value = parseConfigValue(item, raw ?? null);
    const update = (next: unknown) => configManager.setConfigValue(descriptor, property, next);
    const label = (
        <span className="rl-config-label">
            <span>{item.name}</span>
            {item.description ? (
                <span className="rl-config-description">{item.description}</span>
            ) : null}
            {item.warning ? <span className="rl-config-warning">{item.warning}</span> : null}
        </span>
    );

    if (item.enum) {
        const enumEntries = Object.entries(item.enum);
        const selectedName =
            enumEntries.find(
                ([, enumValue]) =>
                    enumValue === value || String(enumValue) === String(value),
            )?.[0] ?? String(value);
        return (
            <label className="rl-sidebar-field">
                {label}
                <select
                    value={selectedName}
                    onChange={(event) => {
                        const entry = enumEntries.find(([name]) => name === event.target.value);
                        update(entry ? entry[1] : event.target.value);
                    }}
                >
                    {enumEntries.map(([name]) => (
                        <option key={name} value={name}>
                            {item.enumLabels?.[name] ?? name}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    if (item.keybind) {
        return (
            <label className="rl-sidebar-field">
                {label}
                <KeybindButton value={value instanceof Keybind ? value : Keybind.NOT_SET} onChange={update} />
            </label>
        );
    }

    if (typeof item.default === "boolean") {
        return (
            <label className="rl-sidebar-check">
                <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) => update(event.target.checked)}
                />
                {label}
            </label>
        );
    }

    if (item.color) {
        // RuneLite's @Alpha colours: no alpha bits means opaque.
        const argb = Number(value) >>> 0;
        const alpha = item.alpha ? (argb >>> 24) || 255 : 255;
        const withAlpha = (rgb: number, a: number) =>
            item.alpha ? ((a & 0xff) << 24 | (rgb & 0xffffff)) >>> 0 : rgb & 0xffffff;
        return (
            <div className="rl-sidebar-row rl-sidebar-value-row">
                <label className="rl-sidebar-field">{label}</label>
                <input
                    className="rl-sidebar-color-input"
                    type="color"
                    value={toColorInput(argb & 0xffffff)}
                    onChange={(event) => {
                        const color = parseInt(event.target.value.slice(1), 16) || 0;
                        update(withAlpha(color, alpha));
                    }}
                />
                {item.alpha && (
                    <input
                        className="rl-sidebar-alpha-input"
                        type="range"
                        min={1}
                        max={255}
                        aria-label={`${label} alpha`}
                        title={`Alpha ${alpha}`}
                        value={alpha}
                        onChange={(event) => update(withAlpha(argb, Number(event.target.value)))}
                    />
                )}
            </div>
        );
    }

    if (typeof item.default === "number") {
        return (
            <label className="rl-sidebar-field">
                {label}
                <input
                    type="number"
                    min={item.range?.min}
                    max={item.range?.max}
                    step={item.step}
                    value={Number(value)}
                    onChange={(event) => {
                        const numeric = Number(event.target.value);
                        update(Number.isFinite(numeric) ? numeric : item.default);
                    }}
                />
                {item.units ? <span className="rl-config-units">{item.units}</span> : null}
            </label>
        );
    }

    if (item.textArea) {
        return (
            <label className="rl-sidebar-field">
                {label}
                <textarea
                    className="rl-sidebar-textarea"
                    rows={3}
                    value={String(value)}
                    onChange={(event) => update(event.target.value)}
                />
            </label>
        );
    }

    return (
        <label className="rl-sidebar-field">
            {label}
            <input
                type={item.secret ? "password" : "text"}
                value={String(value)}
                onChange={(event) => update(event.target.value)}
            />
        </label>
    );
}

/**
 * RuneLite's HotkeyButton: click, then press the key (with any modifiers) to bind it. Escape
 * cancels; Backspace or Delete clears it to "Not set".
 */
function KeybindButton({ value, onChange }: { value: Keybind; onChange: (next: Keybind) => void }): JSX.Element {
    const [listening, setListening] = useState(false);
    return (
        <button
            type="button"
            className="rl-sidebar-keybind"
            onClick={() => setListening(true)}
            onBlur={() => setListening(false)}
            onKeyDown={(event) => {
                if (!listening) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") {
                    setListening(false);
                    return;
                }
                if (event.key === "Backspace" || event.key === "Delete") {
                    onChange(Keybind.NOT_SET);
                } else {
                    onChange(Keybind.fromEvent(event.nativeEvent));
                }
                setListening(false);
            }}
        >
            {listening ? "Press a key…" : value.describe()}
        </button>
    );
}

export function ConfigPanel({
    descriptor,
    configManager,
    title,
}: {
    descriptor: ConfigGroupDescriptor;
    configManager: ConfigManager;
    title?: string;
}): JSX.Element {
    const [, setVersion] = useState(0);

    useEffect(() => {
        return configManager.addListener((event) => {
            if (event.getGroup() === descriptor.group) setVersion((version) => version + 1);
        });
    }, [configManager, descriptor]);

    const groups = useMemo(() => groupBySection(descriptor, orderItems(descriptor)), [descriptor]);
    // Sections fold like RuneLite's: closed at first when `closedByDefault`.
    const [closed, setClosed] = useState<ReadonlySet<string>>(() => {
        const sections = Object.entries(descriptor.sections ?? {});
        return new Set(sections.filter(([, section]) => section.closedByDefault).map(([id]) => id));
    });
    const toggleSection = (id: string): void =>
        setClosed((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });

    return (
        <div className="rl-config-panel">
            {title ? <div className="rl-sidebar-panel-title">{title}</div> : null}
            {groups.map((group, index) => (
                <div key={group.id || `section-${index}`}>
                    {group.section ? (
                        <button
                            type="button"
                            className={
                                closed.has(group.id)
                                    ? "rl-config-section-title closed"
                                    : "rl-config-section-title"
                            }
                            aria-expanded={!closed.has(group.id)}
                            onClick={() => toggleSection(group.id)}
                        >
                            {group.section.name}
                        </button>
                    ) : null}
                    {(group.section && closed.has(group.id) ? [] : group.items).map((entry) => (
                        <ConfigField
                            key={entry.property}
                            descriptor={descriptor}
                            property={entry.property}
                            item={entry.item}
                            configManager={configManager}
                        />
                    ))}
                </div>
            ))}
            {groups.length === 0 ? (
                <p className="rl-sidebar-panel-copy">This plugin has no settings.</p>
            ) : null}
        </div>
    );
}
