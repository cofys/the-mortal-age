import { createElement } from "react";

import type { NavigationIcon } from "./NavigationButton";

/**
 * The URL of one of the sidebar's images in `public/runelite/` (RuneLite's and Quest Helper's
 * resources, see its LICENSE.md). Served next to the client, so tests can name them without a
 * bundler.
 */
export function runeliteImage(file: string): string {
    const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
    return `${base}/runelite/${file}`;
}

/**
 * A sidebar icon drawn from an image, as RuneLite's `NavigationButton.icon`: scaled to the
 * toolbar's 16x16 (`ClientUI`'s `TAB_SIZE`) and kept pixel-sharp.
 */
export function imageIcon(src: string): NavigationIcon {
    return function ImageIcon({ label }: { label: string }) {
        return createElement("img", {
            className: "rl-sidebar-icon-img",
            src,
            alt: label,
            width: 16,
            height: 16,
            draggable: false,
        });
    };
}
