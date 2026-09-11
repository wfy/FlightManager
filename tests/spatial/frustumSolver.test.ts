import { describe, it, expect } from 'vitest';
import { calculateFrustumGeometry } from '../../src/spatial/frustumSolver';

describe('Gimbal Frustum Solver', () => {
  it('should calculate 4 pyramid rays and ground footprint polygon for oblique view', () => {
    const frustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0, // looking 45 deg down
      gimbalYaw: 90.0,    // looking East
      hfovDeg: 60.0,
      vfovDeg: 45.0,
      maxRangeMeters: 200.0,
    });
    expect(frustum.rays.length).toBe(4);
    expect(frustum.footprintPolygon.length).toBeGreaterThanOrEqual(3);
    // Footprint center must be east of the drone
    expect(frustum.footprintCenter[0]).toBeGreaterThan(120.0);
    expect(frustum.intersectsGround).toBe(true);
  });

  it('should position footprint centered directly under drone in Nadir view (pitch = -90 deg)', () => {
    const frustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -90.0,
      gimbalYaw: 0.0,
      hfovDeg: 60.0,
      vfovDeg: 45.0,
      maxRangeMeters: 500.0,
      groundAltitude: 0.0,
    });

    expect(frustum.intersectsGround).toBe(true);
    expect(frustum.footprintPolygon.length).toBe(4);

    // Footprint center must be directly under the drone
    expect(frustum.footprintCenter[0]).toBeCloseTo(120.0, 4);
    expect(frustum.footprintCenter[1]).toBeCloseTo(30.0, 4);
    expect(frustum.footprintCenter[2]).toBeCloseTo(0.0, 4);

    // Corner points should surround the center symmetrically
    const lons = frustum.footprintPolygon.map((p) => p[0]);
    const lats = frustum.footprintPolygon.map((p) => p[1]);
    expect(Math.min(...lons)).toBeLessThan(120.0);
    expect(Math.max(...lons)).toBeGreaterThan(120.0);
    expect(Math.min(...lats)).toBeLessThan(30.0);
    expect(Math.max(...lats)).toBeGreaterThan(30.0);
  });

  it('should project footprint North, South, and West according to gimbalYaw', () => {
    // North view (yaw = 0)
    const northFrustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0,
      gimbalYaw: 0.0,
    });
    expect(northFrustum.footprintCenter[1]).toBeGreaterThan(30.0);
    expect(northFrustum.footprintCenter[0]).toBeCloseTo(120.0, 4);

    // South view (yaw = 180)
    const southFrustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0,
      gimbalYaw: 180.0,
    });
    expect(southFrustum.footprintCenter[1]).toBeLessThan(30.0);
    expect(southFrustum.footprintCenter[0]).toBeCloseTo(120.0, 4);

    // West view (yaw = 270)
    const westFrustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0,
      gimbalYaw: 270.0,
    });
    expect(westFrustum.footprintCenter[0]).toBeLessThan(120.0);
    expect(westFrustum.footprintCenter[1]).toBeCloseTo(30.0, 4);
  });

  it('should handle horizontal and upward views gracefully without NaN or Inf values', () => {
    // Horizontal view (pitch = 0 deg)
    const horizFrustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: 0.0,
      gimbalYaw: 90.0,
      maxRangeMeters: 300.0,
    });

    expect(horizFrustum.rays.length).toBe(4);
    for (const ray of horizFrustum.rays) {
      expect(Number.isFinite(ray[0])).toBe(true);
      expect(Number.isFinite(ray[1])).toBe(true);
      expect(Number.isFinite(ray[2])).toBe(true);
      expect(Number.isNaN(ray[0])).toBe(false);
    }
    expect(Number.isFinite(horizFrustum.footprintCenter[0])).toBe(true);
    expect(Number.isFinite(horizFrustum.footprintCenter[1])).toBe(true);
    expect(Number.isFinite(horizFrustum.footprintCenter[2])).toBe(true);

    // Upward view (pitch = +30 deg)
    const upwardFrustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: 30.0,
      gimbalYaw: 90.0,
      maxRangeMeters: 300.0,
    });

    expect(upwardFrustum.intersectsGround).toBe(false);
    expect(upwardFrustum.footprintPolygon.length).toBe(0);
    expect(Number.isFinite(upwardFrustum.footprintCenter[0])).toBe(true);
    expect(Number.isFinite(upwardFrustum.footprintCenter[1])).toBe(true);
    expect(Number.isFinite(upwardFrustum.footprintCenter[2])).toBe(true);
  });

  it('should rotate/slant the footprint polygon when gimbalRoll is non-zero', () => {
    // Unrolled Nadir
    const unrolled = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -90.0,
      gimbalYaw: 0.0,
      gimbalRoll: 0.0,
      hfovDeg: 60.0,
      vfovDeg: 40.0,
    });

    // Rolled 45 degrees
    const rolled = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -90.0,
      gimbalYaw: 0.0,
      gimbalRoll: 45.0,
      hfovDeg: 60.0,
      vfovDeg: 40.0,
    });

    expect(unrolled.footprintPolygon.length).toBe(4);
    expect(rolled.footprintPolygon.length).toBe(4);

    // Corner 0 (Top-Left) vs Corner 1 (Top-Right)
    // In unrolled nadir, corner 0 and corner 1 have identical latitude (both at the top edge)
    expect(unrolled.footprintPolygon[0][1]).toBeCloseTo(unrolled.footprintPolygon[1][1], 5);

    // In 45-degree rolled nadir, corner 0 and corner 1 have clearly different latitudes
    const latDiffRolled = Math.abs(rolled.footprintPolygon[0][1] - rolled.footprintPolygon[1][1]);
    expect(latDiffRolled).toBeGreaterThan(0.0001);
  });

  it('should respect custom groundAltitude and target height', () => {
    const customGroundAlt = 45.0;
    const frustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0,
      gimbalYaw: 90.0,
      groundAltitude: customGroundAlt,
    });

    expect(frustum.intersectsGround).toBe(true);
    expect(frustum.footprintCenter[2]).toBeCloseTo(customGroundAlt, 4);
    for (const pt of frustum.footprintPolygon) {
      expect(pt[2]).toBeCloseTo(customGroundAlt, 4);
    }
  });

  it('should calculate valid normalized unit rays', () => {
    const frustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -60.0,
      gimbalYaw: 45.0,
      gimbalRoll: 15.0,
    });

    expect(frustum.unitRays).toBeDefined();
    expect(frustum.unitRays!.length).toBe(4);
    for (const ray of frustum.unitRays!) {
      const len = Math.sqrt(ray[0] * ray[0] + ray[1] * ray[1] + ray[2] * ray[2]);
      expect(len).toBeCloseTo(1.0, 5);
    }
  });
});
