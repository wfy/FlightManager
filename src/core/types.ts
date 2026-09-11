/**
 * Core Data Contracts & Telemetry Schema for DJI Drone Flight Log 3D Viewer
 */

export interface FlightMeta {
  aircraftType: string;
  aircraftSn: string;
  cameraSn?: string;
  batterySnList: string[];
  startTime: number;
  durationMs: number;
  totalDistance: number;
  maxAltitude: number;
  homeLocation: [number, number, number]; // [longitude, latitude, altitude]
}

export interface TelemetryStream {
  timestamps: Float64Array;        // UTC epoch milliseconds
  longitudes: Float64Array;        // WGS-84 degrees
  latitudes: Float64Array;         // WGS-84 degrees
  altitudes: Float32Array;         // WGS-84 Ellipsoidal or ASL altitude (m)
  heights: Float32Array;           // AGL / Relative takeoff height (m)
  pitch: Float32Array;             // Aircraft body pitch (degrees)
  roll: Float32Array;              // Aircraft body roll (degrees)
  yaw: Float32Array;               // Aircraft body yaw / heading (degrees, 0-360)
  speeds: Float32Array;            // Ground speed (m/s)
  rtkStatus: Uint8Array;           // 0: None/Single, 1: Float, 2: Fixed
  batteryPercents: Uint8Array;     // Remaining percentage (0-100)
  batteryVoltages: Float32Array;    // Total voltage (V)
  maxCellVoltageDiff: Float32Array;// Maximum cell voltage difference (V)
  maxCellTemp: Float32Array;       // Maximum cell temperature (deg C)
  gimbalPitch: Float32Array;       // Gimbal pitch angle (degrees)
  gimbalYaw: Float32Array;         // Gimbal yaw angle (degrees)
}

export interface PhotoEvent {
  id: string;
  timestamp: number;
  index: number;
  position: [number, number, number];    // [lon, lat, alt]
  gimbalAngles: [number, number, number]; // [pitch, roll, yaw]
  thumbnailBase64?: string;
}

export interface WarningEvent {
  timestamp: number;
  level: 'info' | 'warning' | 'critical';
  code: number;
  message: string;
}

export interface FlightRecordPackage {
  meta: FlightMeta;
  telemetry: TelemetryStream;
  events: {
    photos: PhotoEvent[];
    warnings: WarningEvent[];
  };
}

export interface WPMLWaypoint {
  index: number;
  lon: number;
  lat: number;
  alt: number; // height/altitude in meters
  speed?: number;
  gimbalPitch?: number;
  gimbalYaw?: number;
  actionList?: unknown[];
}

export interface WPMLRoute {
  name: string;
  waypoints: WPMLWaypoint[];
  takeOffSecurityHeight?: number;
  globalSpeed?: number;
}

export interface TrajectoryDeviationPoint {
  index: number;
  timestamp: number;
  lon: number;
  lat: number;
  alt: number;
  projectedPoint: [number, number, number]; // [lon, lat, alt]
  euclideanDistance: number;
  lateralDiff: number;
  verticalDiff: number;
  status: 'normal' | 'warning' | 'critical';
}

export interface DeviationResult {
  deviations: TrajectoryDeviationPoint[];
  stats: {
    maxDeviation: number;
    avgDeviation: number;
    averageDeviation?: number;
    maxVerticalDiff: number;
    maxLateralDiff: number;
    warningCount: number;
    criticalCount: number;
  };
}

/**
 * Creates an empty FlightRecordPackage with 0-length TypedArrays and default metadata.
 */
export function createEmptyFlightPackage(): FlightRecordPackage {
  return {
    meta: {
      aircraftType: 'Unknown',
      aircraftSn: '',
      batterySnList: [],
      startTime: 0,
      durationMs: 0,
      totalDistance: 0,
      maxAltitude: 0,
      homeLocation: [0, 0, 0],
    },
    telemetry: {
      timestamps: new Float64Array(0),
      longitudes: new Float64Array(0),
      latitudes: new Float64Array(0),
      altitudes: new Float32Array(0),
      heights: new Float32Array(0),
      pitch: new Float32Array(0),
      roll: new Float32Array(0),
      yaw: new Float32Array(0),
      speeds: new Float32Array(0),
      rtkStatus: new Uint8Array(0),
      batteryPercents: new Uint8Array(0),
      batteryVoltages: new Float32Array(0),
      maxCellVoltageDiff: new Float32Array(0),
      maxCellTemp: new Float32Array(0),
      gimbalPitch: new Float32Array(0),
      gimbalYaw: new Float32Array(0),
    },
    events: {
      photos: [],
      warnings: [],
    },
  };
}
