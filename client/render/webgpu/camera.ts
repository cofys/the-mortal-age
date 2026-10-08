import { mat4, vec3 } from "gl-matrix";

import { clamp } from "../../common/utils/MathUtil";
import { getClientCycle } from "../../network/ServerConnection";
import { RS_TO_RADIANS } from "../../rs/MathConstants";
import { sampleBridgeHeightForWorldTile } from "../../game/scene/BridgeHeightSampler";
import { BridgePlaneStrategy } from "../../game/scene/PlaneResolver";
import { LoadingRequirement } from "../../game/state/LoadingTracker";
import type { WebGPURenderer } from "./WebGPURenderer";

/**
 * Port of the controlled-player lookup in render/render/camera/roof.ts. Reads only
 * OsrsClient state, so it is backend-neutral.
 */
export function getControlledPlayerEcsIndex(renderer: WebGPURenderer): number | undefined {
    const playerEcs = renderer.osrsClient.playerEcs;
    const controlledServerId = renderer.osrsClient.controlledPlayerServerId | 0;

    if (controlledServerId > 0) {
        try {
            const controlledIndex = playerEcs.getIndexForServerId(controlledServerId);
            if (controlledIndex !== undefined) {
                return controlledIndex | 0;
            }
        } catch {}
    }

    try {
        const size = playerEcs.size?.() ?? 0;
        if (size > 0) {
            return 0;
        }
    } catch {}

    return undefined;
}

/**
 * Port of updateCameraFollow (render/render/camera2.ts) without world entities (boats) and
 * terrain pitch pressure, which stage 2 does not model. Follow focal smoothing and the orbit
 * are identical so the camera tracks the player the same way WebGL does.
 */
export function updateFollowCamera(renderer: WebGPURenderer, timeSec: number): void {
    const osrsClient = renderer.osrsClient;
    const playerEcs = osrsClient.playerEcs;
    const playerEcsIndex = getControlledPlayerEcsIndex(renderer);
    if (playerEcsIndex === undefined) return;

    const px = playerEcs.getX(playerEcsIndex) | 0;
    const py = playerEcs.getY(playerEcsIndex) | 0;
    const playerX = px / 128;
    const playerZ = py / 128;

    renderer.playerPosUni[0] = playerX;
    renderer.playerPosUni[1] = playerZ;
    // Scripted camera moves (and free cameras) turn following off, as in WebGL's frame loop.
    if (!osrsClient.followPlayerCamera) return;

    const clientCycle = getClientCycle() | 0;
    const targetSubX = px;
    const targetSubZ = py;

    if (!renderer.followCamFocalInitialized || renderer.followCamFocalLastClientCycle < 0) {
        renderer.followCamFocalXSub = targetSubX;
        renderer.followCamFocalZSub = targetSubZ;
        renderer.followCamFocalLastClientCycle = clientCycle;
        renderer.followCamFocalInitialized = true;
    } else {
        const cyclesElapsed = (clientCycle - renderer.followCamFocalLastClientCycle) | 0;
        if (cyclesElapsed < 0 || cyclesElapsed > 32) {
            renderer.followCamFocalXSub = targetSubX;
            renderer.followCamFocalZSub = targetSubZ;
            renderer.followCamFocalLastClientCycle = clientCycle;
        } else if (cyclesElapsed > 0) {
            for (let i = 0; i < cyclesElapsed; i++) {
                const dxFocal = targetSubX - renderer.followCamFocalXSub;
                const dzFocal = targetSubZ - renderer.followCamFocalZSub;
                if (dxFocal < -500 || dxFocal > 500 || dzFocal < -500 || dzFocal > 500) {
                    renderer.followCamFocalXSub = targetSubX;
                    renderer.followCamFocalZSub = targetSubZ;
                } else {
                    if (dxFocal !== 0) {
                        renderer.followCamFocalXSub += (dxFocal / 16) | 0;
                    }
                    if (dzFocal !== 0) {
                        renderer.followCamFocalZSub += (dzFocal / 16) | 0;
                    }
                }
            }
            renderer.followCamFocalLastClientCycle = clientCycle;
        }
    }

    const targetX = renderer.followCamFocalXSub / 128;
    const targetZ = renderer.followCamFocalZSub / 128;
    const basePlane = playerEcs.getLevel(playerEcsIndex) | 0;

    const playerHeightSample = sampleBridgeHeightForWorldTile(
        renderer.mapManager,
        playerX,
        playerZ,
        basePlane,
        BridgePlaneStrategy.RENDER,
    );

    const camera = osrsClient.camera;
    const viewportWidth = renderer.canvas.width || 1;
    const viewportHeight = renderer.canvas.height || 1;
    const { viewportHeight: effectiveViewportHeight } = camera.computeViewportMetricsForSize(
        viewportWidth,
        viewportHeight,
    );

    const v = clamp(effectiveViewportHeight - 334, 0, 100);
    const zoom =
        (osrsClient.zoomWidth - osrsClient.zoomHeight) * (v / 100) + osrsClient.zoomHeight;
    const camAngleX = camera.getControlPitchAngle();
    camera.setScenePitchOverride(camAngleX);

    const yawRad = (camera.yaw - 1024) * RS_TO_RADIANS;
    const pitchRad = -camAngleX * RS_TO_RADIANS;

    const rot = renderer.followCamRot;
    mat4.identity(rot);
    mat4.rotateY(rot, rot, yawRad);
    mat4.rotateZ(rot, rot, Math.PI);
    mat4.rotateX(rot, rot, pitchRad);

    const forward = renderer.followCamForward;
    vec3.transformMat4(forward, renderer.followCamForwardAxis, rot);
    vec3.normalize(forward, forward);

    const baseRadius = 600 + 3 * camAngleX;
    const radius = (baseRadius * zoom) / 256;
    const dist = radius / 128;
    let desiredPosX = targetX - forward[0] * dist;
    let desiredPosZ = targetZ - forward[2] * dist;
    desiredPosX = Math.round(desiredPosX * 128) / 128;
    desiredPosZ = Math.round(desiredPosZ * 128) / 128;
    camera.snapToPosition(desiredPosX, undefined, desiredPosZ);

    if (!playerHeightSample.valid) {
        return;
    }

    if (!renderer.mapDataLoadedNotified) {
        if (renderer.heightValidAtTime === undefined) {
            renderer.heightValidAtTime = timeSec;
        } else if (timeSec - renderer.heightValidAtTime >= 1.0) {
            renderer.mapDataLoadedNotified = true;
            osrsClient.loadingTracker.markComplete(LoadingRequirement.MAP_DATA_LOADED);
        }
    }

    const focusHeightTiles = (osrsClient.camFollowHeight | 0) / 128.0;
    const targetY = playerHeightSample.height - focusHeightTiles;
    const desiredPosY = Math.round((targetY - forward[1] * dist) * 128) / 128;
    camera.snapToPosition(undefined, desiredPosY, undefined);
}
