/**
 * Trajectory Layer & 3D Spatiotemporal Math Engine
 *
 * Provides pure logic functions for:
 * 1. 3D trajectory polyline segment generation and multi-mode color mapping (RTK, Deviation, Altitude, Speed)
 * 2. High-precision time-to-index search and linear/angular interpolation for 6-DOF telemetry
 * 3. 6-DOF aircraft Euler angles to HeadingPitchRoll / Camera coordinate conversions
 */

import type { TelemetryStream, DeviationResult } from '../core/types';

export interface TrajectoryOptions {
  altitudeSource?: 'altitudes' | 'heights';
  altitudeOffset?: number;
  mergeConsecutive?: boolean;
}

export interface TrajectorySegment {
  startIndex: number;
  endIndex: number;
  points: [number, number, number][]; // [lon, lat, alt]
  colorHex: string;
  colorRgba: [number, number, number, number]; // [r, g, b, a] in range [0, 1]
  value: number; // representative value
  status?: string;
}

export interface InterpolatedTelemetry {
  timestamp: number;
  longitude: number;
  latitude: number;
  altitude: number;
  height: number;
  pitch: number;
  roll: number;
  yaw: number;
  speed: number;
  rtkStatus: number;
  batteryPercent: number;
  batteryVoltage: number;
  gimbalPitch: number;
  gimbalYaw: number;
  index: number;
  factor: number;
}

export interface CameraViewParameters {
  heading: number; // Radians
  pitch: number;   // Radians
  range: number;   // Meters
}

export type ColorMode = 'altitude' | 'speed' | 'rtk' | 'deviation';

// Color Palette Constants
export const COLOR_RTK_FIXED = '#00E676';   // Green (Status 50 or 2)
export const COLOR_RTK_FLOAT = '#FFD600';   // Yellow (Status 32 or 1)
export const COLOR_RTK_SINGLE = '#FF9100';  // Orange (Status 16)
export const COLOR_RTK_NONE = '#FF1744';    // Red (Status 0 / other)

export const COLOR_DEV_NORMAL = '#00E676';  // Green (< 0.5m)
export const COLOR_DEV_WARNING = '#FFD600'; // Yellow (0.5m - 1.0m)
export const COLOR_DEV_CRITICAL = '#FF1744';// Red (> 1.0m)

/**
 * Converts a hex color string (#RRGGBB) to [r, g, b, a] in range [0, 1].
 */
export function hexToRgba(hex: string, alpha = 1.0): [number, number, number, number] {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  return [r, g, b, alpha];
}

/**
 * Converts RGB [0-255] components to #RRGGBB hex string.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => {
    const clamped = Math.max(0, Math.min(255, Math.round(c)));
    return clamped.toString(16).padStart(2, '0');
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Evaluates a continuous color ramp between 0.0 and 1.0 across 4 stops:
 * Cyan (#00E5FF) -> Green (#00E676) -> Yellow (#FFD600) -> Red (#FF1744)
 */
export function getColorFromRamp(t: number): { hex: string; rgba: [number, number, number, number] } {
  const clampedT = Math.max(0, Math.min(1, t));

  const stops = [
    { pos: 0.0, rgb: [0, 229, 255] },  // Cyan
    { pos: 0.33, rgb: [0, 230, 118] }, // Green
    { pos: 0.66, rgb: [255, 214, 0] }, // Yellow
    { pos: 1.0, rgb: [255, 23, 68] },  // Red
  ];

  let lowStop = stops[0];
  let highStop = stops[stops.length - 1];

  for (let i = 0; i < stops.length - 1; i++) {
    if (clampedT >= stops[i].pos && clampedT <= stops[i + 1].pos) {
      lowStop = stops[i];
      highStop = stops[i + 1];
      break;
    }
  }

  const segmentSpan = highStop.pos - lowStop.pos;
  const factor = segmentSpan > 0 ? (clampedT - lowStop.pos) / segmentSpan : 0;

  const r = lowStop.rgb[0] + (highStop.rgb[0] - lowStop.rgb[0]) * factor;
  const g = lowStop.rgb[1] + (highStop.rgb[1] - lowStop.rgb[1]) * factor;
  const b = lowStop.rgb[2] + (highStop.rgb[2] - lowStop.rgb[2]) * factor;

  const hex = rgbToHex(r, g, b);
  return {
    hex,
    rgba: [r / 255, g / 255, b / 255, 1.0],
  };
}

/**
 * Maps an RTK status code to its corresponding color, RGBA and label.
 */
