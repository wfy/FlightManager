import { describe, it, expect, vi } from 'vitest';
import { FrustumLayer } from '../../src/viewport/frustumLayer';

describe('FrustumLayer', () => {
  it('should instantiate with default properties', () => {
    const layer = new FrustumLayer();
    expect(layer.isVisible()).toBe(true);
    expect(layer.getLastResult()).toBeNull();
  });

  it('should handle headless update without attached viewer gracefully', () => {
    const layer = new FrustumLayer();
    const result = layer.update({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0,
      gimbalYaw: 90.0,
      hfovDeg: 60.0,
      vfovDeg: 45.0,
    });

    expect(result).toBeDefined();
    expect(result.apex).toEqual([120.0, 30.0, 100.0]);
    expect(result.footprintPolygon.length).toBeGreaterThanOrEqual(3);
    expect(layer.getLastResult()).toEqual(result);

    // Visibility toggling
    layer.setVisible(false);
    expect(layer.isVisible()).toBe(false);

    // Safe destruction
    expect(() => layer.destroy()).not.toThrow();
  });

  it('should create and update Cesium entities when attached to viewer', () => {
    const addedEntities: any[] = [];
    const removedEntities: any[] = [];

    const mockViewer = {
      entities: {
        add: vi.fn((entityDef: any) => {
          const entity = { ...entityDef };
          addedEntities.push(entity);
          return entity;
        }),
        remove: vi.fn((entity: any) => {
          removedEntities.push(entity);
          return true;
        }),
        removeById: vi.fn((id: string) => {
          removedEntities.push({ id });
          return true;
        }),
      },
    };

    const layer = new FrustumLayer({
      edgeColorHex: '#FFD700',
      edgeAlpha: 0.8,
      footprintColorHex: '#FFD700',
      footprintAlpha: 0.25,
      opticalAxisAlpha: 0.7,
    });

    layer.attach(mockViewer);

    // Initial update with downward camera
    const result = layer.update({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0,
      gimbalYaw: 90.0,
      hfovDeg: 60.0,
      vfovDeg: 45.0,
    });

    expect(result.intersectsGround).toBe(true);
    expect(mockViewer.entities.add).toHaveBeenCalled();

    // Check that pyramid lines entity, footprint polygon, optical axis, and reticle exist
    const entityIds = addedEntities.map((e) => e.id);
    expect(entityIds).toContain('frustum-pyramid-edges');
    expect(entityIds).toContain('frustum-footprint-polygon');
    expect(entityIds).toContain('frustum-footprint-outline');
    expect(entityIds).toContain('frustum-optical-axis');
    expect(entityIds).toContain('frustum-reticle');

    // Toggle visibility
    layer.setVisible(false);
    expect(layer.isVisible()).toBe(false);
    for (const e of addedEntities) {
      if (e.show !== undefined) {
        expect(e.show).toBe(false);
      }
    }

    layer.setVisible(true);
    expect(layer.isVisible()).toBe(true);

    // Destroy should remove entities
    layer.destroy();
    expect(mockViewer.entities.remove).toHaveBeenCalled();
  });

  it('should update entities when gimbal pitches upward without ground intersection', () => {
    const addedEntities: any[] = [];
    const mockViewer = {
      entities: {
        add: vi.fn((entityDef: any) => {
          const entity = { ...entityDef };
          addedEntities.push(entity);
          return entity;
        }),
        remove: vi.fn(),
      },
    };

    const layer = new FrustumLayer();
    layer.attach(mockViewer);

    const upwardResult = layer.update({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: 30.0, // Upward towards sky
      gimbalYaw: 90.0,
    });

    expect(upwardResult.intersectsGround).toBe(false);
    expect(upwardResult.footprintPolygon.length).toBe(0);

    // Footprint entity should be hidden when not intersecting ground
    const footprintEntity = addedEntities.find((e) => e.id === 'frustum-footprint-polygon');
    if (footprintEntity) {
      expect(footprintEntity.show).toBe(false);
    }
  });
});
