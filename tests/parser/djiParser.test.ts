import { describe, it, expect } from 'vitest';
import { parseDjiFlightLog, buildMockDjiBinaryBuffer } from '../../src/parser/djiParser';
import {
  decryptAes128Cbc,
  encryptAes128Cbc,
  decryptAes128CbcSync,
  encryptAes128CbcSync,
  DJI_DEFAULT_AES_KEY,
  DJI_DEFAULT_AES_IV,
} from '../../src/parser/cryptoUtils';
import { handleWorkerMessage, getTransferableBuffers } from '../../src/parser/parserWorker';

describe('DJI Log Parser', () => {
  it('should parse simulated DJI binary buffer and extract OSD and battery telemetries', async () => {
    const mockBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Matrice 350 RTK',
      pointsCount: 100,
      startLon: 120.123456,
      startLat: 30.123456,
      startAlt: 100.0,
    });
    const pkg = await parseDjiFlightLog(mockBuffer);
    expect(pkg.meta.aircraftType).toBe('Matrice 350 RTK');
    expect(pkg.telemetry.timestamps.length).toBe(100);
    expect(pkg.telemetry.longitudes[0]).toBeCloseTo(120.123456, 5);
    expect(pkg.telemetry.latitudes[0]).toBeCloseTo(30.123456, 5);
    expect(pkg.telemetry.maxCellVoltageDiff[0]).toBeGreaterThanOrEqual(0);
  });

  it('should parse AES-128 encrypted DJI binary log successfully', async () => {
    const mockBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Mavic 3 Enterprise',
      pointsCount: 50,
      startLon: 118.500000,
      startLat: 32.100000,
      startAlt: 150.0,
      encrypted: true,
    });
    const pkg = await parseDjiFlightLog(mockBuffer);
    expect(pkg.meta.aircraftType).toBe('Mavic 3 Enterprise');
    expect(pkg.telemetry.timestamps.length).toBe(50);
    expect(pkg.telemetry.longitudes[0]).toBeCloseTo(118.5, 5);
    expect(pkg.telemetry.latitudes[0]).toBeCloseTo(32.1, 5);
    expect(pkg.telemetry.altitudes[0]).toBeCloseTo(150.0, 1);
  });

  it('should extract photo events and warning events from log', async () => {
    const mockBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Matrice 30T',
      pointsCount: 30,
      photoCount: 4,
      warningCount: 2,
    });
    const pkg = await parseDjiFlightLog(mockBuffer);
    expect(pkg.events.photos.length).toBe(4);
    expect(pkg.events.photos[0].position.length).toBe(3);
    expect(pkg.events.photos[0].gimbalAngles.length).toBe(3);
    expect(pkg.events.photos[0].thumbnailBase64).toBeDefined();

    expect(pkg.events.warnings.length).toBe(2);
    expect(pkg.events.warnings[0].message).toBeTruthy();
    expect(['info', 'warning', 'critical']).toContain(pkg.events.warnings[0].level);
  });

  it('should calculate metadata: duration, total distance, max altitude, home location', async () => {
    const mockBuffer = buildMockDjiBinaryBuffer({
      pointsCount: 60,
      startLon: 120.0,
      startLat: 30.0,
      startAlt: 50.0,
    });
    const pkg = await parseDjiFlightLog(mockBuffer);
    expect(pkg.meta.durationMs).toBeGreaterThan(0);
    expect(pkg.meta.maxAltitude).toBeGreaterThanOrEqual(50.0);
    expect(pkg.meta.totalDistance).toBeGreaterThanOrEqual(0);
    expect(pkg.meta.homeLocation[0]).toBeCloseTo(120.0, 4);
    expect(pkg.meta.homeLocation[1]).toBeCloseTo(30.0, 4);
  });

  it('should properly populate all columns in TelemetryStream with matching lengths', async () => {
    const mockBuffer = buildMockDjiBinaryBuffer({ pointsCount: 25 });
    const pkg = await parseDjiFlightLog(mockBuffer);
    const t = pkg.telemetry;

    expect(t.timestamps.length).toBe(25);
    expect(t.longitudes.length).toBe(25);
    expect(t.latitudes.length).toBe(25);
    expect(t.altitudes.length).toBe(25);
    expect(t.heights.length).toBe(25);
    expect(t.pitch.length).toBe(25);
    expect(t.roll.length).toBe(25);
    expect(t.yaw.length).toBe(25);
    expect(t.speeds.length).toBe(25);
    expect(t.rtkStatus.length).toBe(25);
    expect(t.batteryPercents.length).toBe(25);
    expect(t.batteryVoltages.length).toBe(25);
    expect(t.maxCellVoltageDiff.length).toBe(25);
    expect(t.maxCellTemp.length).toBe(25);
    expect(t.gimbalPitch.length).toBe(25);
    expect(t.gimbalYaw.length).toBe(25);
  });

  it('should throw descriptive error on empty or corrupted buffer', async () => {
    const emptyBuffer = new ArrayBuffer(0);
    await expect(parseDjiFlightLog(emptyBuffer)).rejects.toThrow(/too small or empty/i);

    const corruptedBuffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer;
    await expect(parseDjiFlightLog(corruptedBuffer)).rejects.toThrow(/unrecognized format magic/i);
  });
});

