import * as THREE from 'three';
import { CAMERA, WORLD } from '../game/config';

export type CameraMode = 'overview' | 'focus' | 'flight' | 'impact';

/**
 * Locked side-on camera.
 *
 * The rig is told what world width to frame, not where to sit; distance is
 * derived from FOV and aspect so a phone in portrait sees the same slice of
 * arena as a desktop in landscape. That is the whole reason the framing survives
 * resize without a separate mobile layout.
 *
 * A narrow 30 degree FOV keeps the projection close to orthographic — the 2.5D
 * read — while still giving the parallax that sells the ridge layers.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private readonly target = new THREE.Vector3(0, 8, 0);
  private readonly current = new THREE.Vector3(0, 8, 0);
  private targetWidth: number = CAMERA.overviewWidth;
  private currentWidth: number = CAMERA.overviewWidth;
  private aspect = 16 / 9;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, this.aspect, CAMERA.near, CAMERA.far);
    this.camera.name = 'battleCamera';
    this.applyTransform();
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Distance required to frame `width` world units horizontally, with the
   * visible height held inside a sane band.
   *
   * Framing purely by width breaks in portrait: a phone at 0.46 aspect would
   * show 40 units across and 87 units top to bottom, which is mostly empty sky
   * over a wall of dirt. Clamping the height to at most 1.5x the requested
   * width trades some horizontal context for a frame a player can actually
   * read. The lower clamp does the same favour for ultrawide monitors, which
   * would otherwise show a letterbox slit.
   */
  private distanceFor(width: number): number {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const byWidth = width / 2 / (tan * this.aspect);
    const visibleHeight = width / Math.max(0.05, this.aspect);
    if (visibleHeight > width * 1.2) return (width * 1.2) / 2 / tan;
    if (visibleHeight < width * 0.5) return (width * 0.5) / 2 / tan;
    return byWidth;
  }

  /**
   * Aim the rig at a point with a requested framing width. The centre is
   * clamped so the camera never shows empty space beyond the arena edges.
   */
  frame(centerX: number, centerY: number, width: number): void {
    const clampedWidth = Math.min(width, CAMERA.overviewWidth);
    const halfVisible = clampedWidth / 2;
    const limit = Math.max(0, WORLD.halfWidth - halfVisible + 6);
    this.target.set(
      THREE.MathUtils.clamp(centerX, -limit, limit),
      THREE.MathUtils.clamp(centerY, CAMERA.minCenterY, CAMERA.maxCenterY),
      0,
    );
    this.targetWidth = clampedWidth;
  }

  /**
   * The horizontal extent a requested width really produces.
   *
   * `distanceFor` clamps the visible height, so on a portrait phone asking
   * for 70 units across yields barely 28. Callers that need two things in
   * frame have to be able to find that out rather than silently losing one.
   */
  visibleWidthAt(requestedWidth: number): number {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const distance = this.distanceFor(Math.min(requestedWidth, CAMERA.overviewWidth));
    return 2 * distance * tan * this.aspect;
  }

  widthFor(mode: CameraMode): number {
    switch (mode) {
      case 'overview':
        return CAMERA.overviewWidth;
      case 'focus':
        return CAMERA.focusWidth;
      case 'flight':
        return CAMERA.flightWidth;
      case 'impact':
        return CAMERA.impactWidth;
    }
  }

  update(delta: number): void {
    // Exponential smoothing: frame-rate independent and never overshoots.
    const positionBlend = 1 - Math.exp(-delta / CAMERA.positionTau);
    const widthBlend = 1 - Math.exp(-delta / CAMERA.widthTau);
    this.current.lerp(this.target, positionBlend);
    this.currentWidth += (this.targetWidth - this.currentWidth) * widthBlend;
    this.applyTransform();
  }

  snap(): void {
    this.current.copy(this.target);
    this.currentWidth = this.targetWidth;
    this.applyTransform();
  }

  private applyTransform(): void {
    const distance = this.distanceFor(this.currentWidth);
    this.camera.position.set(this.current.x, this.current.y, distance);
    this.camera.rotation.set(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  get framedWidth(): number {
    return this.currentWidth;
  }

  get centerX(): number {
    return this.current.x;
  }
}
