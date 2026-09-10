import { describe, it, expect } from 'vitest';
import {
  createEmptyFlightPackage,
  FlightRecordPackage,
  WPMLRoute,
  DeviationResult,
} from '../../src/core/types';

describe('Flight Record Types Contract', () => {
  it('should initialize empty flight package with typed arrays', () => {
    const pkg = createEmptyFlightPackage();

    // Meta checks
    expect(pkg.meta.aircraftType).toBe('Unknown');
    expect(pkg.meta.aircraftSn).toBe('');
    expect(pkg.meta.batterySnList).toEqual([]);
    expect(pkg.meta.startTime).toBe(0);
    expect(pkg.meta.durationMs).toBe(0);
    expect(pkg.meta.totalDistance).toBe(0);
    expect(pkg.meta.maxAltitude).toBe(0);
    expect(pkg.meta.homeLocation).toEqual([0, 0, 0]);

    // Telemetry TypedArray checks
    expect(pkg.telemetry.timestamps).toBeInstanceOf(Float64Array);
    expect(pkg.telemetry.longitudes).toBeInstanceOf(Float64Array);
    expect(pkg.telemetry.latitudes).toBeInstanceOf(Float64Array);
    expect(pkg.telemetry.altitudes).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.heights).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.pitch).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.roll).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.yaw).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.speeds).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.rtkStatus).toBeInstanceOf(Uint8Array);
    expect(pkg.telemetry.batteryPercents).toBeInstanceOf(Uint8Array);
    expect(pkg.telemetry.batteryVoltages).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.maxCellVoltageDiff).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.maxCellTemp).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.gimbalPitch).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.gimbalYaw).toBeInstanceOf(Float32Array);

    // Initial lengths must be 0
    expect(pkg.telemetry.timestamps.length).toBe(0);
    expect(pkg.telemetry.longitudes.length).toBe(0);

    // Events checks
    expect(pkg.events.photos).toEqual([]);
    expect(pkg.events.warnings).toEqual([]);
  });

  it('should support populating telemetry and events with valid contracts', () => {
    const pkg: FlightRecordPackage = createEmptyFlightPackage();
    pkg.meta.aircraftType = 'Matrice 350 RTK';
    pkg.meta.aircraftSn = '1581F5FMD2340001';
    pkg.meta.homeLocation = [120.123456, 30.123456, 50.0];

    pkg.telemetry.timestamps = new Float64Array([1710000000000, 1710000001000]);
    pkg.telemetry.longitudes = new Float64Array([120.123456, 120.123500]);
    pkg.telemetry.latitudes = new Float64Array([30.123456, 30.123500]);
    pkg.telemetry.altitudes = new Float32Array([100.0, 101.5]);

    pkg.events.photos.push({
      id: 'photo-1',
      timestamp: 1710000000500,
      index: 1,
      position: [120.12348, 30.12348, 100.8],
      gimbalAngles: [-45, 0, 90],
      thumbnailBase64: 'data:image/jpeg;base64,...',
    });

    pkg.events.warnings.push({
      timestamp: 1710000001000,
      level: 'warning',
      code: 1001,
      message: 'High wind speed detected',
    });

    expect(pkg.meta.aircraftType).toBe('Matrice 350 RTK');
    expect(pkg.telemetry.timestamps.length).toBe(2);
    expect(pkg.events.photos.length).toBe(1);
    expect(pkg.events.warnings[0].level).toBe('warning');
  });

  it('should validate WPMLRoute and DeviationResult types compile and construct accurately', () => {
    const route: WPMLRoute = {
      name: 'Powerline_Tower_01',
      waypoints: [
        { index: 0, lon: 120.0, lat: 30.0, alt: 80.0, speed: 5.0 },
        { index: 1, lon: 120.001, lat: 30.001, alt: 85.0, speed: 5.0 },
      ],
      takeOffSecurityHeight: 30,
      globalSpeed: 5.0,
    };
    expect(route.name).toBe('Powerline_Tower_01');
    expect(route.waypoints.length).toBe(2);

    const devResult: DeviationResult = {
      deviations: [
        {
          index: 0,
          timestamp: 1710000000000,
          lon: 120.0005,
          lat: 30.0005,
          alt: 82.5,
          projectedPoint: [120.0005, 30.0005, 82.0],
          euclideanDistance: 0.5,
          lateralDiff: 0.1,
          verticalDiff: 0.5,
          status: 'warning',
        },
      ],
      stats: {
        maxDeviation: 0.5,
        avgDeviation: 0.5,
        maxVerticalDiff: 0.5,
        maxLateralDiff: 0.1,
        warningCount: 1,
        criticalCount: 0,
      },
    };
    expect(devResult.deviations[0].status).toBe('warning');
    expect(devResult.stats.maxDeviation).toBe(0.5);
  });
});
