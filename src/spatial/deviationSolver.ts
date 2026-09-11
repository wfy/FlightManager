import {
  TelemetryStream,
  WPMLRoute,
  WPMLWaypoint,
  TrajectoryDeviationPoint,
  DeviationResult,
} from '../core/types';

export type { WPMLRoute, WPMLWaypoint, TrajectoryDeviationPoint, DeviationResult };

export interface DeviationSolverOptions {
  warningThreshold?: number;  // default 0.5 meters
  criticalThreshold?: number; // default 1.0 meters
}

// WGS-84 Ellipsoid constants
const WGS84_A = 6378137.0; // Semi-major axis (meters)
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // First eccentricity squared (~0.00669438)

/**
 * Projects WGS-84 (lon, lat, alt) to local tangent plane (East, North, Up) in meters
 * using meridian and prime vertical curvature radius for high accuracy.
 */
export function wgs84ToLocal(
  lon: number,
  lat: number,
  alt: number,
  lon0: number,
  lat0: number
): [number, number, number] {
  const phi = (lat * Math.PI) / 180.0;
  const phi0 = (lat0 * Math.PI) / 180.0;
  const dPhi = phi - phi0;
  const dLam = ((lon - lon0) * Math.PI) / 180.0;
  const phiM = (phi + phi0) / 2.0;

  const sinPhiM = Math.sin(phiM);
  const denom = Math.sqrt(1.0 - WGS84_E2 * sinPhiM * sinPhiM);
  const rn = WGS84_A / denom;
  const rm = (WGS84_A * (1.0 - WGS84_E2)) / (denom * denom * denom);

  const x = dLam * rn * Math.cos(phiM); // East
  const y = dPhi * rm;                  // North
  const z = alt;                        // Up

  return [x, y, z];
}

/**
 * Un-projects local tangent plane (East, North, Up) in meters back to WGS-84 [lon, lat, alt].
 */
export function localToWgs84(
  x: number,
  y: number,
  z: number,
  lon0: number,
  lat0: number
): [number, number, number] {
  const phi0 = (lat0 * Math.PI) / 180.0;
  const sinPhi0 = Math.sin(phi0);
  const denom0 = Math.sqrt(1.0 - WGS84_E2 * sinPhi0 * sinPhi0);
  const rm0 = (WGS84_A * (1.0 - WGS84_E2)) / (denom0 * denom0 * denom0);

  const latRad = phi0 + y / rm0;
  const lat = (latRad * 180.0) / Math.PI;

  const phiM = (latRad + phi0) / 2.0;
  const sinPhiM = Math.sin(phiM);
  const denomM = Math.sqrt(1.0 - WGS84_E2 * sinPhiM * sinPhiM);
  const rnM = WGS84_A / denomM;

  const lonRad = ((lon0 * Math.PI) / 180.0) + x / (rnM * Math.cos(phiM));
  const lon = (lonRad * 180.0) / Math.PI;

  return [lon, lat, z];
}

interface LocalSegment {
  ax: number;
  ay: number;
  az: number;
  dx: number;
  dy: number;
  dz: number;
  lenSq: number;
}

/**
 * High-performance 3D spatial trajectory deviation solver.
 * Compares actual telemetry stream against planned WPML route polyline.
 *
 * For each actual point Q(t), finds the closest point P_proj on the planned 3D polyline:
 * - euclideanDistance = sqrt(dX^2 + dY^2 + dZ^2)
 * - lateralDiff = sqrt(dX^2 + dY^2)
 * - verticalDiff = |alt_actual - alt_proj|
 * - status: 'normal' (<0.5m) | 'warning' (0.5m-1.0m) | 'critical' (>1.0m)
 */
