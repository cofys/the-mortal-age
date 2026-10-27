import Denque from "denque";
import { mat4, vec2, vec3, vec4 } from "gl-matrix";
import { button, folder } from "leva";
import { Schema } from "leva/dist/declarations/src/types";
import {
    DrawCall,
    Framebuffer,
    App as PicoApp,
    PicoGL,
    Program,
    Renderbuffer,
    Texture,
    Timer,
    UniformBuffer,
    VertexArray,
    VertexBuffer,
} from "picogl";

import {
    getClientCycle,
    getCurrentTick,
    getServerTickPhaseNow,
    isServerConnected,
    sendEmote,
    sendInteractFollow,
    sendInteractStop,
    subscribeTick,
} from "../../network/ServerConnection";
import { sendLogin } from "../../network/ServerConnection";
import { flushPackets } from "../../network/packet";
import { createTextureArray } from "../../picogl/PicoTexture";
import { RS_TO_RADIANS } from "../../rs/MathConstants";
import { CollisionFlag } from "../../common/CollisionFlag";
import {
    getWorldLocChanges,
    getWorldLocSpawns,
    getWorldTerrainOverrides,
} from "../../common/gamemode/GamemodeContentStore";
import { OsrsMenuEntry } from "../../rs/MenuEntry";
import { MenuTargetType } from "../../rs/MenuEntry";
import type { OverlayFloorType } from "../../rs/config/floortype/OverlayFloorType";
import { LocModelLoader } from "../../rs/config/loctype/LocModelLoader";
import { LocModelType } from "../../rs/config/loctype/LocModelType";
import { NpcModelLoader } from "../../rs/config/npctype/NpcModelLoader";
import { NpcDrawPriority, NpcType } from "../../rs/config/npctype/NpcType";
import { PlayerAppearance } from "../../rs/config/player/PlayerAppearance";
import { PlayerModelLoader } from "../../rs/config/player/PlayerModelLoader";
import { decodeInteractionIndex } from "../../rs/interaction/InteractionIndex";
import { getMapIndexFromTile, getMapPlaneId, getMapSquareId } from "../../rs/map/MapFileIndex";
import { Model } from "../../rs/model/Model";
import { ModelData } from "../../rs/model/ModelData";
import { Scene } from "../../rs/scene/Scene";
import { getUiScale } from "../../ui/UiScale";
import { ClickCrossOverlay } from "../../ui/devoverlay/ClickCrossOverlay";
import { GroundItemOverlay } from "../../ui/devoverlay/GroundItemOverlay";
import { HealthBarOverlay } from "../../ui/devoverlay/HealthBarOverlay";
import { HitsplatOverlay } from "../../ui/devoverlay/HitsplatOverlay";
import {
    InteractHighlightDrawTarget,
    InteractHighlightOverlay,
} from "../../ui/devoverlay/InteractHighlightOverlay";
import { LoadingMessageOverlay } from "../../ui/devoverlay/LoadingMessageOverlay";
import { LoginOverlay } from "../../ui/devoverlay/LoginOverlay";
import { OverheadPrayerOverlay } from "../../ui/devoverlay/OverheadPrayerOverlay";
import { OverheadTextOverlay } from "../../ui/devoverlay/OverheadTextOverlay";
import {
    HealthBarEntry,
    HitsplatEntry,
    OverheadPrayerEntry,
    OverheadTextEntry,
    type OverlayUpdateArgs,
    RenderPhase,
} from "../../ui/devoverlay/Overlay";
import { OverlayManager } from "../../ui/devoverlay/OverlayManager";
import type { TileMarkerOverlay } from "../../ui/devoverlay/TileMarkerOverlay";
import { TileTextOverlay } from "../../ui/devoverlay/TileTextOverlay";
import { WidgetsOverlay } from "../../ui/devoverlay/WidgetsOverlay";
import { MENU_ACTION_DEPRIORITIZE_OFFSET, MenuAction, menuAction } from "../../ui/menu/MenuAction";
import { worldEntriesToSimple } from "../../ui/menu/MenuBridge";
import type { MenuClickContext, SimpleMenuEntry } from "../../ui/menu/MenuEngine";
import { chooseDefaultMenuEntry, shouldLeftClickOpenMenu } from "../../ui/menu/MenuEngine";
import { MenuOpcode } from "../../ui/menu/MenuState";
import { Model2DRenderer } from "../../ui/model/Model2DRenderer";
import {
    canTargetGroundItem,
    canTargetNpc,
    canTargetObject,
    canTargetPlayer,
} from "../../widgets/WidgetFlags";
import { WidgetLoader } from "../../widgets/WidgetLoader";
import { WidgetManager } from "../../widgets/WidgetManager";
import { layoutWidgets } from "../../widgets/layout/WidgetLayout";
import { collectWidgetsAtPoint } from "../../widgets/menu/utils";
import {
    getCanvasCssSize,
    isIos,
    isMobileMode,
    isTouchDevice,
    isWebGL2Supported,
} from "../../common/utils/DeviceUtil";
import { clamp } from "../../common/utils/MathUtil";
import { ClientState } from "../../game/ClientState";
import { GameRenderer } from "../../game/GameRenderer";
import type { HitsplatEventPayload } from "../../game/GameRenderer";
import { OsrsRendererType, WEBGL } from "../../game/GameRenderers";
import { ClickMode, getMousePos } from "../../game/InputManager";
import { OsrsClient } from "../../game/OsrsClient";
import { ActorAnimationClip } from "../../game/actor/ActorAnimation";
import {
    ActorHealthBarsState,
    ActorHitsplatState,
    HealthBarBarState,
    HealthBarDefinitionState,
    HealthBarUpdateState,
    MAX_HITSPLAT_SLOTS,
    createActorHealthBarsState,
    createActorHitsplatState,
} from "../../game/actor/ActorOverlayState";
import type { ClientGroundItemStack, GroundItemOverlayEntry } from "../../game/data/ground/GroundItemStore";
import { NpcEcs } from "../../game/ecs/NpcEcs";
import type { PlayerAnimKey } from "../../game/ecs/PlayerEcs";
import { GameState, LoginIndex } from "../../game/login";
import { Ray, rayIntersectsBox } from "../../game/math/Raycast";
import { isMouseInUIRegion as checkMouseInUIRegion } from "../../game/menu/WorldMenuBuilder";
import {
    advanceAnimation,
    computeMovementOrientation,
    computeMovementStep,
    interpolateRotation,
    parseInteractionTarget,
} from "../../game/movement/NpcClientTick";
import type { TileMarkersPluginConfig } from "../../game/plugins/tilemarkers/types";
import { computeRoofPlaneLimit } from "../../game/roof/RoofVisibility";
import { sampleBridgeHeightForWorldTile } from "../../game/scene/BridgeHeightSampler";
import {
    BridgePlaneStrategy,
    resolveBridgePromotedPlane,
    resolveCollisionSamplePlaneForLocal,
    resolveCollisionSamplePlaneForWorldTile,
    resolveGroundItemStackPlane,
    resolveHeightSamplePlaneForLocal,
    resolveInteractionPlaneForLocal,
    resolveInteractionPlaneForWorldTile,
} from "../../game/scene/PlaneResolver";
import { SceneRaycastHit, SceneRaycaster } from "../../game/scene/SceneRaycaster";
import {
    TILE_FLAG_BRIDGE,
    getTileRenderFlagAt as lookupTileRenderFlagAt,
} from "../../game/scene/TileRenderFlags";
import { LoadingRequirement } from "../../game/state/LoadingTracker";
import type { PlayerSpotAnimationEvent } from "../../game/sync/PlayerSyncTypes";
import { RAD_TO_RS_UNITS, computeFacingRotation } from "../../game/utils/rotation";
import { AnimationFrames } from "../AnimationFrames";
import { ChatheadFactory } from "../ChatheadFactory";
import { type DrawBackend, createDrawBackend } from "../DrawBackend";
import { DrawRange, NULL_DRAW_RANGE, newDrawRange } from "../DrawRange";
import { InteractType } from "../InteractType";
import { profiler } from "../PerformanceProfiler";
import { PlayerChatheadFactory } from "../PlayerChatheadFactory";
import { resolveFogRange } from "../RenderDistancePolicy";
import { WebGLMapSquare } from "../WebGLMapSquare";
import { WorldEntityAnimator } from "../WorldEntityAnimator";
import { SceneBuffer } from "../buffer/SceneBuffer";
import { getModelFaces, isModelFaceTransparent } from "../buffer/SceneBuffer";
import { GfxManager } from "../gfx/GfxManager";
import { GfxRenderer } from "../gfx/GfxRenderer";
import { buildGroundItemGeometry } from "../ground/GroundItemMeshBuilder";
import { type MinimapIcon, SdMapData } from "../loader/SdMapData";
import { SdMapDataLoader } from "../loader/SdMapDataLoader";
import { SdMapLoaderInput } from "../loader/SdMapLoaderInput";
import { isDoorLocType } from "../loc/SceneLocs";
import {
    DynamicNpcAnimLoader,
    DynamicNpcFrameGeometry,
    DynamicNpcSequenceMeta,
} from "../npc/DynamicNpcAnimLoader";
import { PlayerRenderer } from "../player/PlayerRenderer";
import { ProjectileManager } from "../projectiles/ProjectileManager";
import { ProjectileRenderer } from "../projectiles/ProjectileRenderer";
import {
    FRAME_FXAA_PROGRAM,
    FRAME_PROGRAM,
    createMainProgram,
    createNpcProgram,
    createPlayerProgram,
    createProjectileProgram,
} from "../shaders/Shaders";
import { KNOWN_WATER_TEXTURE_IDS } from "../water/WaterTextureIds";
import type { WebGLOsrsRendererHost } from "./hostInterface";
import { RENDER_CONSTANTS } from "./constants";