describe('Crypto Utils (AES-128-CBC)', () => {
  it('should encrypt and decrypt data roundtrip via Web Crypto (async)', async () => {
    const key = DJI_DEFAULT_AES_KEY;
    const iv = DJI_DEFAULT_AES_IV;
    const text = 'FlightLog Secret Payload 2026';
    const plaintext = new TextEncoder().encode(text);

    const ciphertext = await encryptAes128Cbc(plaintext, key, iv);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(ciphertext).not.toEqual(plaintext);

    const decrypted = await decryptAes128Cbc(ciphertext, key, iv);
    expect(new TextDecoder().decode(decrypted)).toBe(text);
  });

  it('should encrypt and decrypt data roundtrip via synchronous AES-128-CBC', () => {
    const key = DJI_DEFAULT_AES_KEY;
    const iv = DJI_DEFAULT_AES_IV;
    const text = 'Synchronous AES-128 Testing string for mock generator';
    const plaintext = new TextEncoder().encode(text);

    const ciphertext = encryptAes128CbcSync(plaintext, key, iv);
    expect(ciphertext.length).toBeGreaterThan(0);

    const decrypted = decryptAes128CbcSync(ciphertext, key, iv);
    expect(new TextDecoder().decode(decrypted)).toBe(text);
  });

  it('should be cross-compatible between sync encrypt and async decrypt', async () => {
    const key = DJI_DEFAULT_AES_KEY;
    const iv = DJI_DEFAULT_AES_IV;
    const text = 'Cross compatibility verification';
    const plaintext = new TextEncoder().encode(text);

    const ciphertextSync = encryptAes128CbcSync(plaintext, key, iv);
    const decryptedAsync = await decryptAes128Cbc(ciphertextSync, key, iv);
    expect(new TextDecoder().decode(decryptedAsync)).toBe(text);

    const ciphertextAsync = await encryptAes128Cbc(plaintext, key, iv);
    const decryptedSync = decryptAes128CbcSync(ciphertextAsync, key, iv);
    expect(new TextDecoder().decode(decryptedSync)).toBe(text);
  });
});

describe('Parser Worker Protocol', () => {
  it('should process buffer via handleWorkerMessage and return success with transferables', async () => {
    const mockBuffer = buildMockDjiBinaryBuffer({ pointsCount: 15 });
    const result = await handleWorkerMessage(mockBuffer);
    expect(result.response.type).toBe('SUCCESS');
    if (result.response.type === 'SUCCESS') {
      expect(result.response.data.telemetry.timestamps.length).toBe(15);
    }
    expect(result.transferList?.length).toBe(16);
  });

  it('should return error response on invalid worker buffer', async () => {
    const result = await handleWorkerMessage(new ArrayBuffer(0));
    expect(result.response.type).toBe('ERROR');
    if (result.response.type === 'ERROR') {
      expect(result.response.error).toMatch(/too small or empty/i);
    }
  });
});
