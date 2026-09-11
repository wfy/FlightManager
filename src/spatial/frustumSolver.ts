/**
 * Pure Mathematical Solver for Dynamic Gimbal Camera Frustum & Ground Footprint Projection
 *
 * 100% Offline, Pure Math: No network, zero external API dependencies.
 *
 * Converts camera intrinsic FOV and 3-DOF gimbal attitude (pitch, yaw, roll) into:
 * 1. 3D apex (camera center in WGS84)
 * 2. 4 pyramid corner rays (direction vectors and endpoints)
 * 3. Exact ray-ground intersection footprint polygon [lon, lat, alt]
 * 4. Footprint center coordinates and ground intersection status
 */

import { localToWgs84 } from './deviationSolver';

export interface FrustumParams {
  position: [number, number, number]; // [lon, lat, alt] in WGS84
  gimbalPitch: number;                // degrees, e.g. -45 (looking down), -90 nadir
  gimbalYaw: number;                  // degrees (0 = North, 90 = East, 180 = South, 270 = West)
  gimbalRoll?: number;                // degrees (optional roll around optical axis)
  hfovDeg?: number;                   // horizontal FOV (default 60 deg)
  vfovDeg?: number;                   // vertical FOV (default 45 deg)
  maxRangeMeters?: number;            // max range cutoff (default 300m)
  groundAltitude?: number;            // target ground height in WGS84 meters (default 0 or takeoff alt)
}

export interface FrustumGeometryResult {
  apex: [number, number, number];                    // [lon, lat, alt]
  rays: Array<[number, number, number]>;             // 4 corner ray endpoints [lon, lat, alt]
  unitRays?: Array<[number, number, number]>;         // 4 corner unit direction vectors in ENU [dx, dy, dz]
  footprintPolygon: Array<[number, number, number]>; // 3-4 ground intersection coordinates [lon, lat, alt]
  footprintCenter: [number, number, number];         // center of ground intersection [lon, lat, alt]
  intersectsGround: boolean;                         // true if at least 3 rays intersect ground
}

interface Vector3 {
  x: number; // East
  y: number; // North
  z: number; // Up
}

/**
 * Normalizes a 3D vector to unit length.
 */
function normalize(v: Vector3): Vector3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-12) {
    return { x: 0, y: 0, z: 1 };
  }
  return {
    x: v.x / len,
    y: v.y / len,
    z: v.z / len,
  };
}

/**
 * Calculates dynamic camera frustum geometry and ground footprint projection.
 */
