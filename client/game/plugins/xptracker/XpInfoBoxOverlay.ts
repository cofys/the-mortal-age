import { OverlayPosition } from "@runelite/client/ui/overlay/OverlayPosition";
import { skillIconSprite } from "../../../rs/skill/skillIcons";
import { MAX_XP, SKILL_NAME, type SkillId } from "../../../rs/skill/skills";
import { FONT_PLAIN_11 } from "../../../ui/fonts";
import { drawTextGL } from "../../../widgets/components/TextRenderer";
import type { WidgetOverlay, WidgetOverlayDrawContext } from "../ClientPluginManager";
import { XP_PANEL_LABELS } from "./XpTrackerConfig";
import { panelLabelValue } from "./xpState";
import { skillColor } from "./skillColor";
import type { XpTrackerPlugin } from "./XpTrackerPlugin";

type Rgba = [number, number, number, number];
type Rect = { x: number; y: number; w: number; h: number };

const rgba = (r: number, g: number, b: number, a = 255): Rgba => [r / 255, g / 255, b / 255, a / 255];
/** RuneLite's ComponentConstants.STANDARD_BACKGROUND_COLOR and the panel outline. */
const BACKGROUND = rgba(70, 61, 50, 156);
const OUTLINE = rgba(56, 48, 35, 255);
const BAR_BACKGROUND = rgba(61, 56, 49);
const STANDARD_WIDTH = 129;
const BORDER = 2;
const XP_AND_PROGRESS_BAR_GAP = 2;
const XP_AND_ICON_GAP = 4;
/** XP_AND_ICON_COMPONENT_BORDER = Rectangle(2, 1, 4, 0): left, top, right, bottom. */
const ICON_PANEL = { left: 2, top: 1, right: 4, bottom: 0 };
const LINE_HEIGHT = 13;
const ICON_SIZE = 17;
const BAR_HEIGHT = 16;
const SIDE_LABEL_OFFSET = 4;
const WHITE = 0xffffff;

/**
 * One skill's canvas box (RuneLite's XpInfoBoxOverlay): the skill icon beside two configured
 * lines, over a progress bar from the start level to the goal. Alt-drag moves it; each skill's
 * box keeps its own position.
 */
export class XpInfoBoxOverlay implements WidgetOverlay {
    readonly movable: WidgetOverlay["movable"];

    constructor(
        private readonly plugin: XpTrackerPlugin,
        readonly skill: SkillId,
    ) {
        this.movable = { name: `XpInfoBoxOverlay${SKILL_NAME[skill]}`, position: OverlayPosition.TOP_LEFT };
    }

    private lines(): [string, string, string, string] | undefined {
        const snapshot = this.plugin.getSkillSnapshot(this.skill);
        if (!snapshot) return undefined;
        const top = this.plugin.config.onScreenDisplayMode();
        const bottom = this.plugin.config.onScreenDisplayModeBottom();
        return [
            `${XP_PANEL_LABELS[top as keyof typeof XP_PANEL_LABELS] ?? top}:`, panelLabelValue(top, snapshot),
            `${XP_PANEL_LABELS[bottom as keyof typeof XP_PANEL_LABELS] ?? bottom}:`, panelLabelValue(bottom, snapshot),
        ];
    }

    private bar(): { left: string; right: string; center: string; ratio: number } | undefined {
        const snapshot = this.plugin.getSkillSnapshot(this.skill);
        if (!snapshot) return undefined;
        const ratio = snapshot.skillProgressToGoal / 100;
        return {
            left: String(snapshot.startLevel),
            right: snapshot.endGoalXp === MAX_XP ? "200M" : String(snapshot.endLevel),
            // ProgressBarComponent's PERCENTAGE label: "0.0%".
            center: `${(ratio * 100).toFixed(1)}%`,
            ratio,
        };
    }

