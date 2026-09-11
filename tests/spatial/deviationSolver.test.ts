import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  parseWPMLRoute,
  buildMockWPMLString,
  buildMockWPMLKMZ,
} from '../../src/parser/wpmlParser';
import {
  calculateTrajectoryDeviation,
} from '../../src/spatial/deviationSolver';
import {
  createEmptyFlightPackage,
  WPMLRoute,
} from '../../src/core/types';

describe('DJI WPML Route Parser', () => {
  it('should parse standard WPML XML string with waypoints, coordinates, speed, height, and gimbal angles', async () => {
    const xml = buildMockWPMLString([
      {
        index: 0,
        lon: 120.123456,
        lat: 30.654321,
        alt: 100.0,
        speed: 5.0,
        gimbalPitch: -30.0,
        gimbalYaw: 90.0,
      },
      {
        index: 1,
        lon: 120.124456,
        lat: 30.655321,
        alt: 120.0,
        speed: 8.0,
        gimbalPitch: -45.0,
        gimbalYaw: 135.0,
      },
    ], {
      name: 'Power_Line_Patrol_01',
      takeOffSecurityHeight: 25.0,
      globalSpeed: 6.0,
    });

    const route = await parseWPMLRoute(xml);

    expect(route.name).toBe('Power_Line_Patrol_01');
    expect(route.takeOffSecurityHeight).toBe(25.0);
    expect(route.globalSpeed).toBe(6.0);
    expect(route.waypoints.length).toBe(2);

    expect(route.waypoints[0].index).toBe(0);
    expect(route.waypoints[0].lon).toBeCloseTo(120.123456, 6);
    expect(route.waypoints[0].lat).toBeCloseTo(30.654321, 6);
    expect(route.waypoints[0].alt).toBeCloseTo(100.0, 1);
    expect(route.waypoints[0].speed).toBe(5.0);
    expect(route.waypoints[0].gimbalPitch).toBe(-30.0);
    expect(route.waypoints[0].gimbalYaw).toBe(90.0);

    expect(route.waypoints[1].index).toBe(1);
    expect(route.waypoints[1].lon).toBeCloseTo(120.124456, 6);
    expect(route.waypoints[1].lat).toBeCloseTo(30.655321, 6);
    expect(route.waypoints[1].alt).toBeCloseTo(120.0, 1);
    expect(route.waypoints[1].speed).toBe(8.0);
    expect(route.waypoints[1].gimbalPitch).toBe(-45.0);
    expect(route.waypoints[1].gimbalYaw).toBe(135.0);
  });

  it('should parse KMZ zip buffer containing wpmz/waylines.wpml', async () => {
    const kmzBuffer = await buildMockWPMLKMZ([
      { index: 0, lon: 114.0, lat: 22.5, alt: 50.0, speed: 4.0 },
      { index: 1, lon: 114.001, lat: 22.501, alt: 60.0, speed: 4.0 },
    ], { name: 'KMZ_Test_Route' });

    const route = await parseWPMLRoute(kmzBuffer);

    expect(route.name).toBe('KMZ_Test_Route');
    expect(route.waypoints.length).toBe(2);
    expect(route.waypoints[0].lon).toBeCloseTo(114.0, 5);
    expect(route.waypoints[0].lat).toBeCloseTo(22.5, 5);
    expect(route.waypoints[0].alt).toBe(50.0);
  });

  it('should parse KMZ zip buffer containing template.kml as fallback', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Template_KML_Route</name>
    <Placemark>
      <Point><coordinates>113.123,23.456,80.0</coordinates></Point>
      <executeHeight>85.0</executeHeight>
      <waypointSpeed>7.5</waypointSpeed>
    </Placemark>
  </Document>
</kml>`;
    const zip = new JSZip();
    zip.file('template.kml', xml);
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });

    const route = await parseWPMLRoute(buffer);
    expect(route.name).toBe('Template_KML_Route');
    expect(route.waypoints.length).toBe(1);
    expect(route.waypoints[0].lon).toBeCloseTo(113.123, 3);
    expect(route.waypoints[0].lat).toBeCloseTo(23.456, 3);
    expect(route.waypoints[0].alt).toBe(85.0);
    expect(route.waypoints[0].speed).toBe(7.5);
  });

  it('should parse direct tags <wpml:gimbalPitchAngle> and <wpml:waypointHeadingAngle>', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.3">
  <Document>
    <Placemark>
      <Point><coordinates>121.0,31.0</coordinates></Point>
      <wpml:executeHeight>110.0</wpml:executeHeight>
      <wpml:gimbalPitchAngle>-60.0</wpml:gimbalPitchAngle>
      <wpml:waypointHeadingAngle>180.0</wpml:waypointHeadingAngle>
    </Placemark>
  </Document>
</kml>`;
    const route = await parseWPMLRoute(xml);
    expect(route.waypoints.length).toBe(1);
    expect(route.waypoints[0].gimbalPitch).toBe(-60.0);
    expect(route.waypoints[0].gimbalYaw).toBe(180.0);
  });

  it('should handle empty or minimal WPML gracefully', async () => {
    const emptyXml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document></Document></kml>`;
    const route = await parseWPMLRoute(emptyXml);
    expect(route.waypoints).toEqual([]);
  });
});

describe('3D Trajectory Spatial Deviation Solver', () => {
  const plannedRoute: WPMLRoute = {
    name: 'Standard_Path',
    waypoints: [
      { index: 0, lon: 120.000000, lat: 30.000000, alt: 100.0, speed: 5.0 },
      { index: 1, lon: 120.001000, lat: 30.000000, alt: 100.0, speed: 5.0 },
    ],
  };

  it('should calculate zero deviation when actual trajectory is directly on the planned segment', () => {
    const pkg = createEmptyFlightPackage();
    // Midpoint between waypoint 0 and 1: lon 120.000500, lat 30.000000, alt 100.0
    pkg.telemetry.longitudes = new Float64Array([120.000500]);
    pkg.telemetry.latitudes = new Float64Array([30.000000]);
    pkg.telemetry.altitudes = new Float32Array([100.0]);
    pkg.telemetry.timestamps = new Float64Array([1000]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);

    expect(result.deviations.length).toBe(1);
    const d = result.deviations[0];
    expect(d.euclideanDistance).toBeCloseTo(0, 2);
    expect(d.lateralDiff).toBeCloseTo(0, 2);
    expect(d.verticalDiff).toBeCloseTo(0, 2);
    expect(d.status).toBe('normal');
    expect(result.stats.maxDeviation).toBeCloseTo(0, 2);
    expect(result.stats.warningCount).toBe(0);
    expect(result.stats.criticalCount).toBe(0);
  });

  it('should accurately calculate pure vertical offsets and categorize statuses (<0.5m normal, 0.5-1m warning, >1m critical)', () => {
    const pkg = createEmptyFlightPackage();
    // 3 points along the line:
    // Pt 1: alt +0.3m (normal)
    // Pt 2: alt +0.8m (warning)
    // Pt 3: alt -1.5m (critical)
    pkg.telemetry.longitudes = new Float64Array([120.000200, 120.000500, 120.000800]);
    pkg.telemetry.latitudes = new Float64Array([30.000000, 30.000000, 30.000000]);
    pkg.telemetry.altitudes = new Float32Array([100.3, 100.8, 98.5]);
    pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);

    expect(result.deviations.length).toBe(3);

    // Pt 1
    expect(result.deviations[0].lateralDiff).toBeCloseTo(0, 2);
    expect(result.deviations[0].verticalDiff).toBeCloseTo(0.3, 2);
    expect(result.deviations[0].euclideanDistance).toBeCloseTo(0.3, 2);
    expect(result.deviations[0].status).toBe('normal');

    // Pt 2
    expect(result.deviations[1].lateralDiff).toBeCloseTo(0, 2);
    expect(result.deviations[1].verticalDiff).toBeCloseTo(0.8, 2);
    expect(result.deviations[1].euclideanDistance).toBeCloseTo(0.8, 2);
    expect(result.deviations[1].status).toBe('warning');

    // Pt 3
    expect(result.deviations[2].lateralDiff).toBeCloseTo(0, 2);
    expect(result.deviations[2].verticalDiff).toBeCloseTo(1.5, 2);
    expect(result.deviations[2].euclideanDistance).toBeCloseTo(1.5, 2);
    expect(result.deviations[2].status).toBe('critical');

    // Stats
    expect(result.stats.maxDeviation).toBeCloseTo(1.5, 2);
    expect(result.stats.maxVerticalDiff).toBeCloseTo(1.5, 2);
    expect(result.stats.maxLateralDiff).toBeCloseTo(0, 2);
    expect(result.stats.warningCount).toBe(1);
    expect(result.stats.criticalCount).toBe(1);
  });

  it('should accurately calculate lateral offsets with geodesic projection', () => {
    const pkg = createEmptyFlightPackage();
    // At lat 30 deg, 1 deg of latitude is approx 110,852 m (1 micro-degree ~ 0.111 m)
    // 0.000007 deg lat ≈ 0.77 m north (warning)
    // 0.000015 deg lat ≈ 1.66 m north (critical)
    pkg.telemetry.longitudes = new Float64Array([120.000500, 120.000500]);
    pkg.telemetry.latitudes = new Float64Array([30.000007, 30.000015]);
    pkg.telemetry.altitudes = new Float32Array([100.0, 100.0]);
    pkg.telemetry.timestamps = new Float64Array([1000, 2000]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);

    expect(result.deviations[0].verticalDiff).toBeCloseTo(0, 2);
    expect(result.deviations[0].lateralDiff).toBeGreaterThan(0.7);
    expect(result.deviations[0].lateralDiff).toBeLessThan(0.9);
    expect(result.deviations[0].status).toBe('warning');

    expect(result.deviations[1].lateralDiff).toBeGreaterThan(1.5);
    expect(result.deviations[1].status).toBe('critical');
  });

  it('should correctly clamp projections before start waypoint and after end waypoint', () => {
    const pkg = createEmptyFlightPackage();
    // Pt before start: lon 119.999000 (west of waypoint 0 at 120.000000)
    // Pt after end: lon 120.002000 (east of waypoint 1 at 120.001000)
    pkg.telemetry.longitudes = new Float64Array([119.999000, 120.002000]);
    pkg.telemetry.latitudes = new Float64Array([30.000000, 30.000000]);
    pkg.telemetry.altitudes = new Float32Array([100.0, 100.0]);
    pkg.telemetry.timestamps = new Float64Array([1000, 2000]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);

    // Projection of point before start should be clamped to waypoint 0 (lon 120.000000)
    expect(result.deviations[0].projectedPoint[0]).toBeCloseTo(120.000000, 5);
    expect(result.deviations[0].projectedPoint[1]).toBeCloseTo(30.000000, 5);
    expect(result.deviations[0].euclideanDistance).toBeGreaterThan(50);

    // Projection of point after end should be clamped to waypoint 1 (lon 120.001000)
    expect(result.deviations[1].projectedPoint[0]).toBeCloseTo(120.001000, 5);
    expect(result.deviations[1].projectedPoint[1]).toBeCloseTo(30.000000, 5);
    expect(result.deviations[1].euclideanDistance).toBeGreaterThan(50);
  });

  it('should handle single waypoint route by projecting directly to that waypoint', () => {
    const singlePointRoute: WPMLRoute = {
      name: 'Hover_Route',
      waypoints: [
        { index: 0, lon: 120.000000, lat: 30.000000, alt: 50.0 },
      ],
    };

    const pkg = createEmptyFlightPackage();
    pkg.telemetry.longitudes = new Float64Array([120.000000]);
    pkg.telemetry.latitudes = new Float64Array([30.000000]);
    pkg.telemetry.altitudes = new Float32Array([52.0]);
    pkg.telemetry.timestamps = new Float64Array([1000]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, singlePointRoute);
    expect(result.deviations.length).toBe(1);
    expect(result.deviations[0].verticalDiff).toBeCloseTo(2.0, 2);
    expect(result.deviations[0].lateralDiff).toBeCloseTo(0, 2);
    expect(result.deviations[0].euclideanDistance).toBeCloseTo(2.0, 2);
    expect(result.deviations[0].status).toBe('critical');
  });

  it('should handle multi-segment 3D polyline and find the nearest segment', () => {
    const cornerRoute: WPMLRoute = {
      name: 'Corner_Route',
      waypoints: [
        { index: 0, lon: 120.000000, lat: 30.000000, alt: 50.0 },
        { index: 1, lon: 120.001000, lat: 30.000000, alt: 50.0 }, // Seg 0: heading East
        { index: 2, lon: 120.001000, lat: 30.001000, alt: 80.0 }, // Seg 1: heading North, climbing
      ],
    };

    const pkg = createEmptyFlightPackage();
    // Point closer to Seg 1 (heading north): lon 120.001000, lat 30.000500, alt 65.0 (midpoint of seg 1)
    pkg.telemetry.longitudes = new Float64Array([120.001000]);
    pkg.telemetry.latitudes = new Float64Array([30.000500]);
    pkg.telemetry.altitudes = new Float32Array([65.0]);
    pkg.telemetry.timestamps = new Float64Array([1000]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, cornerRoute);

    expect(result.deviations[0].euclideanDistance).toBeCloseTo(0, 1);
    expect(result.deviations[0].projectedPoint[2]).toBeCloseTo(65.0, 1);
  });

  it('should aggregate statistical metrics properly including averageDeviation alias', () => {
    const pkg = createEmptyFlightPackage();
    pkg.telemetry.longitudes = new Float64Array([120.000200, 120.000500]);
    pkg.telemetry.latitudes = new Float64Array([30.000000, 30.000000]);
    pkg.telemetry.altitudes = new Float32Array([100.2, 100.8]);
    pkg.telemetry.timestamps = new Float64Array([1000, 2000]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);

    expect(result.stats.avgDeviation).toBeCloseTo(0.5, 1);
    expect(result.stats.averageDeviation).toBeCloseTo(0.5, 1);
    expect(result.stats.maxDeviation).toBeCloseTo(0.8, 1);
    expect(result.stats.maxVerticalDiff).toBeCloseTo(0.8, 1);
    expect(result.stats.maxLateralDiff).toBeCloseTo(0, 1);
  });

  it('should achieve high throughput (>10,000 points in < 100ms)', () => {
    const N = 10000;
    const pkg = createEmptyFlightPackage();
    pkg.telemetry.longitudes = new Float64Array(N);
    pkg.telemetry.latitudes = new Float64Array(N);
    pkg.telemetry.altitudes = new Float32Array(N);
    pkg.telemetry.timestamps = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      pkg.telemetry.longitudes[i] = 120.0 + (i / N) * 0.001;
      pkg.telemetry.latitudes[i] = 30.0;
      pkg.telemetry.altitudes[i] = 100.0 + (i % 5) * 0.1;
      pkg.telemetry.timestamps[i] = i * 100;
    }

    const t0 = performance.now();
    const result = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);
    const duration = performance.now() - t0;

    expect(result.deviations.length).toBe(N);
    expect(duration).toBeLessThan(150); // fast execution
  });

  it('should handle empty telemetry and empty route gracefully', () => {
    const pkg = createEmptyFlightPackage();
    const result = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);

    expect(result.deviations).toEqual([]);
    expect(result.stats.maxDeviation).toBe(0);
    expect(result.stats.avgDeviation).toBe(0);
    expect(result.stats.averageDeviation).toBe(0);
    expect(result.stats.warningCount).toBe(0);
    expect(result.stats.criticalCount).toBe(0);

    const emptyRoute: WPMLRoute = { name: 'Empty', waypoints: [] };
    const resultEmptyRoute = calculateTrajectoryDeviation(pkg.telemetry, emptyRoute);
    expect(resultEmptyRoute.deviations).toEqual([]);
  });
});
