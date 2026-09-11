import { describe, it, expect } from 'vitest';
import {
  generateTrajectorySegments,
  interpolateTelemetryAtTime,
  eulerToHeadingPitchRoll,
  calculateCameraHeadingPitchRange,
  interpolateAngleDeg,
  type TrajectorySegment,
  type InterpolatedTelemetry,
} from '../../src/viewport/trajectoryLayer';
import { createEmptyFlightPackage, type DeviationResult } from '../../src/core/types';

describe('Trajectory Layer Segmenter & Pure Math', () => {
  describe('generateTrajectorySegments - RTK color scale', () => {
    it('should generate color-coded polyline segments according to RTK status', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.0001, 120.0002]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.0001, 30.0002]);
      pkg.telemetry.altitudes = new Float32Array([100, 105, 110]);
      pkg.telemetry.rtkStatus = new Uint8Array([50, 32, 0]); // Fixed, Float, None

      const segments = generateTrajectorySegments(pkg.telemetry, 'rtk');
      expect(segments.length).toBe(2);
      expect(segments[0].colorHex).toBe('#00E676'); // Green for Fixed
      expect(segments[1].colorHex).toBe('#FFD600'); // Yellow for Float
    });

    it('should handle Single RTK status and unknown/none codes', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000, 4000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.001, 120.002, 120.003]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.001, 30.002, 30.003]);
      pkg.telemetry.altitudes = new Float32Array([100, 100, 100, 100]);
      pkg.telemetry.rtkStatus = new Uint8Array([50, 16, 0, 0]); // Fixed, Single, None

      const segments = generateTrajectorySegments(pkg.telemetry, 'rtk');
      expect(segments.length).toBe(3);
      expect(segments[0].colorHex).toBe('#00E676'); // 50 Fixed
      expect(segments[1].colorHex).toBe('#FF9100'); // 16 Single
      expect(segments[2].colorHex).toBe('#FF1744'); // 0 None
    });
  });

  describe('generateTrajectorySegments - Deviation color scale', () => {
    it('should map deviation status correctly: normal (<0.5m), warning (0.5-1.0m), critical (>1.0m)', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000, 4000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.001, 120.002, 120.003]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.001, 30.002, 30.003]);
      pkg.telemetry.altitudes = new Float32Array([100, 100, 100, 100]);

      const mockDeviation: DeviationResult = {
        deviations: [
          {
            index: 0,
            timestamp: 1000,
            lon: 120.0,
            lat: 30.0,
            alt: 100,
            projectedPoint: [120.0, 30.0, 100],
            euclideanDistance: 0.2, // normal
            lateralDiff: 0.1,
            verticalDiff: 0.1,
            status: 'normal',
          },
          {
            index: 1,
            timestamp: 2000,
            lon: 120.001,
            lat: 30.001,
            alt: 100,
            projectedPoint: [120.001, 30.001, 100],
            euclideanDistance: 0.75, // warning
            lateralDiff: 0.7,
            verticalDiff: 0.1,
            status: 'warning',
          },
          {
            index: 2,
            timestamp: 3000,
            lon: 120.002,
            lat: 30.002,
            alt: 100,
            projectedPoint: [120.002, 30.002, 100],
            euclideanDistance: 1.5, // critical
            lateralDiff: 1.2,
            verticalDiff: 0.8,
            status: 'critical',
          },
          {
            index: 3,
            timestamp: 4000,
            lon: 120.003,
            lat: 30.003,
            alt: 100,
            projectedPoint: [120.003, 30.003, 100],
            euclideanDistance: 0.1,
            lateralDiff: 0.1,
            verticalDiff: 0.0,
            status: 'normal',
          },
        ],
        stats: {
          maxDeviation: 1.5,
          avgDeviation: 0.63,
          maxVerticalDiff: 0.8,
          maxLateralDiff: 1.2,
          warningCount: 1,
          criticalCount: 1,
        },
      };

      const segments = generateTrajectorySegments(pkg.telemetry, 'deviation', mockDeviation);
      expect(segments.length).toBe(3);
      expect(segments[0].colorHex).toBe('#00E676'); // normal
      expect(segments[1].colorHex).toBe('#FFD600'); // warning
      expect(segments[2].colorHex).toBe('#FF1744'); // critical
    });
  });

  describe('generateTrajectorySegments - Altitude & Speed color scales & Altitude Options', () => {
    it('should generate continuous color ramp for altitude mode', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.001, 120.002]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.001, 30.002]);
      pkg.telemetry.altitudes = new Float32Array([10, 50, 100]); // 10m to 100m

      const segments = generateTrajectorySegments(pkg.telemetry, 'altitude');
      expect(segments.length).toBe(2);
      expect(segments[0].colorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(segments[1].colorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // Segment 0 (low altitude) should differ from segment 1 (high altitude)
      expect(segments[0].colorHex).not.toBe(segments[1].colorHex);
    });

    it('should respect altitudeSource heights and altitudeOffset', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.001]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.001]);
      pkg.telemetry.altitudes = new Float32Array([500, 500]);
      pkg.telemetry.heights = new Float32Array([15, 25]);

      const segments = generateTrajectorySegments(pkg.telemetry, 'altitude', undefined, {
        altitudeSource: 'heights',
        altitudeOffset: 10.5,
      });

      expect(segments.length).toBe(1);
      // First point altitude in segment should be 15 + 10.5 = 25.5
      expect(segments[0].points[0][2]).toBeCloseTo(25.5, 3);
      // Second point altitude in segment should be 25 + 10.5 = 35.5
      expect(segments[0].points[1][2]).toBeCloseTo(35.5, 3);
    });

    it('should generate color ramp for speed mode', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.001, 120.002]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.001, 30.002]);
      pkg.telemetry.altitudes = new Float32Array([100, 100, 100]);
      pkg.telemetry.speeds = new Float32Array([0, 7.5, 15.0]); // 0 to 15 m/s

      const segments = generateTrajectorySegments(pkg.telemetry, 'speed');
      expect(segments.length).toBe(2);
      expect(segments[0].colorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(segments[1].colorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it('should handle edge cases: empty or single point telemetry', () => {
      const emptyPkg = createEmptyFlightPackage();
      expect(generateTrajectorySegments(emptyPkg.telemetry, 'rtk')).toEqual([]);

      const singlePoint = createEmptyFlightPackage();
      singlePoint.telemetry.timestamps = new Float64Array([1000]);
      singlePoint.telemetry.longitudes = new Float64Array([120.0]);
      singlePoint.telemetry.latitudes = new Float64Array([30.0]);
      singlePoint.telemetry.altitudes = new Float32Array([100]);
      expect(generateTrajectorySegments(singlePoint.telemetry, 'rtk')).toEqual([]);
    });
  });

  describe('Time-to-index search and linear interpolation', () => {
    it('should interpolate exact matching timestamp', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.01, 120.02]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.01, 30.02]);
      pkg.telemetry.altitudes = new Float32Array([100, 120, 140]);
      pkg.telemetry.heights = new Float32Array([10, 20, 30]);
      pkg.telemetry.speeds = new Float32Array([5, 10, 15]);
      pkg.telemetry.pitch = new Float32Array([-5, 0, 5]);
      pkg.telemetry.roll = new Float32Array([1, 2, 3]);
      pkg.telemetry.yaw = new Float32Array([90, 100, 110]);
      pkg.telemetry.rtkStatus = new Uint8Array([50, 32, 50]);
      pkg.telemetry.batteryPercents = new Uint8Array([90, 89, 88]);
      pkg.telemetry.batteryVoltages = new Float32Array([25.2, 25.1, 25.0]);
      pkg.telemetry.gimbalPitch = new Float32Array([-30, -45, -60]);
      pkg.telemetry.gimbalYaw = new Float32Array([0, 10, 20]);

      const state = interpolateTelemetryAtTime(pkg.telemetry, 2000);
      expect(state).not.toBeNull();
      expect(state!.timestamp).toBe(2000);
      expect(state!.longitude).toBeCloseTo(120.01, 5);
      expect(state!.latitude).toBeCloseTo(30.01, 5);
      expect(state!.altitude).toBeCloseTo(120, 2);
      expect(state!.speed).toBeCloseTo(10, 2);
      expect(state!.pitch).toBeCloseTo(0, 2);
      expect(state!.yaw).toBeCloseTo(100, 2);
      expect(state!.rtkStatus).toBe(32);
    });

    it('should linearly interpolate values between two timestamps', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.02]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.04]);
      pkg.telemetry.altitudes = new Float32Array([100, 200]);
      pkg.telemetry.heights = new Float32Array([10, 30]);
      pkg.telemetry.speeds = new Float32Array([10, 20]);
      pkg.telemetry.pitch = new Float32Array([0, 10]);
      pkg.telemetry.roll = new Float32Array([0, 4]);
      pkg.telemetry.yaw = new Float32Array([350, 10]); // Crosses 360/0 degree boundary!
      pkg.telemetry.rtkStatus = new Uint8Array([50, 32]);
      pkg.telemetry.batteryPercents = new Uint8Array([90, 88]);
      pkg.telemetry.batteryVoltages = new Float32Array([24.0, 23.0]);
      pkg.telemetry.gimbalPitch = new Float32Array([-10, -30]);
      pkg.telemetry.gimbalYaw = new Float32Array([0, 20]);

      // Midpoint: t = 1500 (alpha = 0.5)
      const state = interpolateTelemetryAtTime(pkg.telemetry, 1500);
      expect(state).not.toBeNull();
      expect(state!.longitude).toBeCloseTo(120.01, 5);
      expect(state!.latitude).toBeCloseTo(30.02, 5);
      expect(state!.altitude).toBeCloseTo(150, 2);
      expect(state!.height).toBeCloseTo(20, 2);
      expect(state!.speed).toBeCloseTo(15, 2);
      expect(state!.pitch).toBeCloseTo(5, 2);
      expect(state!.roll).toBeCloseTo(2, 2);
      // Yaw shortest path: 350 to 10 is +20 deg difference across 0, halfway is 0 deg (or 360 deg)
      expect(state!.yaw).toBeCloseTo(0, 1);
      expect(state!.gimbalPitch).toBeCloseTo(-20, 2);
      expect(state!.gimbalYaw).toBeCloseTo(10, 2);
    });

    it('should clamp out-of-range timestamps gracefully', () => {
      const pkg = createEmptyFlightPackage();
      pkg.telemetry.timestamps = new Float64Array([1000, 2000]);
      pkg.telemetry.longitudes = new Float64Array([120.0, 120.02]);
      pkg.telemetry.latitudes = new Float64Array([30.0, 30.04]);
      pkg.telemetry.altitudes = new Float32Array([100, 200]);

      const before = interpolateTelemetryAtTime(pkg.telemetry, 500);
      expect(before).not.toBeNull();
      expect(before!.timestamp).toBe(1000);
      expect(before!.longitude).toBeCloseTo(120.0, 5);

      const after = interpolateTelemetryAtTime(pkg.telemetry, 3000);
      expect(after).not.toBeNull();
      expect(after!.timestamp).toBe(2000);
      expect(after!.longitude).toBeCloseTo(120.02, 5);
    });

    it('should return null on empty telemetry', () => {
      const emptyPkg = createEmptyFlightPackage();
      expect(interpolateTelemetryAtTime(emptyPkg.telemetry, 1000)).toBeNull();
    });
  });

  describe('Attitude conversion and camera tracking math', () => {
    it('should correctly convert Euler pitch/roll/yaw (degrees) to Cesium HeadingPitchRoll (radians)', () => {
      // 90 deg heading (East), 0 deg pitch, 0 deg roll
      const hpr = eulerToHeadingPitchRoll(0, 0, 90);
      expect(hpr.heading).toBeCloseTo(Math.PI / 2, 4);
      expect(hpr.pitch).toBeCloseTo(0, 4);
      expect(hpr.roll).toBeCloseTo(0, 4);

      // Pitch up 30 deg, roll 45 deg, yaw 180 deg (South)
      const hpr2 = eulerToHeadingPitchRoll(30, 45, 180);
      expect(hpr2.heading).toBeCloseTo(Math.PI, 4);
      expect(hpr2.pitch).toBeCloseTo((30 * Math.PI) / 180, 4);
      expect(hpr2.roll).toBeCloseTo((45 * Math.PI) / 180, 4);
    });

    it('should interpolate angles via shortest angular path', () => {
      expect(interpolateAngleDeg(10, 350, 0.5)).toBeCloseTo(0, 2);
      expect(interpolateAngleDeg(350, 10, 0.5)).toBeCloseTo(0, 2);
      expect(interpolateAngleDeg(0, 180, 0.5)).toBeCloseTo(90, 2);
      expect(interpolateAngleDeg(30, 90, 0.5)).toBeCloseTo(60, 2);
    });

    it('should calculate camera parameters for different tracking modes', () => {
      // Follow mode: heading behind aircraft, pitch angled down (-20 deg), distance default 35m
      const follow = calculateCameraHeadingPitchRange('follow', 90);
      expect(follow.heading).toBeCloseTo(Math.PI / 2, 4); // heading matches aircraft yaw
      expect(follow.pitch).toBeLessThan(0); // looks downward
      expect(follow.range).toBeGreaterThan(10);

      // Top-down mode: pitch is straight down (-Math.PI / 2 or -89 deg)
      const topDown = calculateCameraHeadingPitchRange('top_down', 90);
      expect(topDown.pitch).toBeCloseTo(-Math.PI / 2, 1);
      expect(topDown.range).toBeGreaterThan(follow.range);

      // FPV gimbal mode: pitch aligned with gimbal
      const fpv = calculateCameraHeadingPitchRange('fpv_gimbal', 90, -45);
      expect(fpv.heading).toBeCloseTo(Math.PI / 2, 4);
      expect(fpv.pitch).toBeCloseTo((-45 * Math.PI) / 180, 4);
      expect(fpv.range).toBeLessThanOrEqual(2); // close to aircraft center
    });
  });
});