export function calculateFrustumGeometry(params: FrustumParams): FrustumGeometryResult {
  const [lon0, lat0, alt0] = params.position;
  const pitchDeg = params.gimbalPitch;
  const yawDeg = params.gimbalYaw;
  const rollDeg = params.gimbalRoll ?? 0;
  const hfovDeg = params.hfovDeg ?? 60.0;
  const vfovDeg = params.vfovDeg ?? 45.0;
  const maxRangeMeters = params.maxRangeMeters ?? 300.0;
  const groundAltitude = params.groundAltitude ?? 0.0;

  const toRad = Math.PI / 180.0;
  const yawRad = yawDeg * toRad;
  const pitchRad = pitchDeg * toRad;
  const rollRad = rollDeg * toRad;

  // 1. Build Camera Orientation Triad (Right r, Up u, Forward f) in local ENU
  // Heading / Yaw: 0 = North (+Y), 90 = East (+X)
  // Horizontal forward vector:
  const sinYaw = Math.sin(yawRad);
  const cosYaw = Math.cos(yawRad);

  // Pitch: 0 = horizontal forward, -90 = Nadir (straight down, -Z), +90 = zenith (+Z)
  const sinPitch = Math.sin(pitchRad);
  const cosPitch = Math.cos(pitchRad);

  // Optical axis forward unit vector f in ENU:
  const f: Vector3 = {
    x: cosPitch * sinYaw,
    y: cosPitch * cosYaw,
    z: sinPitch,
  };

  // Base Right vector r0 (in horizontal plane, orthogonal to heading):
  const r0: Vector3 = {
    x: cosYaw,
    y: -sinYaw,
    z: 0,
  };

  // Base Up vector u0 = r0 x f (orthogonal to optical axis and right):
  const u0: Vector3 = {
    x: -sinPitch * sinYaw,
    y: -sinPitch * cosYaw,
    z: cosPitch,
  };

  // Apply camera roll around optical axis:
  const sinRoll = Math.sin(rollRad);
  const cosRoll = Math.cos(rollRad);

  const r: Vector3 = {
    x: cosRoll * r0.x + sinRoll * u0.x,
    y: cosRoll * r0.y + sinRoll * u0.y,
    z: cosRoll * r0.z + sinRoll * u0.z,
  };

  const u: Vector3 = {
    x: -sinRoll * r0.x + cosRoll * u0.x,
    y: -sinRoll * r0.y + cosRoll * u0.y,
    z: -sinRoll * r0.z + cosRoll * u0.z,
  };

  // 2. Camera Frame Corner Vectors (Top-Left, Top-Right, Bottom-Right, Bottom-Left)
  const halfH = Math.tan((hfovDeg * toRad) / 2.0);
  const halfV = Math.tan((vfovDeg * toRad) / 2.0);

  const cornerDirsCamera: [number, number][] = [
    [-halfH, halfV],  // 0: Top-Left
    [halfH, halfV],   // 1: Top-Right
    [halfH, -halfV],  // 2: Bottom-Right
    [-halfH, -halfV], // 3: Bottom-Left
  ];

  const unitRays: Array<[number, number, number]> = [];
  const rayEndpoints: Array<[number, number, number]> = [];
  const groundIntersections: Array<[number, number, number]> = [];

  const deltaZ = groundAltitude - alt0; // e.g. 0 - 100 = -100

  // 3. Solve 4 Pyramid Rays & Ground Intersections
  for (let i = 0; i < 4; i++) {
    const [cx, cy] = cornerDirsCamera[i];
    const rayDirENU = normalize({
      x: cx * r.x + cy * u.x + f.x,
      y: cx * r.y + cy * u.y + f.y,
      z: cx * r.z + cy * u.z + f.z,
    });

    unitRays.push([rayDirENU.x, rayDirENU.y, rayDirENU.z]);

    // Ray-ground intersection: z(t) = alt0 + t * rayDirENU.z = groundAltitude
    // t * rayDirENU.z = deltaZ
    let groundPointENU: Vector3 | null = null;
    let endpointENU: Vector3;

    if (rayDirENU.z < -1e-6) {
      // Ray points downward towards ground
      const tGround = deltaZ / rayDirENU.z;

      if (tGround > 0 && tGround <= maxRangeMeters) {
        // Intersects ground within maxRange
        groundPointENU = {
          x: tGround * rayDirENU.x,
          y: tGround * rayDirENU.y,
          z: groundAltitude,
        };
        endpointENU = groundPointENU;
      } else if (tGround > maxRangeMeters) {
        // Intersects beyond maxRangeMeters -> clamp to maxRange
        const clampedT = maxRangeMeters;
        endpointENU = {
          x: clampedT * rayDirENU.x,
          y: clampedT * rayDirENU.y,
          z: alt0 + clampedT * rayDirENU.z,
        };
        // Project clamped horizontal distance to ground plane
        groundPointENU = {
          x: clampedT * rayDirENU.x,
          y: clampedT * rayDirENU.y,
          z: groundAltitude,
        };
      } else {
        // Drone is beneath target groundAltitude (deltaZ >= 0 and dz < 0) -> no forward ground intersection
        endpointENU = {
          x: maxRangeMeters * rayDirENU.x,
          y: maxRangeMeters * rayDirENU.y,
          z: alt0 + maxRangeMeters * rayDirENU.z,
        };
        groundPointENU = null;
      }
    } else {
      // Ray points horizontal or upward (dz >= -1e-6) -> projects into sky at maxRange
      endpointENU = {
        x: maxRangeMeters * rayDirENU.x,
        y: maxRangeMeters * rayDirENU.y,
        z: alt0 + maxRangeMeters * rayDirENU.z,
      };
      // No ground intersection for upward/horizontal ray
      groundPointENU = null;
    }

    const endpointWgs84 = localToWgs84(endpointENU.x, endpointENU.y, endpointENU.z, lon0, lat0);
    rayEndpoints.push(endpointWgs84);

    if (groundPointENU) {
      const gWgs84 = localToWgs84(groundPointENU.x, groundPointENU.y, groundAltitude, lon0, lat0);
      groundIntersections.push(gWgs84);
    }
  }

  // 4. Determine Ground Intersection Status & Polygon
  const intersectsGround = groundIntersections.length >= 3;
  const footprintPolygon = intersectsGround ? groundIntersections : [];

  // 5. Compute Footprint Center (average of ground intersections)
  let footprintCenter: [number, number, number];
  if (footprintPolygon.length > 0) {
    let sumLon = 0;
    let sumLat = 0;
    let sumAlt = 0;
    for (const pt of footprintPolygon) {
      sumLon += pt[0];
      sumLat += pt[1];
      sumAlt += pt[2];
    }
    const count = footprintPolygon.length;
    footprintCenter = [sumLon / count, sumLat / count, sumAlt / count];
  } else {
    // Optical axis fallback if no ground intersection (avoid NaN / Inf)
    if (f.z < -1e-6) {
      const tOpt = Math.min(deltaZ / f.z, maxRangeMeters);
      const optPt = localToWgs84(tOpt * f.x, tOpt * f.y, groundAltitude, lon0, lat0);
      footprintCenter = optPt;
    } else {
      footprintCenter = [lon0, lat0, groundAltitude];
    }
  }

  return {
    apex: [lon0, lat0, alt0],
    rays: rayEndpoints,
    unitRays,
    footprintPolygon,
    footprintCenter,
    intersectsGround,
  };
}
