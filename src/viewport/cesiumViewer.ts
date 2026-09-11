/**
 * CesiumJS 4D Spatiotemporal Viewport Engine
 *
 * Manages 3D scene rendering, 6-DOF aircraft replay, planned route visualization,
 * spatial deviation color bands, camera tracking modes, and timeline controls.
 *
 * 100% Offline-capable: Zero remote token / imagery dependencies.
 */

import * as Cesium from 'cesium';
import type { FlightRecordPackage, DeviationResult, WPMLRoute } from '../core/types';
import {
  generateTrajectorySegments,
  interpolateTelemetryAtTime,
  eulerToHeadingPitchRoll,
  calculateCameraHeadingPitchRange,
  type ColorMode,
  type InterpolatedTelemetry,
  type TrajectoryOptions,
} from './trajectoryLayer';
import { FrustumLayer } from './frustumLayer';

export type CameraMode = 'follow' | 'free' | 'fpv_gimbal' | 'top_down';

export interface ViewerOptions {
  modelUri?: string;
  showGrid?: boolean;
  showFrustum?: boolean;
  defaultColorMode?: ColorMode;
  altitudeSource?: 'altitudes' | 'heights';
  altitudeOffset?: number;
  droneScale?: number;
}

export type TimeUpdateCallback = (timeSec: number, telemetry: InterpolatedTelemetry | null) => void;

export class Flight3DViewerEngine {
  private viewer: Cesium.Viewer | null = null;
  private container: HTMLElement | null = null;

  private flightPackage: FlightRecordPackage | null = null;
  private deviationResult: DeviationResult | null = null;
  private plannedRoute: WPMLRoute | null = null;

  private droneEntity: Cesium.Entity | null = null;
  private trajectoryEntityIds: string[] = [];
  private routeEntityIds: string[] = [];
  private eventEntityIds: string[] = [];
  private frustumLayer: FrustumLayer | null = null;
  private showFrustum = true;

  private colorMode: ColorMode = 'rtk';
  private altitudeSource: 'altitudes' | 'heights' = 'altitudes';
  private altitudeOffset = 0;
  private cameraMode: CameraMode = 'follow';
  private playbackRate = 1.0;
  private isPlaying = false;

  private currentTimeSec = 0;
  private durationSec = 0;
  private startTimeMs = 0;

  private timeUpdateCallbacks: Set<TimeUpdateCallback> = new Set();
  private tickRemoveCallback: (() => void) | null = null;
  private options: ViewerOptions = {};

  /**
   * Initializes the Cesium Viewer in 100% offline mode.
   */
  public async initialize(
    container: HTMLElement | string,
    options: ViewerOptions = {}
  ): Promise<void> {
    this.options = options;
    this.showFrustum = options.showFrustum !== false;
    this.colorMode = options.defaultColorMode ?? 'rtk';
    this.altitudeSource = options.altitudeSource ?? 'altitudes';
    this.altitudeOffset = options.altitudeOffset ?? 0;
    this.frustumLayer = new FrustumLayer();

    // Resolve container element
    let targetEl: HTMLElement | null = null;
    if (typeof container === 'string') {
      targetEl = typeof document !== 'undefined' ? document.getElementById(container) : null;
    } else {
      targetEl = container;
    }

    if (!targetEl) {
      if (typeof window === 'undefined') {
        // Node / headless testing environment guard
        return;
      }
      throw new Error(`Cesium container element not found: ${container}`);
    }

    this.container = targetEl;

    // Ensure Cesium Ion token is empty (100% offline rule)
    Cesium.Ion.defaultAccessToken = '';

    // Create 100% offline Cesium Viewer without any online services
    const viewer = new Cesium.Viewer(targetEl, {
      baseLayer: options.showGrid !== false
        ? new Cesium.ImageryLayer(
            new Cesium.GridImageryProvider({
              color: Cesium.Color.fromCssColorString('#37474F'),
              glowColor: Cesium.Color.fromCssColorString('#263238'),
              backgroundColor: Cesium.Color.fromCssColorString('#101418'),
              cells: 8,
            })
          )
        : false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      infoBox: false,
      selectionIndicator: false,
      skyBox: false,
      skyAtmosphere: false,
    });

    // Dark-slate theme for offline globe
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1e293b');
    viewer.scene.globe.depthTestAgainstTerrain = false;

    this.viewer = viewer;
    this.frustumLayer.attach(viewer);

    // Hook onto scene tick for smooth interpolation & camera tracking
    const onTick = () => {
      if (!this.flightPackage || this.durationSec <= 0) return;

      if (this.isPlaying) {
        // Step forward in time based on Cesium clock
        const currentJulian = viewer.clock.currentTime;
        const startJulian = viewer.clock.startTime;
        const diffSec = Cesium.JulianDate.secondsDifference(currentJulian, startJulian);
        this.currentTimeSec = Math.max(0, Math.min(diffSec, this.durationSec));

        if (this.currentTimeSec >= this.durationSec) {
          this.pause();
        }
      }

      this.updateDroneAndCameraAtTime(this.currentTimeSec);
    };

    const removeEventListener = viewer.clock.onTick.addEventListener(onTick);
    this.tickRemoveCallback = () => {
      removeEventListener();
    };
  }