export function calculateTrajectoryDeviation(
  actual: TelemetryStream,
  planned: WPMLRoute,
  options?: DeviationSolverOptions
): DeviationResult {
  const warningThreshold = options?.warningThreshold ?? 0.5;
  const criticalThreshold = options?.criticalThreshold ?? 1.0;

  const waypoints = planned?.waypoints;
  const count = actual?.longitudes?.length ?? 0;

  if (!waypoints || waypoints.length === 0 || count === 0) {
    return {
      deviations: [],
      stats: {
        maxDeviation: 0,
        avgDeviation: 0,
        averageDeviation: 0,
        maxVerticalDiff: 0,
        maxLateralDiff: 0,
        warningCount: 0,
        criticalCount: 0,
      },
    };
  }

  // Reference origin from first planned waypoint
  const lon0 = waypoints[0].lon;
  const lat0 = waypoints[0].lat;

  // Pre-project all waypoints to local coordinates
  const localWps: [number, number, number][] = waypoints.map((wp) =>
    wgs84ToLocal(wp.lon, wp.lat, wp.alt, lon0, lat0)
  );

  // Pre-calculate 3D line segments
  const segments: LocalSegment[] = [];
  for (let k = 0; k < localWps.length - 1; k++) {
    const [ax, ay, az] = localWps[k];
    const [bx, by, bz] = localWps[k + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const lenSq = dx * dx + dy * dy + dz * dz;
    segments.push({ ax, ay, az, dx, dy, dz, lenSq });
  }

  const deviations: TrajectoryDeviationPoint[] = new Array(count);
  let maxDev = 0;
  let sumDev = 0;
  let maxVert = 0;
  let maxLat = 0;
  let warnCount = 0;
  let critCount = 0;

  for (let i = 0; i < count; i++) {
    const qLon = actual.longitudes[i];
    const qLat = actual.latitudes[i];
    const qAlt = actual.altitudes[i];
    const qTimestamp = actual.timestamps[i] ?? 0;

    const [qx, qy, qz] = wgs84ToLocal(qLon, qLat, qAlt, lon0, lat0);

    let bestPx = 0;
    let bestPy = 0;
    let bestPz = 0;
    let minDistSq = Infinity;

    if (segments.length === 0) {
      // Single waypoint route: point-to-point comparison
      bestPx = localWps[0][0];
      bestPy = localWps[0][1];
      bestPz = localWps[0][2];
      const ex = qx - bestPx;
      const ey = qy - bestPy;
      const ez = qz - bestPz;
      minDistSq = ex * ex + ey * ey + ez * ez;
    } else {
      // Polyline segments search
      for (let s = 0; s < segments.length; s++) {
        const seg = segments[s];
        let t = 0;
        if (seg.lenSq > 1e-12) {
          t =
            ((qx - seg.ax) * seg.dx +
             (qy - seg.ay) * seg.dy +
             (qz - seg.az) * seg.dz) /
            seg.lenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
        }
        const px = seg.ax + t * seg.dx;
        const py = seg.ay + t * seg.dy;
        const pz = seg.az + t * seg.dz;

        const ex = qx - px;
        const ey = qy - py;
        const ez = qz - pz;
        const distSq = ex * ex + ey * ey + ez * ez;

        if (distSq < minDistSq) {
          minDistSq = distSq;
          bestPx = px;
          bestPy = py;
          bestPz = pz;
        }
      }
    }

    const lateralDiff = Math.sqrt(
      (qx - bestPx) * (qx - bestPx) + (qy - bestPy) * (qy - bestPy)
    );
    const verticalDiff = Math.abs(qz - bestPz);
    const euclideanDistance = Math.sqrt(minDistSq);

    let status: 'normal' | 'warning' | 'critical';
    if (euclideanDistance < warningThreshold) {
      status = 'normal';
    } else if (euclideanDistance <= criticalThreshold) {
      status = 'warning';
      warnCount++;
    } else {
      status = 'critical';
      critCount++;
    }

    if (euclideanDistance > maxDev) maxDev = euclideanDistance;
    if (lateralDiff > maxLat) maxLat = lateralDiff;
    if (verticalDiff > maxVert) maxVert = verticalDiff;
    sumDev += euclideanDistance;

    const projectedPoint = localToWgs84(bestPx, bestPy, bestPz, lon0, lat0);

    deviations[i] = {
      index: i,
      timestamp: qTimestamp,
      lon: qLon,
      lat: qLat,
      alt: qAlt,
      projectedPoint,
      euclideanDistance,
      lateralDiff,
      verticalDiff,
      status,
    };
  }

  const avgDev = count > 0 ? sumDev / count : 0;

  return {
    deviations,
    stats: {
      maxDeviation: maxDev,
      avgDeviation: avgDev,
      averageDeviation: avgDev,
      maxVerticalDiff: maxVert,
      maxLateralDiff: maxLat,
      warningCount: warnCount,
      criticalCount: critCount,
    },
  };
}
