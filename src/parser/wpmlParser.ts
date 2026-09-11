import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { WPMLRoute, WPMLWaypoint } from '../core/types';

/**
 * Parses raw XML KML/WPML string or KMZ zip binary buffer into structured WPMLRoute.
 * 
 * Supports:
 * - Direct WPML/KML XML text
 * - KMZ binary archive (.zip containing wpmz/waylines.wpml or template.kml)
 * - Placemark extraction with coordinates, executeHeight, speed, gimbal angles
 */
export async function parseWPMLRoute(kmlOrKmz: string | ArrayBuffer | Uint8Array): Promise<WPMLRoute> {
  let xmlString: string;

  if (typeof kmlOrKmz === 'string') {
    xmlString = kmlOrKmz;
  } else {
    const bytes = kmlOrKmz instanceof Uint8Array ? kmlOrKmz : new Uint8Array(kmlOrKmz);
    // Check for ZIP magic header 'PK' (0x50, 0x4B)
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const zip = await JSZip.loadAsync(bytes);
      // Priority search for WPML wayline file
      let targetFile = zip.file('wpmz/waylines.wpml') ??
                       zip.file('waylines.wpml') ??
                       zip.file('wpmz/template.kml') ??
                       zip.file('template.kml');

      if (!targetFile) {
        // Fallback: search for any .wpml or .kml file
        const candidates = Object.keys(zip.files).filter(
          (name) => !zip.files[name].dir && (name.endsWith('.wpml') || name.endsWith('.kml'))
        );
        if (candidates.length > 0) {
          targetFile = zip.file(candidates[0]);
        }
      }

      if (!targetFile) {
        throw new Error('No WPML or KML file found inside KMZ archive');
      }

      xmlString = await targetFile.async('string');
    } else {
      // Decode as UTF-8 string
      xmlString = new TextDecoder('utf-8').decode(bytes);
    }
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlString);
  const root = parsed.kml ?? parsed;

  const name = root?.Document?.name ?? root?.Folder?.name ?? 'DJI_WPML_Route';
  let takeOffSecurityHeight: number | undefined;
  let globalSpeed: number | undefined;

  // Search missionConfig or folder for global parameters
  const missionConfig = findNode(root, 'missionConfig');
  if (missionConfig) {
    if (missionConfig.takeOffSecurityHeight !== undefined) {
      takeOffSecurityHeight = Number(missionConfig.takeOffSecurityHeight);
    }
    if (missionConfig.globalTransitionalSpeed !== undefined) {
      globalSpeed = Number(missionConfig.globalTransitionalSpeed);
    }
  }

  const folder = findNode(root, 'Folder');
  if (folder && globalSpeed === undefined && folder.autoFlightSpeed !== undefined) {
    globalSpeed = Number(folder.autoFlightSpeed);
  }

  // Collect all Placemarks
  const rawPlacemarks = collectPlacemarks(root);
  const waypoints: WPMLWaypoint[] = [];

  for (let i = 0; i < rawPlacemarks.length; i++) {
    const pm = rawPlacemarks[i];
    const coordsStr = pm?.Point?.coordinates ?? pm?.coordinates;
    if (!coordsStr) continue;

    const parts = String(coordsStr).trim().split(/[\s,]+/);
    if (parts.length < 2) continue;

    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    const coordAlt = parts[2] !== undefined ? parseFloat(parts[2]) : 0;

    const rawHeight = pm.executeHeight ?? pm.Point?.altitude;
    const alt = rawHeight !== undefined ? Number(rawHeight) : coordAlt;

    const wp: WPMLWaypoint = {
      index: pm.index !== undefined ? Number(pm.index) : i,
      lon,
      lat,
      alt,
    };

    if (pm.waypointSpeed !== undefined) {
      wp.speed = Number(pm.waypointSpeed);
    } else if (pm.speed !== undefined) {
      wp.speed = Number(pm.speed);
    }

    const gimbalPitch = pm.waypointGimbalHeadingParam?.waypointGimbalPitchAngle ??
                        pm.gimbalPitchAngle ??
                        pm.waypointGimbalPitchAngle;
    if (gimbalPitch !== undefined) {
      wp.gimbalPitch = Number(gimbalPitch);
    }

    const gimbalYaw = pm.waypointHeadingParam?.waypointHeadingAngle ??
                      pm.waypointHeadingAngle ??
                      pm.waypointGimbalHeadingParam?.waypointGimbalYawAngle;
    if (gimbalYaw !== undefined) {
      wp.gimbalYaw = Number(gimbalYaw);
    }

    waypoints.push(wp);
  }

  // Sort waypoints by index if needed
  waypoints.sort((a, b) => a.index - b.index);

  return {
    name,
    waypoints,
    ...(takeOffSecurityHeight !== undefined ? { takeOffSecurityHeight } : {}),
    ...(globalSpeed !== undefined ? { globalSpeed } : {}),
  };
}