    signature(): string {
        const lines = this.lines();
        const bar = this.bar();
        if (!lines || !bar) return "";
        return JSON.stringify([lines, bar.left, bar.right, bar.center]);
    }

    draw(context: WidgetOverlayDrawContext): Rect[] {
        const lines = this.lines();
        const bar = this.bar();
        if (!lines || !bar) return [];
        const iconPanelHeight = ICON_PANEL.top + 2 * LINE_HEIGHT + ICON_PANEL.bottom;
        const width = STANDARD_WIDTH;
        const height = 2 * BORDER + iconPanelHeight + XP_AND_PROGRESS_BAR_GAP + BAR_HEIGHT;
        const at = context.place(this, width, height);
        if (!at) return [];
        const { scaleX: sx, scaleY: sy } = at;
        const glr = context.renderer;
        const r = { x: at.x, y: at.y, w: width * sx, h: height * sy };

        glr.drawRect(r.x, r.y, r.w, r.h, BACKGROUND);
        glr.drawRect(r.x, r.y, r.w, sy, OUTLINE);
        glr.drawRect(r.x, r.y + r.h - sy, r.w, sy, OUTLINE);
        glr.drawRect(r.x, r.y + sy, sx, r.h - 2 * sy, OUTLINE);
        glr.drawRect(r.x + r.w - sx, r.y + sy, sx, r.h - 2 * sy, OUTLINE);

        // Icon, then the two lines beside it.
        const panelX = r.x + (BORDER + ICON_PANEL.left) * sx;
        const panelY = r.y + (BORDER + ICON_PANEL.top) * sy;
        const icon = context.sprite(skillIconSprite(this.skill));
        if (icon) {
            const fit = Math.min(ICON_SIZE / icon.w, ICON_SIZE / icon.h);
            const iw = icon.w * fit * sx;
            const ih = icon.h * fit * sy;
            glr.drawTexture(icon, panelX, panelY + (2 * LINE_HEIGHT * sy - ih) / 2, iw, ih);
        }
        const textX = panelX + (ICON_SIZE + XP_AND_ICON_GAP) * sx;
        const textW = r.x + r.w - (BORDER + ICON_PANEL.right) * sx - textX;
        const lineH = LINE_HEIGHT * sy;
        for (let i = 0; i < 2; i++) {
            const y = panelY + i * lineH;
            this.text(context, lines[i * 2], textX, y, textW, lineH, 0, sx, sy);
            this.text(context, lines[i * 2 + 1], textX, y, textW, lineH, 2, sx, sy);
        }

        // ProgressBarComponent: skill colour over the bar background, labels on top.
        const barX = r.x + BORDER * sx;
        const barY = panelY - ICON_PANEL.top * sy + iconPanelHeight * sy + XP_AND_PROGRESS_BAR_GAP * sy;
        const barW = (width - 2 * BORDER) * sx;
        const barH = BAR_HEIGHT * sy;
        const filled = Math.trunc(barW * Math.max(0, Math.min(1, bar.ratio)));
        glr.drawRect(barX + filled, barY, barW - filled, barH, BAR_BACKGROUND);
        if (filled > 0) glr.drawRect(barX, barY, filled, barH, skillColor(this.skill));
        this.text(context, bar.center, barX, barY, barW, barH, 1, sx, sy);
        const side = SIDE_LABEL_OFFSET * sx;
        this.text(context, bar.left, barX + side, barY, barW - 2 * side, barH, 0, sx, sy);
        this.text(context, bar.right, barX + side, barY, barW - 2 * side, barH, 2, sx, sy);
        return [r];
    }

    private text(context: WidgetOverlayDrawContext, text: string, x: number, y: number, w: number, h: number,
        xAlign: number, sx: number, sy: number): void {
        drawTextGL(context.renderer, context.fontLoader, text, x, y, w, h, FONT_PLAIN_11, WHITE, xAlign, 1, true,
            1, undefined, sx, sy);
    }
}
