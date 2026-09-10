/**
 * DJI Flight Log Web Worker Entrypoint
 * Executes heavy AES decryption and binary telemetry parsing off the main UI thread.
 * Leverages Transferable TypedArray ArrayBuffers for zero-copy memory dispatch.
 */

import { parseDjiFlightLog } from './djiParser';
import { FlightRecordPackage } from '../core/types';

export interface WorkerParseRequest {
  type?: 'PARSE';
  buffer: ArrayBuffer;
}

export interface WorkerParseSuccessResponse {
  type: 'SUCCESS';
  data: FlightRecordPackage;
}

export interface WorkerParseErrorResponse {
  type: 'ERROR';
  error: string;
}

export type WorkerResponse = WorkerParseSuccessResponse | WorkerParseErrorResponse;

/**
 * Extracts transferable ArrayBuffers from a parsed FlightRecordPackage.
 */
export function getTransferableBuffers(pkg: FlightRecordPackage): Transferable[] {
  const t = pkg.telemetry;
  return [
    t.timestamps.buffer,
    t.longitudes.buffer,
    t.latitudes.buffer,
    t.altitudes.buffer,
    t.heights.buffer,
    t.pitch.buffer,
    t.roll.buffer,
    t.yaw.buffer,
    t.speeds.buffer,
    t.rtkStatus.buffer,
    t.batteryPercents.buffer,
    t.batteryVoltages.buffer,
    t.maxCellVoltageDiff.buffer,
    t.maxCellTemp.buffer,
    t.gimbalPitch.buffer,
    t.gimbalYaw.buffer,
  ];
}

/**
 * Handles incoming raw buffer or request and parses flight record.
 */
export async function handleWorkerMessage(
  data: ArrayBuffer | WorkerParseRequest
): Promise<{ response: WorkerResponse; transferList?: Transferable[] }> {
  try {
    const rawBuffer = data instanceof ArrayBuffer ? data : data.buffer;
    if (!rawBuffer) {
      throw new Error('Worker received invalid or missing buffer payload');
    }
    const pkg = await parseDjiFlightLog(rawBuffer);
    const transferList = getTransferableBuffers(pkg);
    return {
      response: { type: 'SUCCESS', data: pkg },
      transferList,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      response: { type: 'ERROR', error: message },
    };
  }
}

// In dedicated Web Worker context
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  self.onmessage = async (event: MessageEvent<ArrayBuffer | WorkerParseRequest>) => {
    const result = await handleWorkerMessage(event.data);
    if (result.transferList) {
      (self as unknown as Worker).postMessage(result.response, result.transferList);
    } else {
      (self as unknown as Worker).postMessage(result.response);
    }
  };
}
