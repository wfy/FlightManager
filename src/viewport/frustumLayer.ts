/**
 * CesiumJS Dynamic Gimbal Frustum & Ground Footprint Viewport Layer
 *
 * 100% Offline: Pure local WebGL/Cesium rendering, zero network/token dependencies.
 *
 * Visualizes:
 * 1. 4 3D pyramid edge lines (connecting camera apex to 4 corner rays)
 * 2. Translucent ground footprint polygon (with outline) on terrain/ground surface
 * 3. Camera optical axis center line (dashed)
 * 4. Target reticle / crosshair at footprint center
 */

import * as Cesium from 'cesium';
import {
  calculateFrustumGeometry,
  type FrustumParams,
  type FrustumGeometryResult,
} from '../spatial/frustumSolver';

export interface FrustumLayerOptions {
  edgeColorHex?: string;
  edgeAlpha?: number;
  edgeWidth?: number;
  footprintColorHex?: string;
  footprintAlpha?: number;
  footprintOutlineWidth?: number;
  opticalAxisColorHex?: string;
  opticalAxisAlpha?: number;
  reticleColorHex?: string;
  reticleSize?: number;
}

export const FRUSTUM_ENTITY_PYRAMID = 'frustum-pyramid-edges';
export const FRUSTUM_ENTITY_FOOTPRINT = 'frustum-footprint-polygon';
export const FRUSTUM_ENTITY_OUTLINE = 'frustum-footprint-outline';
export const FRUSTUM_ENTITY_OPTICAL_AXIS = 'frustum-optical-axis';
export const FRUSTUM_ENTITY_RETICLE = 'frustum-reticle';

export class FrustumLayer {
  private viewer: any = null;
  private visible = true;
  private options: Required<FrustumLayerOptions>;

  private currentParams: FrustumParams | null = null;
  private lastResult: FrustumGeometryResult | null = null;

  // Managed Cesium Entities
  private pyramidEntity: any = null;
  private footprintEntity: any = null;
  private footprintOutlineEntity: any = null;
  private opticalAxisEntity: any = null;
  private reticleEntity: any = null;

  constructor(options: FrustumLayerOptions = {}) {
    this.options = {
      edgeColorHex: options.edgeColorHex ?? '#FFD700',
      edgeAlpha: options.edgeAlpha ?? 0.8,
      edgeWidth: options.edgeWidth ?? 2,
      footprintColorHex: options.footprintColorHex ?? '#FFD700',
      footprintAlpha: options.footprintAlpha ?? 0.25,
      footprintOutlineWidth: options.footprintOutlineWidth ?? 2,
      opticalAxisColorHex: options.opticalAxisColorHex ?? '#FFD700',
      opticalAxisAlpha: options.opticalAxisAlpha ?? 0.7,
      reticleColorHex: options.reticleColorHex ?? '#FFD700',
      reticleSize: options.reticleSize ?? 8,
    };
  }

  /**
   * Attaches the frustum layer to a Cesium Viewer instance.
   */
  public attach(cesiumViewer: any): void {
    if (this.viewer && this.viewer !== cesiumViewer) {
      this.destroy();
    }
    this.viewer = cesiumViewer;
    if (this.viewer && this.viewer.entities) {
      this.ensureEntities();
    }
  }

  /**
   * Updates camera frustum geometry and updates Cesium entities.
   */
  public update(params: FrustumParams): FrustumGeometryResult {
    this.currentParams = params;
    const result = calculateFrustumGeometry(params);
    this.lastResult = result;

    if (this.viewer && this.viewer.entities) {
      this.ensureEntities();
      this.syncEntities(result);
    }

    return result;
  }