  /**
   * Loads a flight record package and optional deviation result into the 3D scene.
   */
  public loadFlight(pkg: FlightRecordPackage, deviation?: DeviationResult): void {
    this.flightPackage = pkg;
    this.deviationResult = deviation || null;

    const count = pkg.telemetry.timestamps.length;
    if (count === 0) return;

    this.startTimeMs = pkg.telemetry.timestamps[0];
    const endTimeMs = pkg.telemetry.timestamps[count - 1];
    this.durationSec = Math.max(0, (endTimeMs - this.startTimeMs) / 1000);
    this.currentTimeSec = 0;

    if (!this.viewer) return;

    // Configure Cesium Clock
    const startJulian = Cesium.JulianDate.fromDate(new Date(this.startTimeMs));
    const stopJulian = Cesium.JulianDate.fromDate(new Date(endTimeMs));
    this.viewer.clock.startTime = startJulian;
    this.viewer.clock.stopTime = stopJulian;
    this.viewer.clock.currentTime = startJulian;
    this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
    this.viewer.clock.multiplier = this.playbackRate;
    this.viewer.clock.shouldAnimate = false;

    // Build Trajectory Polyline segments
    this.renderTrajectorySegments();

    // Create or Update 6-DOF Drone Entity
    this.createDroneEntity();

    // Render Event Markers (Photos, Warnings)
    this.renderEventMarkers();

    // Initial position & fly to scene
    this.updateDroneAndCameraAtTime(0);
    this.flyToTrajectory();
  }

  /**
   * Loads and displays planned WPML route in 3D viewport.
   */
  public loadPlannedRoute(route: WPMLRoute): void {
    this.plannedRoute = route;
    if (!this.viewer) return;

    this.clearRouteEntities();

    const pts = route.waypoints;
    if (pts.length === 0) return;

    const positions: Cesium.Cartesian3[] = pts.map((wp) =>
      Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt)
    );

