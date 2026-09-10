/**
 * DJI Drone Flight Record Binary Parser & Offline Reader
 * Supports DJI FlightRecord / Pilot 2 binary frames, AES-128-CBC decryption,
 * and high-efficiency typed-array column extraction.
 */

import {
  FlightRecordPackage,
  TelemetryStream,
  PhotoEvent,
  WarningEvent,
  FlightMeta,
} from '../core/types';
import {
  decryptAes128Cbc,
  encryptAes128CbcSync,
  DJI_DEFAULT_AES_KEY,
  DJI_DEFAULT_AES_IV,
} from './cryptoUtils';

// Magic signature for DJI binary log format (8 bytes)
export const DJI_LOG_MAGIC = new Uint8Array([
  0x44, 0x4a, 0x49, 0x5f, 0x4c, 0x4f, 0x47, 0x01,
]); // "DJI_LOG\x01"

export const DJI_HEADER_SIZE = 256;

// DJI Record Frame Types
export const RECORD_TYPE_OSD = 0x01;
export const RECORD_TYPE_HOME = 0x02;
export const RECORD_TYPE_GIMBAL = 0x03;
export const RECORD_TYPE_BATTERY = 0x04;
export const RECORD_TYPE_PHOTO = 0x05;
export const RECORD_TYPE_WARNING = 0x08;

export interface MockDjiLogOptions {
  aircraftType?: string;
  aircraftSn?: string;
  cameraSn?: string;
  batterySnList?: string[];
  startTime?: number;
  pointsCount?: number;
  startLon?: number;
  startLat?: number;
  startAlt?: number;
  encrypted?: boolean;
  photoCount?: number;
  warningCount?: number;
}

/**
 * Calculates 3D distance between two WGS-84 coordinates in meters.
 */