export function _ecsUpdateNpcClient(host: WebGLOsrsRendererHost, map: WebGLMapSquare, clientTicksElapsed: number): void {

        const ids: number[] = map.npcEntityIds || ([] as any);
        if (ids.length === 0 || clientTicksElapsed <= 0) return;
        const ecs = host.osrsClient.npcEcs;
        const pe = host.osrsClient.playerEcs;
        // The client cycle each step of this batch stands for, so a sequence that arrived partway
        // through it only steps from its own start (NpcEcs.hasSeqStartedBy).
        const batchEndCycle = getClientCycle() | 0;

        for (let t = 0; t < clientTicksElapsed; t++) {
            const stepCycle = batchEndCycle - (clientTicksElapsed - 1 - t);
            for (let j = 0; j < ids.length; j++) {
                const id = ids[j] | 0;
                if (!ecs.isActive(id) || !ecs.isLinked(id)) continue;
                if (!host.shouldRenderNpcOwnershipFromMap(map, id)) continue;

                const walkingNow = ecs.shouldUseWalkAnim(id);
                const movementOrientation = walkingNow ? ecs.getCurrentStepRot(id) : undefined;
                ecs.setWalking(id, walkingNow);

                const npcWorldX = ecs.getWorldX(id) | 0;
                const npcWorldY = ecs.getWorldY(id) | 0;
                let desiredFacing: number | undefined;

                const npcInteractionIndex = ecs.getInteractionIndex?.(id);
                const npcInteraction =
                    typeof npcInteractionIndex === "number" && npcInteractionIndex >= 0
                        ? decodeInteractionIndex(npcInteractionIndex)
                        : null;
                if (npcInteraction) {
                    if (npcInteraction.type === "player") {
                        const targetIdx = pe.getIndexForServerId?.(npcInteraction.id | 0);
                        if (targetIdx != null) {
                            const px = pe.getX(targetIdx) | 0;
                            const py = pe.getY(targetIdx) | 0;
                            const dxFacing = (npcWorldX - px) | 0;
                            const dyFacing = (npcWorldY - py) | 0;
                            const facing = computeFacingRotation(dxFacing, dyFacing);
                            if (facing !== undefined) desiredFacing = facing;
                        }
                    } else if (npcInteraction.type === "npc") {
                        const targetEcs = ecs.getEcsIdForServer?.(npcInteraction.id | 0);
                        if (targetEcs != null && ecs.isLinked(targetEcs | 0)) {
                            const targetMapId = ecs.getMapId(targetEcs | 0) | 0;
                            const targetMapX = (targetMapId >> 8) & 0xff;
                            const targetMapY = targetMapId & 0xff;
                            const targetWorldX =
                                ((targetMapX << 13) + (ecs.getX(targetEcs | 0) | 0)) | 0;
                            const targetWorldY =
                                ((targetMapY << 13) + (ecs.getY(targetEcs | 0) | 0)) | 0;
                            const dxFacing = (npcWorldX - targetWorldX) | 0;
                            const dyFacing = (npcWorldY - targetWorldY) | 0;
                            const facing = computeFacingRotation(dxFacing, dyFacing);
                            if (facing !== undefined) desiredFacing = facing;
                        }
                    }
                }
                if (
                    desiredFacing === undefined &&
                    walkingNow &&
                    movementOrientation !== undefined
                ) {
                    desiredFacing = movementOrientation;
                }
                if (desiredFacing !== undefined) {
                    ecs.setTargetRot(id, desiredFacing);
                }

                // Rotate toward target orientation with rotation speed
                const rot = ecs.getRotation(id) | 0;
                const targetRot = ecs.getTargetRot(id) | 0;
                if (rot !== targetRot) {
                    const step = ecs.getRotationSpeed(id) | 0;
                    const newRot = interpolateRotation(rot, targetRot, step);
                    ecs.setRotation(id, newRot);
                }

                const seqId = ecs.getSeqId(id) | 0;
                const seqDelay = ecs.getSeqDelay?.(id) | 0;
                const extraAnimMap = map.npcExtraAnims?.[j];
                const extraLenMap = map.npcExtraFrameLengths?.[j];
                const { movementSeqId, idleSeqId, walkSeqId } = host.resolveNpcMovementSequenceIds(
                    ecs,
                    id,
                );
                const movementAnim =
                    (movementSeqId | 0) === (idleSeqId | 0)
                        ? (map.npcIdleFrames[j] as AnimationFrames | undefined)
                        : (movementSeqId | 0) === (walkSeqId | 0)
                            ? (((map.npcWalkFrames[j] ?? map.npcIdleFrames[j]) as AnimationFrames) ??
                                undefined)
                            : undefined;
                let movementLengths =
                    (movementSeqId | 0) === (idleSeqId | 0)
                        ? (map.npcIdleFrameLengths[j] as number[] | undefined)
                        : (movementSeqId | 0) === (walkSeqId | 0)
                            ? (((map.npcWalkFrameLengths[j] ??
                                map.npcIdleFrameLengths[j]) as number[]) ?? undefined)
                            : undefined;
                const currentMovementSeqId = ecs.getMovementSeqId?.(id) | 0;

                if ((movementSeqId | 0) !== (currentMovementSeqId | 0)) {
                    ecs.setMovementSeqId?.(id, movementSeqId | 0);
                    ecs.setMovementFrameIndex?.(id, 0);
                    ecs.setMovementAnimTick?.(id, 0);
                    ecs.setMovementLoopCount?.(id, 0);
                }

                let movementSeqType: any | undefined;
                if (movementSeqId >= 0) {
                    try {
                        movementSeqType = host.osrsClient.seqTypeLoader.load(movementSeqId | 0);
                    } catch {}
                }

                let movementFrameCount = Math.max(1, (movementAnim?.frames.length ?? 0) | 0);
                if (movementFrameCount <= 1 && movementSeqId >= 0) {
                    if (
                        !!movementSeqType?.isSkeletalSeq?.() ||
                        (movementSeqType?.skeletalId ?? -1) >= 0
                    ) {
                        movementFrameCount = Math.max(
                            1,
                            movementSeqType?.getSkeletalDuration?.() | 0,
                        );
                    } else if (Array.isArray(movementSeqType?.frameIds)) {
                        movementFrameCount = Math.max(1, movementSeqType.frameIds.length | 0);
                        if (!movementLengths) {
                            movementLengths = new Array<number>(movementFrameCount).fill(1);
                            for (let k = 0; k < movementFrameCount; k++) {
                                try {
                                    movementLengths[k] =
                                        movementSeqType.getFrameLength(
                                            host.osrsClient.seqFrameLoader,
                                            k | 0,
                                        ) | 0;
                                } catch {}
                            }
                        }
                    }
                }
                const movementStep = host.stepNpcSequenceTrack(
                    ecs.getMovementFrameIndex?.(id) | 0,
                    ecs.getMovementAnimTick?.(id) | 0,
                    ecs.getMovementLoopCount?.(id) | 0,
                    movementFrameCount | 0,
                    movementLengths,
                    movementSeqType,
                    false,
                );
                ecs.setMovementFrameIndex?.(id, movementStep.frameIndex | 0);
                ecs.setMovementAnimTick?.(id, movementStep.animTick | 0);
                ecs.setMovementLoopCount?.(id, movementStep.loopCount | 0);

                if (movementStep.frameAdvanced && movementSeqType?.frameSounds?.size) {
                    try {
                        host.osrsClient.handleSeqFrameSounds(
                            movementSeqType,
                            movementStep.frameIndex | 0,
                            {
                                position: {
                                    x: npcWorldX,
                                    y: npcWorldY,
                                    z: (ecs.getLevel(id) | 0) * 128,
                                },
                                isLocalPlayer: false,
                            },
                        );
                    } catch {}
                }

                if (seqId >= 0 && seqDelay === 0 && ecs.hasSeqStartedBy(id, stepCycle)) {
                    let actionLengths = extraLenMap?.[seqId];
                    let actionFrameCount = 1;
                    let actionSeqType: any | undefined;
                    try {
                        actionSeqType = host.osrsClient.seqTypeLoader.load(seqId | 0);
                    } catch {}

                    const seqAnim = extraAnimMap?.[seqId];
                    if (seqAnim) {
                        actionFrameCount = Math.max(1, seqAnim.frames.length | 0);
                    } else if (
                        !!actionSeqType?.isSkeletalSeq?.() ||
                        (actionSeqType?.skeletalId ?? -1) >= 0
                    ) {
                        actionFrameCount = Math.max(1, actionSeqType?.getSkeletalDuration?.() | 0);
                    } else if (Array.isArray(actionSeqType?.frameIds)) {
                        actionFrameCount = Math.max(1, actionSeqType.frameIds.length | 0);
                        if (!actionLengths) {
                            actionLengths = new Array<number>(actionFrameCount).fill(1);
                            for (let k = 0; k < actionFrameCount; k++) {
                                try {
                                    actionLengths[k] =
                                        actionSeqType.getFrameLength(
                                            host.osrsClient.seqFrameLoader,
                                            k | 0,
                                        ) | 0;
                                } catch {}
                            }
                        }
                    }

                    const actionStep = host.stepNpcSequenceTrack(
                        ecs.getFrameIndex(id) | 0,
                        ecs.getAnimTick(id) | 0,
                        ecs.getLoopCount(id) | 0,
                        actionFrameCount | 0,
                        actionLengths,
                        actionSeqType,
                        true,
                    );

                    // Reference: updateActorAnimationState stops the sequence the
                    // moment it finishes (actor animation state reverts to none);
                    // corpse poses persist via the death seq's own frame lengths
                    // and the server despawning the NPC at the animation's end.
                    if (actionStep.cleared) {
                        ecs.clearSeq(id);
                    } else {
                        ecs.setFrameIndex(id, actionStep.frameIndex | 0);
                        ecs.setAnimTick(id, actionStep.animTick | 0);
                        ecs.setLoopCount(id, actionStep.loopCount | 0);
                    }

                    if (actionStep.frameAdvanced && actionSeqType?.frameSounds?.size) {
                        try {
                            host.osrsClient.handleSeqFrameSounds(
                                actionSeqType,
                                actionStep.frameIndex | 0,
                                {
                                    position: {
                                        x: npcWorldX,
                                        y: npcWorldY,
                                        z: (ecs.getLevel(id) | 0) * 128,
                                    },
                                    isLocalPlayer: false,
                                },
                            );
                        } catch {}
                    }
                }
            }
        }
    
}

export function _ecsUpdatePlayerServer(host: WebGLOsrsRendererHost, ): void {

        return;
    
}