    // Cyan dashed route polyline
    const routeEntity = this.viewer.entities.add({
      id: `planned-route-${route.name || 'wpml'}`,
      name: `Planned Route: ${route.name}`,
      polyline: {
        positions,
        width: 3,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#00E5FF'),
          dashLength: 16.0,
        }),
      },
    });
    this.routeEntityIds.push(routeEntity.id);

    // Waypoint spheres and labels
    pts.forEach((wp, index) => {
      const pos = Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt);
      const wpEntity = this.viewer!.entities.add({
        id: `waypoint-${wp.index ?? index}`,
        position: pos,
        point: {
          pixelSize: 8,
          color: Cesium.Color.fromCssColorString('#00E5FF'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: `WP ${wp.index ?? index} (${wp.alt}m)`,
          font: '11px sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000),
        },
      });
      this.routeEntityIds.push(wpEntity.id);
    });
  }

  /**
   * Re-renders the trajectory polyline segments with current colorMode and altitude options.
   */
  public renderTrajectorySegments(): void {
    if (!this.viewer || !this.flightPackage) return;

    this.clearTrajectoryEntities();

    const options: TrajectoryOptions = {
      altitudeSource: this.altitudeSource,
      altitudeOffset: this.altitudeOffset,
      mergeConsecutive: true,
    };

    const segments = generateTrajectorySegments(
      this.flightPackage.telemetry,
      this.colorMode,
      this.deviationResult || undefined,
      options
    );

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const positions = seg.points.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2]));
      const color = Cesium.Color.fromCssColorString(seg.colorHex);

      const entity = this.viewer.entities.add({
        id: `traj-seg-${i}`,
        polyline: {
          positions,
          width: 4,
          material: color,
        },
      });
      this.trajectoryEntityIds.push(entity.id);
    }
  }

  /**
   * Creates or recreates the 6-DOF aircraft entity.
   */
  private createDroneEntity(): void {
    if (!this.viewer) return;

    if (this.droneEntity) {
      this.viewer.entities.remove(this.droneEntity);
      this.droneEntity = null;
    }

    const scale = this.options.droneScale ?? 1.0;

    // Use GLB model if supplied; fallback to stylized 3D entity box
    if (this.options.modelUri) {
      this.droneEntity = this.viewer.entities.add({
        id: 'aircraft-drone-model',
        name: 'Aircraft 6-DOF Drone',
        model: {
          uri: this.options.modelUri,
          scale,
          minimumPixelSize: 48,
          maximumScale: 50,
        },
      });
    } else {
      // Fallback 3D geometric drone with orientable box & heading cone
      this.droneEntity = this.viewer.entities.add({
        id: 'aircraft-drone-model',
        name: 'Aircraft 6-DOF Drone',
        box: {
          dimensions: new Cesium.Cartesian3(2.0 * scale, 2.0 * scale, 0.6 * scale),
          material: Cesium.Color.fromCssColorString('#00E5FF').withAlpha(0.85),
          outline: true,
          outlineColor: Cesium.Color.WHITE,
        },
      });
    }
  }

  /**
   * Renders photo capture events and warnings as 3D pins.
   */
  private renderEventMarkers(): void {
    if (!this.viewer || !this.flightPackage) return;

    this.clearEventEntities();

    // Photo events (Emerald camera pins)
    const photos = this.flightPackage.events.photos;
    for (const photo of photos) {
      const [lon, lat, alt] = photo.position;
      const entity = this.viewer.entities.add({
        id: `photo-event-${photo.id}`,
        name: `Photo #${photo.index}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, alt + this.altitudeOffset),
        point: {
          pixelSize: 7,
          color: Cesium.Color.fromCssColorString('#00E676'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1.5,
        },
      });
      this.eventEntityIds.push(entity.id);
    }

    // Warning events (Critical red / Warning yellow pins)
    const warnings = this.flightPackage.events.warnings;
    for (let i = 0; i < warnings.length; i++) {
      const warn = warnings[i];
      const state = this.getTelemetryAtTimestamp(warn.timestamp);
      if (state) {
        const isCritical = warn.level === 'critical';
        const color = isCritical
          ? Cesium.Color.fromCssColorString('#FF1744')
          : Cesium.Color.fromCssColorString('#FFD600');

        const entity = this.viewer.entities.add({
          id: `warning-event-${i}`,
          name: `Warning: ${warn.message}`,
          position: Cesium.Cartesian3.fromDegrees(
            state.longitude,
            state.latitude,
            state.altitude
          ),
          point: {
            pixelSize: 9,
            color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
          },
        });
        this.eventEntityIds.push(entity.id);
      }
    }
  }

  /**
   * Updates drone position, 6-DOF attitude orientation, and camera tracking at a specific time in seconds.
   */
  private updateDroneAndCameraAtTime(timeSec: number): void {
    if (!this.viewer || !this.flightPackage) return;

    const targetTimeMs = this.startTimeMs + timeSec * 1000;
    const options: TrajectoryOptions = {
      altitudeSource: this.altitudeSource,
      altitudeOffset: this.altitudeOffset,
    };

    const telemetry = interpolateTelemetryAtTime(
      this.flightPackage.telemetry,
      targetTimeMs,
      options
    );
    if (!telemetry) return;

    const position = Cesium.Cartesian3.fromDegrees(
      telemetry.longitude,
      telemetry.latitude,
      telemetry.altitude
    );

    // 6-DOF Attitude: Euler (pitch, roll, yaw) -> Cesium HeadingPitchRoll -> Quaternion
    const hprDeg = eulerToHeadingPitchRoll(telemetry.pitch, telemetry.roll, telemetry.yaw);
    const hpr = new Cesium.HeadingPitchRoll(hprDeg.heading, hprDeg.pitch, hprDeg.roll);
    const orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);

    if (this.droneEntity) {
      this.droneEntity.position = new Cesium.ConstantPositionProperty(position);
      this.droneEntity.orientation = new Cesium.ConstantProperty(orientation);
    }

    // Camera Tracking
    this.updateCamera(position, telemetry);

    // Dynamic camera frustum update
    if (this.frustumLayer && this.showFrustum && this.viewer) {
      const gPitch = Number.isFinite(telemetry.gimbalPitch) ? telemetry.gimbalPitch : -45.0;
      const gYaw = Number.isFinite(telemetry.gimbalYaw) ? telemetry.gimbalYaw : telemetry.yaw;
      const groundAlt =
        Number.isFinite(telemetry.height) && telemetry.height > 0
          ? telemetry.altitude - telemetry.height
          : this.flightPackage?.meta.homeLocation?.[2] ?? 0;

      this.frustumLayer.update({
        position: [telemetry.longitude, telemetry.latitude, telemetry.altitude],
        gimbalPitch: gPitch,
        gimbalYaw: gYaw,
        groundAltitude: groundAlt,
      });
    }

    // Notify listeners
    for (const cb of this.timeUpdateCallbacks) {
      cb(timeSec, telemetry);
    }
  }

  /**
   * Updates camera position & orientation according to active CameraMode.
   */
  private updateCamera(
    droneCartesian: Cesium.Cartesian3,
    telemetry: InterpolatedTelemetry
  ): void {
    if (!this.viewer) return;

    const camera = this.viewer.camera;

    if (this.cameraMode === 'free') {
      // Detach lookAt transform so user has full control
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      return;
    }

    const { heading, pitch, range } = calculateCameraHeadingPitchRange(
      this.cameraMode,
      telemetry.yaw,
      telemetry.gimbalPitch,
      35
    );

    const hpr = new Cesium.HeadingPitchRange(heading, pitch, range);
    camera.lookAt(droneCartesian, hpr);
  }

  /**
   * Helper to retrieve interpolated telemetry at a given UTC epoch timestamp.
   */
  public getTelemetryAtTimestamp(timestampMs: number): InterpolatedTelemetry | null {
    if (!this.flightPackage) return null;
    return interpolateTelemetryAtTime(this.flightPackage.telemetry, timestampMs, {
      altitudeSource: this.altitudeSource,
      altitudeOffset: this.altitudeOffset,
    });
  }

  /**
   * Jumps to a specific playback time in seconds.
   */
  public seek(timeSec: number): void {
    this.currentTimeSec = Math.max(0, Math.min(timeSec, this.durationSec));
    if (this.viewer && this.flightPackage) {
      const targetJulian = Cesium.JulianDate.fromDate(
        new Date(this.startTimeMs + this.currentTimeSec * 1000)
      );
      this.viewer.clock.currentTime = targetJulian;
    }
    this.updateDroneAndCameraAtTime(this.currentTimeSec);
  }

  /**
   * Starts playback.
   */
  public play(): void {
    this.isPlaying = true;
    if (this.viewer) {
      this.viewer.clock.shouldAnimate = true;
      this.viewer.clock.multiplier = this.playbackRate;
    }
  }

  /**
   * Pauses playback.
   */
  public pause(): void {
    this.isPlaying = false;
    if (this.viewer) {
      this.viewer.clock.shouldAnimate = false;
    }
  }

  /**
   * Adjusts playback rate (e.g. 0.5x, 1.0x, 2.0x, 4.0x).
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.1, rate);
    if (this.viewer) {
      this.viewer.clock.multiplier = this.playbackRate;
    }
  }

  /**
   * Sets camera tracking mode.
   */
  public setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    if (!this.viewer) return;

    if (mode === 'free') {
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } else {
      this.updateDroneAndCameraAtTime(this.currentTimeSec);
    }
  }

  /**
   * Sets trajectory color coding mode.
   */
  public setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
    this.renderTrajectorySegments();
  }

  /**
   * Configures altitude source ('altitudes' | 'heights') and offset.
   */
  public setAltitudeOptions(source: 'altitudes' | 'heights', offset = 0): void {
    this.altitudeSource = source;
    this.altitudeOffset = offset;
    this.renderTrajectorySegments();
    this.renderEventMarkers();
    this.updateDroneAndCameraAtTime(this.currentTimeSec);
  }

  /**
   * Flies camera to encompass the full flight trajectory.
   */
  public flyToTrajectory(): void {
    if (!this.viewer || !this.flightPackage) return;
    const lons = this.flightPackage.telemetry.longitudes;
    const lats = this.flightPackage.telemetry.latitudes;
    if (lons.length === 0) return;

    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    for (let i = 0; i < lons.length; i++) {
      if (lons[i] < minLon) minLon = lons[i];
      if (lons[i] > maxLon) maxLon = lons[i];
      if (lats[i] < minLat) minLat = lats[i];
      if (lats[i] > maxLat) maxLat = lats[i];
    }

    const rect = Cesium.Rectangle.fromDegrees(
      minLon - 0.002,
      minLat - 0.002,
      maxLon + 0.002,
      maxLat + 0.002
    );

    this.viewer.camera.flyTo({
      destination: rect,
      duration: 1.5,
    });
  }

  /**
   * Registers a callback invoked whenever playback time advances.
   */
  public onTimeUpdate(callback: TimeUpdateCallback): () => void {
    this.timeUpdateCallbacks.add(callback);
    return () => {
      this.timeUpdateCallbacks.delete(callback);
    };
  }

  /**
   * Returns current viewer instance.
   */
  public getViewer(): Cesium.Viewer | null {
    return this.viewer;
  }

  /**
   * Returns current playback state.
   */
  public getPlaybackState(): {
    isPlaying: boolean;
    currentTimeSec: number;
    durationSec: number;
    playbackRate: number;
    cameraMode: CameraMode;
    colorMode: ColorMode;
    altitudeSource: 'altitudes' | 'heights';
    altitudeOffset: number;
  } {
    return {
      isPlaying: this.isPlaying,
      currentTimeSec: this.currentTimeSec,
      durationSec: this.durationSec,
      playbackRate: this.playbackRate,
      cameraMode: this.cameraMode,
      colorMode: this.colorMode,
      altitudeSource: this.altitudeSource,
      altitudeOffset: this.altitudeOffset,
    };
  }

  private clearTrajectoryEntities(): void {
    if (!this.viewer) return;
    for (const id of this.trajectoryEntityIds) {
      this.viewer.entities.removeById(id);
    }
    this.trajectoryEntityIds = [];
  }

  private clearRouteEntities(): void {
    if (!this.viewer) return;
    for (const id of this.routeEntityIds) {
      this.viewer.entities.removeById(id);
    }
    this.routeEntityIds = [];
  }

  private clearEventEntities(): void {
    if (!this.viewer) return;
    for (const id of this.eventEntityIds) {
      this.viewer.entities.removeById(id);
    }
    this.eventEntityIds = [];
  }

  /**
   * Toggles visibility of dynamic gimbal camera frustum and ground footprint.
   */
  public setFrustumVisible(visible: boolean): void {
    this.showFrustum = visible;
    if (this.frustumLayer) {
      this.frustumLayer.setVisible(visible);
    }
  }

  /**
   * Returns whether camera frustum rendering is currently enabled.
   */
  public isFrustumVisible(): boolean {
    return this.showFrustum;
  }

  /**
   * Destroys the viewer and releases all GPU / memory resources.
   */
  public destroy(): void {
    if (this.frustumLayer) {
      this.frustumLayer.destroy();
      this.frustumLayer = null;
    }

    if (this.tickRemoveCallback) {
      this.tickRemoveCallback();
      this.tickRemoveCallback = null;
    }
    this.timeUpdateCallbacks.clear();

    if (this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.destroy();
      this.viewer = null;
    }
    this.container = null;
  }
}