export function getRtkColor(status: number): { hex: string; rgba: [number, number, number, number]; label: string } {
  if (status === 50 || status === 2) {
    return { hex: COLOR_RTK_FIXED, rgba: hexToRgba(COLOR_RTK_FIXED), label: 'Fixed' };
  } else if (status === 32 || status === 1) {
    return { hex: COLOR_RTK_FLOAT, rgba: hexToRgba(COLOR_RTK_FLOAT), label: 'Float' };
  } else if (status === 16) {
    return { hex: COLOR_RTK_SINGLE, rgba: hexToRgba(COLOR_RTK_SINGLE), label: 'Single' };
  } else {
    return { hex: COLOR_RTK_NONE, rgba: hexToRgba(COLOR_RTK_NONE), label: 'None' };
  }
}

/**
 * Maps a deviation distance and status to its corresponding color.
 */
export function getDeviationColor(
  distance: number,
  status?: 'normal' | 'warning' | 'critical'
): { hex: string; rgba: [number, number, number, number]; label: string } {
  if (status === 'critical' || distance > 1.0) {
    return { hex: COLOR_DEV_CRITICAL, rgba: hexToRgba(COLOR_DEV_CRITICAL), label: 'critical' };
  } else if (status === 'warning' || distance >= 0.5) {
    return { hex: COLOR_DEV_WARNING, rgba: hexToRgba(COLOR_DEV_WARNING), label: 'warning' };
  } else {
    return { hex: COLOR_DEV_NORMAL, rgba: hexToRgba(COLOR_DEV_NORMAL), label: 'normal' };
  }
}

/**
 * Generates 3D trajectory polyline segments with color coding based on the selected mode.
 */