  /**
   * Toggles visibility of all frustum visual elements.
   */
  public setVisible(visible: boolean): void {
    this.visible = visible;

    const entities = [
      this.pyramidEntity,
      this.opticalAxisEntity,
    ];

    for (const e of entities) {
      if (e) {
        e.show = visible;
      }
    }

    if (this.footprintEntity) {
      this.footprintEntity.show = visible && (this.lastResult?.intersectsGround ?? false);
    }
    if (this.footprintOutlineEntity) {
      this.footprintOutlineEntity.show = visible && (this.lastResult?.intersectsGround ?? false);
    }
    if (this.reticleEntity) {
      this.reticleEntity.show = visible && (this.lastResult?.intersectsGround ?? false);
    }
  }

  /**
   * Returns current visibility.
   */
  public isVisible(): boolean {
    return this.visible;
  }

  /**
   * Returns the most recent frustum calculation result.
   */
  public getLastResult(): FrustumGeometryResult | null {
    return this.lastResult;
  }

  /**
   * Safely destroys and removes all entities from the viewer.
   */
  public destroy(): void {
    if (this.viewer && this.viewer.entities) {
      const entitiesToRemove = [
        this.pyramidEntity,
        this.footprintEntity,
        this.footprintOutlineEntity,
        this.opticalAxisEntity,
        this.reticleEntity,
      ];

      for (const e of entitiesToRemove) {
        if (e) {
          if (typeof this.viewer.entities.remove === 'function') {
            this.viewer.entities.remove(e);
          } else if (typeof this.viewer.entities.removeById === 'function') {
            this.viewer.entities.removeById(e.id);
          }
        }
      }
    }

    this.pyramidEntity = null;
    this.footprintEntity = null;
    this.footprintOutlineEntity = null;
    this.opticalAxisEntity = null;
    this.reticleEntity = null;
    this.viewer = null;
    this.lastResult = null;
  }

  /**
   * Ensures that all required Cesium entities are created and tracked.
   */
  private ensureEntities(): void {
    if (!this.viewer || !this.viewer.entities) return;

    const edgeColor = Cesium.Color.fromCssColorString(this.options.edgeColorHex).withAlpha(
      this.options.edgeAlpha
    );
    const footprintColor = Cesium.Color.fromCssColorString(this.options.footprintColorHex).withAlpha(
      this.options.footprintAlpha
    );
    const opticalAxisColor = Cesium.Color.fromCssColorString(this.options.opticalAxisColorHex).withAlpha(
      this.options.opticalAxisAlpha
    );
    const reticleColor = Cesium.Color.fromCssColorString(this.options.reticleColorHex);

    // 1. Pyramid Wireframe Edges Entity
    if (!this.pyramidEntity) {
      this.pyramidEntity = this.viewer.entities.add({
        id: FRUSTUM_ENTITY_PYRAMID,
        name: 'Gimbal Frustum Pyramid Edges',
        show: this.visible,
        polyline: {
          positions: [],
          width: this.options.edgeWidth,
          material: edgeColor,
        },
      });
    }

    // 2. Ground Footprint Polygon Entity
    if (!this.footprintEntity) {
      this.footprintEntity = this.viewer.entities.add({
        id: FRUSTUM_ENTITY_FOOTPRINT,
        name: 'Gimbal Footprint Polygon',
        show: this.visible,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy([]),
          material: footprintColor,
          classificationType: Cesium.ClassificationType ? Cesium.ClassificationType.BOTH : undefined,
        },
      });
    }

    // 3. Ground Footprint Outline Entity
    if (!this.footprintOutlineEntity) {
      this.footprintOutlineEntity = this.viewer.entities.add({
        id: FRUSTUM_ENTITY_OUTLINE,
        name: 'Gimbal Footprint Outline',
        show: this.visible,
        polyline: {
          positions: [],
          width: this.options.footprintOutlineWidth,
          material: edgeColor,
          clampToGround: true,
        },
      });
    }