function calculateDistance3D(
  lon1: number,
  lat1: number,
  alt1: number,
  lon2: number,
  lat2: number,
  alt2: number
): number {
  const R = 6371000; // Mean Earth radius in meters
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const meanLat = ((lat1 + lat2) / 2) * rad;
  const dx = dLon * Math.cos(meanLat) * R;
  const dy = dLat * R;
  const dz = alt2 - alt1;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Helper to write a null-padded string into a Uint8Array buffer at given offset.
 */
function writeFixedString(
  target: Uint8Array,
  offset: number,
  str: string,
  maxLen: number
): void {
  const encoded = new TextEncoder().encode(str);
  const copyLen = Math.min(encoded.length, maxLen);
  target.set(encoded.subarray(0, copyLen), offset);
  if (copyLen < maxLen) {
    target.fill(0, offset + copyLen, offset + maxLen);
  }
}

/**
 * Helper to read a null-terminated or fixed-width UTF-8 string from a Uint8Array.
 */
function readFixedString(bytes: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  while (end < offset + maxLen && bytes[end] !== 0) {
    end++;
  }
  return new TextDecoder('utf-8').decode(bytes.subarray(offset, end)).trim();
}

/**
 * Generates a valid simulated DJI binary flight record buffer for testing and mock data injection.
 */
export function buildMockDjiBinaryBuffer(options?: MockDjiLogOptions): ArrayBuffer {
  const opts = {
    aircraftType: options?.aircraftType ?? 'Matrice 350 RTK',
    aircraftSn: options?.aircraftSn ?? '1581F5X000189',
    cameraSn: options?.cameraSn ?? 'CAM-ZENMUSE-H20T',
    batterySnList: options?.batterySnList ?? ['TB65-01', 'TB65-02'],
    startTime: options?.startTime ?? 1700000000000,
    pointsCount: options?.pointsCount ?? 100,
    startLon: options?.startLon ?? 120.123456,
    startLat: options?.startLat ?? 30.123456,
    startAlt: options?.startAlt ?? 100.0,
    encrypted: options?.encrypted ?? false,
    photoCount: options?.photoCount ?? 0,
    warningCount: options?.warningCount ?? 0,
  };

  // 1. Build Header (256 bytes)
  const headerBuf = new Uint8Array(DJI_HEADER_SIZE);
  const headerView = new DataView(headerBuf.buffer);

  // Magic
  headerBuf.set(DJI_LOG_MAGIC, 0);
  // Header size: 256
  headerView.setUint32(8, DJI_HEADER_SIZE, true);
  // Encrypt type: 1 if encrypted, 0 if plain
  headerView.setUint8(12, opts.encrypted ? 1 : 0);
  // Start Time
  headerView.setFloat64(16, opts.startTime, true);
  // Aircraft Type (32 bytes at offset 24)
  writeFixedString(headerBuf, 24, opts.aircraftType, 32);
  // Aircraft SN (32 bytes at offset 56)
  writeFixedString(headerBuf, 56, opts.aircraftSn, 32);
  // Camera SN (32 bytes at offset 88)
  writeFixedString(headerBuf, 88, opts.cameraSn, 32);
  // Battery SN (32 bytes at offset 120)
  writeFixedString(headerBuf, 120, opts.batterySnList.join(','), 32);
  // IV (16 bytes at offset 152)
  headerBuf.set(DJI_DEFAULT_AES_IV, 152);

  // 2. Build Records Stream
  const recordChunks: Uint8Array[] = [];

  // Home location record (Type 2: 20 bytes payload)
  {
    const homeBuf = new Uint8Array(3 + 20);
    const homeView = new DataView(homeBuf.buffer);
    homeView.setUint8(0, RECORD_TYPE_HOME);
    homeView.setUint16(1, 20, true);
    homeView.setFloat64(3, opts.startLon, true);
    homeView.setFloat64(11, opts.startLat, true);
    homeView.setFloat32(19, opts.startAlt, true);
    recordChunks.push(homeBuf);
  }

  const N = opts.pointsCount;
  const photoInterval = opts.photoCount > 0 ? Math.max(1, Math.floor(N / opts.photoCount)) : 0;
  let photoIndexCounter = 0;
  const warningInterval = opts.warningCount > 0 ? Math.max(1, Math.floor(N / opts.warningCount)) : 0;
  let warningIndexCounter = 0;

  for (let i = 0; i < N; i++) {
    const timestamp = opts.startTime + i * 100; // 10 Hz
    const lon = opts.startLon + i * 0.00004 * Math.cos(i * 0.08);
    const lat = opts.startLat + i * 0.00004 * Math.sin(i * 0.08);
    const alt = opts.startAlt + Math.sin(i * 0.15) * 5.0;
    const height = Math.max(0, alt - opts.startAlt + 2.0);
    const pitch = Math.sin(i * 0.1) * 6.0;
    const roll = Math.cos(i * 0.1) * 3.0;
    const yaw = (i * 3.6) % 360;
    const speed = 5.0 + Math.sin(i * 0.05) * 2.5;
    const rtkStatus = 2; // Fixed

    // Type 1: OSD Frame (49 bytes payload)
    const osdBuf = new Uint8Array(3 + 49);
    const osdView = new DataView(osdBuf.buffer);
    osdView.setUint8(0, RECORD_TYPE_OSD);
    osdView.setUint16(1, 49, true);
    osdView.setFloat64(3, timestamp, true);
    osdView.setFloat64(11, lon, true);
    osdView.setFloat64(19, lat, true);
    osdView.setFloat32(27, alt, true);
    osdView.setFloat32(31, height, true);
    osdView.setFloat32(35, pitch, true);
    osdView.setFloat32(39, roll, true);
    osdView.setFloat32(43, yaw, true);
    osdView.setFloat32(47, speed, true);
    osdView.setUint8(51, rtkStatus);
    recordChunks.push(osdBuf);

    // Type 3: Gimbal Frame (20 bytes payload)
    const gimbalBuf = new Uint8Array(3 + 20);
    const gimbalView = new DataView(gimbalBuf.buffer);
    gimbalView.setUint8(0, RECORD_TYPE_GIMBAL);
    gimbalView.setUint16(1, 20, true);
    gimbalView.setFloat64(3, timestamp, true);
    gimbalView.setFloat32(11, -30 + Math.sin(i * 0.1) * 10, true); // gimbalPitch
    gimbalView.setFloat32(15, 0.0, true);                         // gimbalRoll
    gimbalView.setFloat32(19, (yaw + 5) % 360, true);              // gimbalYaw
    recordChunks.push(gimbalBuf);

    // Type 4: Battery Frame (50 bytes payload: 26 + 6*4)
    const batPayloadLen = 26 + 6 * 4;
    const batBuf = new Uint8Array(3 + batPayloadLen);
    const batView = new DataView(batBuf.buffer);
    batView.setUint8(0, RECORD_TYPE_BATTERY);
    batView.setUint16(1, batPayloadLen, true);
    batView.setFloat64(3, timestamp, true);
    batView.setUint8(11, Math.max(10, Math.round(100 - (i / Math.max(1, N)) * 30)));
    batView.setFloat32(12, 24.5 - (i / Math.max(1, N)) * 2.0, true); // total voltage
    batView.setFloat32(16, 12.5 + Math.sin(i * 0.2) * 3, true);       // current
    batView.setFloat32(20, 0.015 + Math.abs(Math.sin(i * 0.3)) * 0.02, true); // maxCellVoltageDiff
    batView.setFloat32(24, 28.0 + (i / Math.max(1, N)) * 6.0, true); // maxCellTemp
    batView.setUint8(28, 6); // cell count
    for (let c = 0; c < 6; c++) {
      batView.setFloat32(29 + c * 4, 4.0 - (i / Math.max(1, N)) * 0.3, true);
    }
    recordChunks.push(batBuf);

    // Optional Type 5: Camera Photo Event Frame
    if (photoInterval > 0 && i % photoInterval === 0 && photoIndexCounter < (opts.photoCount ?? 0)) {
      photoIndexCounter++;
      const thumbStr = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...';
      const thumbBytes = new TextEncoder().encode(thumbStr);
      const photoPayloadLen = 48 + thumbBytes.length;
      const photoBuf = new Uint8Array(3 + photoPayloadLen);
      const photoView = new DataView(photoBuf.buffer);
      photoView.setUint8(0, RECORD_TYPE_PHOTO);
      photoView.setUint16(1, photoPayloadLen, true);
      photoView.setFloat64(3, timestamp, true);
      photoView.setUint32(11, photoIndexCounter, true);
      photoView.setFloat64(15, lon, true);
      photoView.setFloat64(23, lat, true);
      photoView.setFloat32(31, alt, true);
      photoView.setFloat32(35, -45.0, true);
      photoView.setFloat32(39, 0.0, true);
      photoView.setFloat32(43, yaw, true);
      photoView.setUint32(47, thumbBytes.length, true);
      photoBuf.set(thumbBytes, 51);
      recordChunks.push(photoBuf);
    }

    // Optional Type 8: Warning Event Frame
    if (warningInterval > 0 && i % warningInterval === 0 && warningIndexCounter < (opts.warningCount ?? 0)) {
      warningIndexCounter++;
      const msg = `Warning event #${warningIndexCounter}: Payload sensor nominal`;
      const msgBytes = new TextEncoder().encode(msg);
      const warnPayloadLen = 15 + msgBytes.length;
      const warnBuf = new Uint8Array(3 + warnPayloadLen);
      const warnView = new DataView(warnBuf.buffer);
      warnView.setUint8(0, RECORD_TYPE_WARNING);
      warnView.setUint16(1, warnPayloadLen, true);
      warnView.setFloat64(3, timestamp, true);
      warnView.setUint8(11, (warningIndexCounter % 3) as number); // 0: info, 1: warning, 2: critical
      warnView.setUint32(12, 1000 + warningIndexCounter, true);
      warnView.setUint16(16, msgBytes.length, true);
      warnBuf.set(msgBytes, 18);
      recordChunks.push(warnBuf);
    }
  }

  // Calculate total record bytes length
  let totalRecordBytes = 0;
  for (const chunk of recordChunks) {
    totalRecordBytes += chunk.length;
  }

  const rawRecords = new Uint8Array(totalRecordBytes);
  let curOffset = 0;
  for (const chunk of recordChunks) {
    rawRecords.set(chunk, curOffset);
    curOffset += chunk.length;
  }

  // 3. Encrypt payload if specified
  const payloadBytes = opts.encrypted
    ? encryptAes128CbcSync(rawRecords, DJI_DEFAULT_AES_KEY, DJI_DEFAULT_AES_IV)
    : rawRecords;

  // 4. Combine Header + Payload into single ArrayBuffer
  const fullBuffer = new Uint8Array(DJI_HEADER_SIZE + payloadBytes.length);
  fullBuffer.set(headerBuf, 0);
  fullBuffer.set(payloadBytes, DJI_HEADER_SIZE);

  return fullBuffer.buffer;
}

/**
 * Offline DJI Flight Record reader & parser.
 * Reads binary DJI log buffers, decrypts AES-128-CBC records, and unpacks telemetry streams.
 */
export async function parseDjiFlightLog(buffer: ArrayBuffer): Promise<FlightRecordPackage> {
  if (!buffer || buffer.byteLength < 8) {
    throw new Error('Invalid DJI flight log: buffer too small or empty');
  }

  const magic = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  for (let i = 0; i < DJI_LOG_MAGIC.length; i++) {
    if (magic[i] !== DJI_LOG_MAGIC[i]) {
      throw new Error('Invalid DJI flight log: unrecognized format magic');
    }
  }

  if (buffer.byteLength < DJI_HEADER_SIZE) {
    throw new Error('Invalid DJI flight log: buffer truncated before complete header');
  }

  const headerView = new DataView(buffer, 0, DJI_HEADER_SIZE);
  const headerSize = headerView.getUint32(8, true);
  const encryptType = headerView.getUint8(12);
  const startTime = headerView.getFloat64(16, true);

  const headerBytes = new Uint8Array(buffer, 0, DJI_HEADER_SIZE);
  const aircraftType = readFixedString(headerBytes, 24, 32) || 'Matrice 350 RTK';
  const aircraftSn = readFixedString(headerBytes, 56, 32);
  const cameraSn = readFixedString(headerBytes, 88, 32);
  const batterySnStr = readFixedString(headerBytes, 120, 32);
  const batterySnList = batterySnStr ? batterySnStr.split(',').map((s) => s.trim()) : [];
  const iv = headerBytes.subarray(152, 168);

  // Extract payload slice
  const rawPayload = new Uint8Array(buffer, headerSize);
  let recordBytes: Uint8Array;

  if (encryptType === 1) {
    recordBytes = await decryptAes128Cbc(rawPayload, DJI_DEFAULT_AES_KEY, iv);
  } else {
    recordBytes = rawPayload;
  }

  // Parse frames
  const recordView = new DataView(
    recordBytes.buffer,
    recordBytes.byteOffset,
    recordBytes.byteLength
  );

  const timestamps: number[] = [];
  const longitudes: number[] = [];
  const latitudes: number[] = [];
  const altitudes: number[] = [];
  const heights: number[] = [];
  const pitchArr: number[] = [];
  const rollArr: number[] = [];
  const yawArr: number[] = [];
  const speeds: number[] = [];
  const rtkStatusArr: number[] = [];
  const batteryPercents: number[] = [];
  const batteryVoltages: number[] = [];
  const maxCellVoltageDiffArr: number[] = [];
  const maxCellTempArr: number[] = [];
  const gimbalPitchArr: number[] = [];
  const gimbalYawArr: number[] = [];

  const photos: PhotoEvent[] = [];
  const warnings: WarningEvent[] = [];
  let homeLocation: [number, number, number] = [0, 0, 0];

  // Latest known state tracker
  let curGimbalPitch = 0;
  let curGimbalYaw = 0;
  let curBatPercent = 100;
  let curBatVoltage = 24.0;
  let curMaxCellDiff = 0.01;
  let curMaxTemp = 25.0;

  let offset = 0;
  while (offset + 3 <= recordBytes.byteLength) {
    const recordType = recordView.getUint8(offset);
    const length = recordView.getUint16(offset + 1, true);
    const payloadOffset = offset + 3;

    if (payloadOffset + length > recordBytes.byteLength) {
      break;
    }

    switch (recordType) {
      case RECORD_TYPE_HOME: {
        if (length >= 20) {
          const hLon = recordView.getFloat64(payloadOffset, true);
          const hLat = recordView.getFloat64(payloadOffset + 8, true);
          const hAlt = recordView.getFloat32(payloadOffset + 16, true);
          homeLocation = [hLon, hLat, hAlt];
        }
        break;
      }

      case RECORD_TYPE_GIMBAL: {
        if (length >= 20) {
          const gPitch = recordView.getFloat32(payloadOffset + 8, true);
          const gYaw = recordView.getFloat32(payloadOffset + 16, true);
          curGimbalPitch = gPitch;
          curGimbalYaw = gYaw;
          const idx = timestamps.length - 1;
          if (idx >= 0) {
            gimbalPitchArr[idx] = curGimbalPitch;
            gimbalYawArr[idx] = curGimbalYaw;
          }
        }
        break;
      }

      case RECORD_TYPE_BATTERY: {
        if (length >= 25) {
          curBatPercent = recordView.getUint8(payloadOffset + 8);
          curBatVoltage = recordView.getFloat32(payloadOffset + 9, true);
          curMaxCellDiff = recordView.getFloat32(payloadOffset + 17, true);
          curMaxTemp = recordView.getFloat32(payloadOffset + 21, true);
          const idx = timestamps.length - 1;
          if (idx >= 0) {
            batteryPercents[idx] = curBatPercent;
            batteryVoltages[idx] = curBatVoltage;
            maxCellVoltageDiffArr[idx] = curMaxCellDiff;
            maxCellTempArr[idx] = curMaxTemp;
          }
        }
        break;
      }

      case RECORD_TYPE_OSD: {
        if (length >= 49) {
          const ts = recordView.getFloat64(payloadOffset, true);
          const lon = recordView.getFloat64(payloadOffset + 8, true);
          const lat = recordView.getFloat64(payloadOffset + 16, true);
          const alt = recordView.getFloat32(payloadOffset + 24, true);
          const h = recordView.getFloat32(payloadOffset + 28, true);
          const p = recordView.getFloat32(payloadOffset + 32, true);
          const r = recordView.getFloat32(payloadOffset + 36, true);
          const y = recordView.getFloat32(payloadOffset + 40, true);
          const spd = recordView.getFloat32(payloadOffset + 44, true);
          const rtk = recordView.getUint8(payloadOffset + 48);

          timestamps.push(ts);
          longitudes.push(lon);
          latitudes.push(lat);
          altitudes.push(alt);
          heights.push(h);
          pitchArr.push(p);
          rollArr.push(r);
          yawArr.push(y);
          speeds.push(spd);
          rtkStatusArr.push(rtk);

          batteryPercents.push(curBatPercent);
          batteryVoltages.push(curBatVoltage);
          maxCellVoltageDiffArr.push(curMaxCellDiff);
          maxCellTempArr.push(curMaxTemp);
          gimbalPitchArr.push(curGimbalPitch);
          gimbalYawArr.push(curGimbalYaw);
        }
        break;
      }

      case RECORD_TYPE_PHOTO: {
        if (length >= 48) {
          const ts = recordView.getFloat64(payloadOffset, true);
          const pIdx = recordView.getUint32(payloadOffset + 8, true);
          const pLon = recordView.getFloat64(payloadOffset + 12, true);
          const pLat = recordView.getFloat64(payloadOffset + 20, true);
          const pAlt = recordView.getFloat32(payloadOffset + 28, true);
          const gp = recordView.getFloat32(payloadOffset + 32, true);
          const gr = recordView.getFloat32(payloadOffset + 36, true);
          const gy = recordView.getFloat32(payloadOffset + 40, true);
          const thumbLen = recordView.getUint32(payloadOffset + 44, true);
          let thumbBase64: string | undefined;
          if (thumbLen > 0 && payloadOffset + 48 + thumbLen <= recordBytes.byteLength) {
            const thumbBytes = recordBytes.subarray(payloadOffset + 48, payloadOffset + 48 + thumbLen);
            thumbBase64 = new TextDecoder('utf-8').decode(thumbBytes);
          }
          photos.push({
            id: `photo-${pIdx}-${ts}`,
            timestamp: ts,
            index: pIdx,
            position: [pLon, pLat, pAlt],
            gimbalAngles: [gp, gr, gy],
            thumbnailBase64: thumbBase64,
          });
        }
        break;
      }

      case RECORD_TYPE_WARNING: {
        if (length >= 15) {
          const ts = recordView.getFloat64(payloadOffset, true);
          const lvl = recordView.getUint8(payloadOffset + 8);
          const code = recordView.getUint32(payloadOffset + 9, true);
          const msgLen = recordView.getUint16(payloadOffset + 13, true);
          let message = '';
          if (msgLen > 0 && payloadOffset + 15 + msgLen <= recordBytes.byteLength) {
            const msgBytes = recordBytes.subarray(payloadOffset + 15, payloadOffset + 15 + msgLen);
            message = new TextDecoder('utf-8').decode(msgBytes);
          }
          const levelStr: 'info' | 'warning' | 'critical' =
            lvl === 2 ? 'critical' : lvl === 1 ? 'warning' : 'info';
          warnings.push({
            timestamp: ts,
            level: levelStr,
            code,
            message,
          });
        }
        break;
      }

      default:
        // Ignore unknown frame types gracefully
        break;
    }

    offset += 3 + length;
  }

  const pointCount = timestamps.length;
  let totalDistance = 0;
  let maxAltitude = 0;

  for (let i = 0; i < pointCount; i++) {
    if (altitudes[i] > maxAltitude) {
      maxAltitude = altitudes[i];
    }
    if (i > 0) {
      totalDistance += calculateDistance3D(
        longitudes[i - 1],
        latitudes[i - 1],
        altitudes[i - 1],
        longitudes[i],
        latitudes[i],
        altitudes[i]
      );
    }
  }

  if (homeLocation[0] === 0 && homeLocation[1] === 0 && pointCount > 0) {
    homeLocation = [longitudes[0], latitudes[0], altitudes[0]];
  }

  const durationMs =
    pointCount > 0 ? Math.max(0, timestamps[pointCount - 1] - timestamps[0]) : 0;

  const meta: FlightMeta = {
    aircraftType,
    aircraftSn,
    cameraSn,
    batterySnList,
    startTime: startTime || (pointCount > 0 ? timestamps[0] : 0),
    durationMs,
    totalDistance,
    maxAltitude,
    homeLocation,
  };

  const telemetry: TelemetryStream = {
    timestamps: Float64Array.from(timestamps),
    longitudes: Float64Array.from(longitudes),
    latitudes: Float64Array.from(latitudes),
    altitudes: Float32Array.from(altitudes),
    heights: Float32Array.from(heights),
    pitch: Float32Array.from(pitchArr),
    roll: Float32Array.from(rollArr),
    yaw: Float32Array.from(yawArr),
    speeds: Float32Array.from(speeds),
    rtkStatus: Uint8Array.from(rtkStatusArr),
    batteryPercents: Uint8Array.from(batteryPercents),
    batteryVoltages: Float32Array.from(batteryVoltages),
    maxCellVoltageDiff: Float32Array.from(maxCellVoltageDiffArr),
    maxCellTemp: Float32Array.from(maxCellTempArr),
    gimbalPitch: Float32Array.from(gimbalPitchArr),
    gimbalYaw: Float32Array.from(gimbalYawArr),
  };

  return {
    meta,
    telemetry,
    events: {
      photos,
      warnings,
    },
  };
}