export function generateTrajectorySegments(
  telemetry: TelemetryStream,
  colorMode: ColorMode,
  deviation?: DeviationResult,
  options?: TrajectoryOptions
): TrajectorySegment[] {
  const count = telemetry.timestamps.length;
  if (count < 2) {
    return [];
  }

  const altSource = options?.altitudeSource === 'heights' ? telemetry.heights : telemetry.altitudes;
  const altOffset = options?.altitudeOffset ?? 0;

  // Pre-calculate min/max for altitude and speed normalization
  let minVal = Infinity;
  let maxVal = -Infinity;

  if (colorMode === 'altitude') {
    for (let i = 0; i < count; i++) {
      const v = altSource[i] + altOffset;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  } else if (colorMode === 'speed') {
    for (let i = 0; i < count; i++) {
      const v = telemetry.speeds[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  }

  const rawSegments: TrajectorySegment[] = [];

  for (let i = 0; i < count - 1; i++) {
    const p1: [number, number, number] = [
      telemetry.longitudes[i],
      telemetry.latitudes[i],
      altSource[i] + altOffset,
    ];
    const p2: [number, number, number] = [
      telemetry.longitudes[i + 1],
      telemetry.latitudes[i + 1],
      altSource[i + 1] + altOffset,
    ];

    let colorHex = COLOR_RTK_FIXED;
    let colorRgba: [number, number, number, number] = [0, 1, 0, 1];
    let repValue = 0;
    let statusLabel: string | undefined;

    switch (colorMode) {
      case 'rtk': {
        const rtk = telemetry.rtkStatus[i];
        const rtkInfo = getRtkColor(rtk);
        colorHex = rtkInfo.hex;
        colorRgba = rtkInfo.rgba;
        repValue = rtk;
        statusLabel = rtkInfo.label;
        break;
      }

      case 'deviation': {
        const devPoint = deviation?.deviations ? deviation.deviations[i] : undefined;
        const dist = devPoint ? devPoint.euclideanDistance : 0;
        const stat = devPoint ? devPoint.status : 'normal';
        const devInfo = getDeviationColor(dist, stat);
        colorHex = devInfo.hex;
        colorRgba = devInfo.rgba;
        repValue = dist;
        statusLabel = devInfo.label;
        break;
      }

      case 'altitude': {
        const altAvg = ((altSource[i] + altSource[i + 1]) / 2) + altOffset;
        const span = maxVal - minVal;
        const t = span > 0.001 ? (altAvg - minVal) / span : 0.5;
        const ramp = getColorFromRamp(t);
        colorHex = ramp.hex;
        colorRgba = ramp.rgba;
        repValue = altAvg;
        break;
      }

      case 'speed': {
        const spdAvg = (telemetry.speeds[i] + telemetry.speeds[i + 1]) / 2;
        const span = maxVal - minVal;
        const t = span > 0.001 ? (spdAvg - minVal) / span : 0.5;
        const ramp = getColorFromRamp(t);
        colorHex = ramp.hex;
        colorRgba = ramp.rgba;
        repValue = spdAvg;
        break;
      }
    }

    rawSegments.push({
      startIndex: i,
      endIndex: i + 1,
      points: [p1, p2],
      colorHex,
      colorRgba,
      value: repValue,
      status: statusLabel,
    });
  }

  // Merge consecutive segments with identical color if requested
  if (options?.mergeConsecutive && rawSegments.length > 1) {
    const merged: TrajectorySegment[] = [];
    let current = {
      startIndex: rawSegments[0].startIndex,
      endIndex: rawSegments[0].endIndex,
      points: [...rawSegments[0].points],
      colorHex: rawSegments[0].colorHex,
      colorRgba: rawSegments[0].colorRgba,
      value: rawSegments[0].value,
      status: rawSegments[0].status,
    };

    for (let i = 1; i < rawSegments.length; i++) {
      const seg = rawSegments[i];
      if (seg.colorHex === current.colorHex) {
        current.points.push(seg.points[1]);
        current.endIndex = seg.endIndex;
      } else {
        merged.push(current);
        current = {
          startIndex: seg.startIndex,
          endIndex: seg.endIndex,
          points: [...seg.points],
          colorHex: seg.colorHex,
          colorRgba: seg.colorRgba,
          value: seg.value,
          status: seg.status,
        };
      }
    }
    merged.push(current);
    return merged;
  }

  return rawSegments;
}

/**
 * Interpolates between two angles (in degrees) along the shortest circular path.
 * Output is normalized to [0, 360).
 */
export function interpolateAngleDeg(deg1: number, deg2: number, alpha: number): number {
  const norm1 = ((deg1 % 360) + 360) % 360;
  const norm2 = ((deg2 % 360) + 360) % 360;
  let diff = norm2 - norm1;

  if (diff > 180) {
    diff -= 360;
  } else if (diff < -180) {
    diff += 360;
  }

  const result = norm1 + diff * alpha;
  return ((result % 360) + 360) % 360;
}

/**
 * Finds the index in timestamps array for a target timestamp using binary search.
 */
export function findTelemetryIndexAtTime(
  timestamps: Float64Array,
  targetTimeMs: number
): { index: number; factor: number } {
  const count = timestamps.length;
  if (count === 0) return { index: 0, factor: 0 };
  if (count === 1 || targetTimeMs <= timestamps[0]) return { index: 0, factor: 0 };
  if (targetTimeMs >= timestamps[count - 1]) return { index: count - 1, factor: 1.0 };

  let low = 0;
  let high = count - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timestamps[mid] <= targetTimeMs) {
      if (mid === count - 1 || timestamps[mid + 1] > targetTimeMs) {
        const span = timestamps[mid + 1] - timestamps[mid];
        const factor = span > 0 ? (targetTimeMs - timestamps[mid]) / span : 0;
        return { index: mid, factor };
      }
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return { index: 0, factor: 0 };
}

/**
 * Computes high-precision interpolated telemetry state at an arbitrary timestamp.
 */
export function interpolateTelemetryAtTime(
  telemetry: TelemetryStream,
  targetTimeMs: number,
  options?: TrajectoryOptions
): InterpolatedTelemetry | null {
  const count = telemetry.timestamps.length;
  if (count === 0) return null;

  const altOffset = options?.altitudeOffset ?? 0;

  if (count === 1 || targetTimeMs <= telemetry.timestamps[0]) {
    return {
      timestamp: telemetry.timestamps[0],
      longitude: telemetry.longitudes[0],
      latitude: telemetry.latitudes[0],
      altitude: telemetry.altitudes[0] + altOffset,
      height: telemetry.heights[0],
      pitch: telemetry.pitch[0] || 0,
      roll: telemetry.roll[0] || 0,
      yaw: telemetry.yaw[0] || 0,
      speed: telemetry.speeds[0] || 0,
      rtkStatus: telemetry.rtkStatus[0] || 0,
      batteryPercent: telemetry.batteryPercents[0] || 0,
      batteryVoltage: telemetry.batteryVoltages[0] || 0,
      gimbalPitch: telemetry.gimbalPitch[0] || 0,
      gimbalYaw: telemetry.gimbalYaw[0] || 0,
      index: 0,
      factor: 0,
    };
  }

  if (targetTimeMs >= telemetry.timestamps[count - 1]) {
    const last = count - 1;
    return {
      timestamp: telemetry.timestamps[last],
      longitude: telemetry.longitudes[last],
      latitude: telemetry.latitudes[last],
      altitude: telemetry.altitudes[last] + altOffset,
      height: telemetry.heights[last],
      pitch: telemetry.pitch[last] || 0,
      roll: telemetry.roll[last] || 0,
      yaw: telemetry.yaw[last] || 0,
      speed: telemetry.speeds[last] || 0,
      rtkStatus: telemetry.rtkStatus[last] || 0,
      batteryPercent: telemetry.batteryPercents[last] || 0,
      batteryVoltage: telemetry.batteryVoltages[last] || 0,
      gimbalPitch: telemetry.gimbalPitch[last] || 0,
      gimbalYaw: telemetry.gimbalYaw[last] || 0,
      index: last,
      factor: 1.0,
    };
  }

  const { index: i, factor: alpha } = findTelemetryIndexAtTime(telemetry.timestamps, targetTimeMs);
  const j = i + 1;

  const lerp = (a: number, b: number) => a + (b - a) * alpha;

  return {
    timestamp: targetTimeMs,
    longitude: lerp(telemetry.longitudes[i], telemetry.longitudes[j]),
    latitude: lerp(telemetry.latitudes[i], telemetry.latitudes[j]),
    altitude: lerp(telemetry.altitudes[i], telemetry.altitudes[j]) + altOffset,
    height: lerp(telemetry.heights[i], telemetry.heights[j]),
    pitch: lerp(telemetry.pitch[i] || 0, telemetry.pitch[j] || 0),
    roll: lerp(telemetry.roll[i] || 0, telemetry.roll[j] || 0),
    yaw: interpolateAngleDeg(telemetry.yaw[i] || 0, telemetry.yaw[j] || 0, alpha),
    speed: lerp(telemetry.speeds[i] || 0, telemetry.speeds[j] || 0),
    rtkStatus: alpha >= 0.5 ? telemetry.rtkStatus[j] : telemetry.rtkStatus[i],
    batteryPercent: Math.round(lerp(telemetry.batteryPercents[i] || 0, telemetry.batteryPercents[j] || 0)),
    batteryVoltage: lerp(telemetry.batteryVoltages[i] || 0, telemetry.batteryVoltages[j] || 0),
    gimbalPitch: lerp(telemetry.gimbalPitch[i] || 0, telemetry.gimbalPitch[j] || 0),
    gimbalYaw: interpolateAngleDeg(telemetry.gimbalYaw[i] || 0, telemetry.gimbalYaw[j] || 0, alpha),
    index: i,
    factor: alpha,
  };
}

/**
 * Converts Euler pitch, roll, yaw (in degrees) to Cesium HeadingPitchRoll (in radians).
 * In Cesium convention:
 * - heading: rotation around Z axis, 0 is North, clockwise positive.
 * - pitch: rotation around Y axis, positive upwards.
 * - roll: rotation around X axis.
 */
export function eulerToHeadingPitchRoll(
  pitchDeg: number,
  rollDeg: number,
  yawDeg: number
): { heading: number; pitch: number; roll: number } {
  const toRad = Math.PI / 180;
  return {
    heading: ((yawDeg % 360) + 360) % 360 * toRad,
    pitch: pitchDeg * toRad,
    roll: rollDeg * toRad,
  };
}

/**
 * Calculates camera viewing parameters (heading, pitch, range) for tracking the aircraft.
 */
export function calculateCameraHeadingPitchRange(
  mode: 'follow' | 'free' | 'fpv_gimbal' | 'top_down',
  yawDeg: number,
  gimbalPitchDeg = 0,
  distance = 35
): CameraViewParameters {
  const toRad = Math.PI / 180;
  const yawRad = ((yawDeg % 360) + 360) % 360 * toRad;

  switch (mode) {
    case 'follow':
      // Behind and slightly above the drone looking along the drone's heading
      return {
        heading: yawRad,
        pitch: -20 * toRad, // -20 deg looking down at aircraft
        range: distance,
      };

    case 'top_down':
      // Directly above the drone looking down
      return {
        heading: yawRad,
        pitch: -Math.PI / 2 + 0.0001, // Small epsilon to avoid gimbal lock
        range: Math.max(distance * 3, 100),
      };

    case 'fpv_gimbal':
      // First-person view aligned with gimbal pitch & aircraft yaw
      return {
        heading: yawRad,
        pitch: gimbalPitchDeg * toRad,
        range: 1.5, // Inside/just in front of aircraft
      };

    case 'free':
    default:
      return {
        heading: yawRad,
        pitch: -30 * toRad,
        range: distance,
      };
  }
}