/**
 * Builds mock WPML XML string for testing.
 */
export function buildMockWPMLString(
  waypoints: Partial<WPMLWaypoint>[],
  options?: {
    name?: string;
    takeOffSecurityHeight?: number;
    globalSpeed?: number;
  }
): string {
  const name = options?.name ?? 'DJI_WPML_Route';
  const secHeight = options?.takeOffSecurityHeight ?? 20.0;
  const speed = options?.globalSpeed ?? 5.0;

  const placemarksXml = waypoints
    .map((wp, idx) => {
      const index = wp.index ?? idx;
      const lon = wp.lon ?? 0;
      const lat = wp.lat ?? 0;
      const alt = wp.alt ?? 0;

      let extra = '';
      if (wp.speed !== undefined) {
        extra += `\n        <wpml:waypointSpeed>${wp.speed}</wpml:waypointSpeed>`;
      }
      if (wp.gimbalPitch !== undefined) {
        extra += `\n        <wpml:waypointGimbalHeadingParam><wpml:waypointGimbalPitchAngle>${wp.gimbalPitch}</wpml:waypointGimbalPitchAngle></wpml:waypointGimbalHeadingParam>`;
      }
      if (wp.gimbalYaw !== undefined) {
        extra += `\n        <wpml:waypointHeadingParam><wpml:waypointHeadingAngle>${wp.gimbalYaw}</wpml:waypointHeadingAngle></wpml:waypointHeadingParam>`;
      }

      return `      <Placemark>
        <Point>
          <coordinates>${lon},${lat}</coordinates>
        </Point>
        <wpml:index>${index}</wpml:index>
        <wpml:executeHeight>${alt}</wpml:executeHeight>${extra}
      </Placemark>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.3">
  <Document>
    <name>${name}</name>
    <wpml:missionConfig>
      <wpml:takeOffSecurityHeight>${secHeight}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${speed}</wpml:globalTransitionalSpeed>
    </wpml:missionConfig>
    <Folder>
${placemarksXml}
    </Folder>
  </Document>
</kml>`;
}

/**
 * Builds mock KMZ zip binary buffer containing wpmz/waylines.wpml.
 */
export async function buildMockWPMLKMZ(
  waypoints: Partial<WPMLWaypoint>[],
  options?: {
    name?: string;
    takeOffSecurityHeight?: number;
    globalSpeed?: number;
  }
): Promise<ArrayBuffer> {
  const xml = buildMockWPMLString(waypoints, options);
  const zip = new JSZip();
  zip.file('wpmz/waylines.wpml', xml);
  return await zip.generateAsync({ type: 'arraybuffer' });
}

function findNode(root: any, targetName: string): any {
  if (!root || typeof root !== 'object') return undefined;
  if (root[targetName]) return root[targetName];
  for (const key of Object.keys(root)) {
    if (typeof root[key] === 'object') {
      const found = findNode(root[key], targetName);
      if (found) return found;
    }
  }
  return undefined;
}

function collectPlacemarks(node: any, placemarks: any[] = []): any[] {
  if (!node || typeof node !== 'object') return placemarks;
  if (node.Placemark) {
    if (Array.isArray(node.Placemark)) {
      placemarks.push(...node.Placemark);
    } else {
      placemarks.push(node.Placemark);
    }
  }
  for (const key of Object.keys(node)) {
    if (key !== 'Placemark' && typeof node[key] === 'object') {
      collectPlacemarks(node[key], placemarks);
    }
  }
  return placemarks;
}