    // 4. Optical Axis Entity (Dashed)
    if (!this.opticalAxisEntity) {
      this.opticalAxisEntity = this.viewer.entities.add({
        id: FRUSTUM_ENTITY_OPTICAL_AXIS,
        name: 'Gimbal Optical Axis',
        show: this.visible,
        polyline: {
          positions: [],
          width: 1.5,
          material: new Cesium.PolylineDashMaterialProperty({
            color: opticalAxisColor,
            dashLength: 8.0,
          }),
        },
      });
    }

    // 5. Center Reticle Target Entity
    if (!this.reticleEntity) {
      this.reticleEntity = this.viewer.entities.add({
        id: FRUSTUM_ENTITY_RETICLE,
        name: 'Gimbal Target Reticle',
        show: this.visible,
        position: undefined,
        point: {
          pixelSize: this.options.reticleSize,
          color: reticleColor,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }

  /**
   * Synchronizes Cesium entity geometries with the calculated frustum result.
   */
  private syncEntities(result: FrustumGeometryResult): void {
    const apexCartesian = Cesium.Cartesian3.fromDegrees(
      result.apex[0],
      result.apex[1],
      result.apex[2]
    );

    const centerCartesian = Cesium.Cartesian3.fromDegrees(
      result.footprintCenter[0],
      result.footprintCenter[1],
      result.footprintCenter[2]
    );

    const rayCartesians = result.rays.map((ray) =>
      Cesium.Cartesian3.fromDegrees(ray[0], ray[1], ray[2])
    );

    // 1. Pyramid Wireframe Edges:
    // Connect apex -> ray0 -> apex -> ray1 -> apex -> ray2 -> apex -> ray3
    // plus ray0 -> ray1 -> ray2 -> ray3 -> ray0 base loop if not intersecting ground
    const edgePositions: Cesium.Cartesian3[] = [];
    if (rayCartesians.length === 4) {
      edgePositions.push(
        apexCartesian, rayCartesians[0],
        apexCartesian, rayCartesians[1],
        apexCartesian, rayCartesians[2],
        apexCartesian, rayCartesians[3]
      );
      if (!result.intersectsGround) {
        // Wireframe base loop in sky
        edgePositions.push(
          rayCartesians[0], rayCartesians[1],
          rayCartesians[2], rayCartesians[3],
          rayCartesians[0]
        );
      }
    }

    if (this.pyramidEntity?.polyline) {
      this.pyramidEntity.polyline.positions = new Cesium.ConstantProperty(edgePositions);
      this.pyramidEntity.show = this.visible;
    }

    // 2. Optical Axis
    if (this.opticalAxisEntity?.polyline) {
      this.opticalAxisEntity.polyline.positions = new Cesium.ConstantProperty([
        apexCartesian,
        centerCartesian,
      ]);
      this.opticalAxisEntity.show = this.visible;
    }

    // 3. Ground Footprint Polygon & Outline
    const hasGroundFootprint = result.intersectsGround && result.footprintPolygon.length >= 3;
    const footprintCartesians = hasGroundFootprint
      ? result.footprintPolygon.map((pt) => Cesium.Cartesian3.fromDegrees(pt[0], pt[1], pt[2]))
      : [];

    if (this.footprintEntity?.polygon) {
      this.footprintEntity.polygon.hierarchy = new Cesium.ConstantProperty(
        new Cesium.PolygonHierarchy(footprintCartesians)
      );
      this.footprintEntity.show = this.visible && hasGroundFootprint;
    }

    if (this.footprintOutlineEntity?.polyline) {
      const closedOutline = hasGroundFootprint
        ? [...footprintCartesians, footprintCartesians[0]]
        : [];
      this.footprintOutlineEntity.polyline.positions = new Cesium.ConstantProperty(closedOutline);
      this.footprintOutlineEntity.show = this.visible && hasGroundFootprint;
    }

    // 4. Reticle Target
    if (this.reticleEntity) {
      this.reticleEntity.position = new Cesium.ConstantPositionProperty(centerCartesian);
      this.reticleEntity.show = this.visible && hasGroundFootprint;
    }
  }
}
