/**
 * Dual-Directional Embedding Bridge SDK for DJI Drone Flight Log 3D Viewer
 *
 * Facilitates seamless, secure, 100% offline two-way communication between
 * the Web Flight Viewer and host embedding containers:
 * - iframe parent window (window.parent.postMessage)
 * - Unity Vuplex 3D WebView (window.vuplex.postMessage)
 * - Microsoft Edge WebView2 / Unity WebView (window.chrome.webview.postMessage)
 * - Desktop CEF / CefSharp runtime hosts
 */

import type { FlightRecordPackage, DeviationResult, WPMLRoute, FlightMeta } from '../core/types';
import type { Flight3DViewerEngine, CameraMode } from '../viewport/cesiumViewer';
import type { ColorMode } from '../viewport/trajectoryLayer';

export type InboundCommandType =
  | 'LOAD_FLIGHT'
  | 'LOAD_WPML'
  | 'PLAY'
  | 'PAUSE'
  | 'SEEK'
  | 'SET_RATE'
  | 'SET_CAMERA_MODE'
  | 'SET_COLOR_MODE'
  | 'SET_FRUSTUM_VISIBLE'
  | 'FLY_TO_DRONE';

export type OutboundEventType =
  | 'READY'
  | 'FLIGHT_LOADED'
  | 'TIME_UPDATE'
  | 'EVENT_CLICKED'
  | 'DEVIATION_ALERT'
  | 'ERROR';

export const OUTBOUND_EVENT_TYPES = new Set<string>([
  'READY',
  'FLIGHT_LOADED',
  'TIME_UPDATE',
  'EVENT_CLICKED',
  'DEVIATION_ALERT',
  'ERROR',
]);

export type BridgeMessageType = InboundCommandType | OutboundEventType;

export interface BridgeEnvelope<T = unknown> {
  type: BridgeMessageType;
  payload?: T;
  id?: string;
  source?: string;
  timestamp?: number;
}

export interface InboundCommand<T = unknown> extends BridgeEnvelope<T> {
  type: InboundCommandType;
}

export interface OutboundEvent<T = unknown> extends BridgeEnvelope<T> {
  type: OutboundEventType;
}

// Inbound command payloads
export interface SeekPayload {
  timeSec?: number;
  timeMs?: number;
}

export interface SetRatePayload {
  rate: number;
}

export interface SetCameraModePayload {
  mode: CameraMode;
}

export interface SetColorModePayload {
  mode: ColorMode;
}

export interface SetFrustumVisiblePayload {
  visible: boolean;
}

export interface FlyToDronePayload {
  duration?: number;
}

export interface LoadFlightPayload {
  flightPackage?: FlightRecordPackage;
  flightJson?: string;
  deviation?: DeviationResult | string;
}

export interface LoadWpmlPayload {
  route?: WPMLRoute;
  wpmlRoute?: WPMLRoute;
  wpmlJson?: string;
}

// Outbound event payloads
export interface ReadyPayload {
  version: string;
  capabilities: string[];
  ready?: boolean;
}

export interface FlightLoadedPayload {
  durationSec: number;
  pointCount: number;
  meta?: FlightMeta;
}

export interface TimeUpdatePayload {
  currentTimeMs: number;
  currentTimeSec?: number;
  telemetryFrame?: unknown;
}

export interface EventClickedPayload {
  eventType: 'photo' | 'warning' | 'anomaly';
  event: unknown;
}

export interface DeviationAlertPayload {
  maxDeviation: number;
  currentDeviation?: number;
  alertLevel: 'normal' | 'warning' | 'critical';
  point?: unknown;
}

export interface ErrorPayload {
  code: string | number;
  message: string;
  details?: unknown;
}

export interface FlightViewerBridgeOptions {
  /**
   * Allowed origins for message reception.
   * Can be a single origin, an array of allowed origins, or '*' for wildcard.
   * Default: '*'
   */
  allowedOrigins?: string[] | string;
  /**
   * Target origin for window.postMessage.
   * Default: '*'
   */
  targetOrigin?: string;
  /**
   * Optional Cesium Viewer engine instance to bind automatically.
   */
  viewer?: Flight3DViewerEngine;
  /**
   * Automatically register window message event listener.
   * Default: true
   */
  autoRegisterWindow?: boolean;
  /**
   * Bridge source identifier in message envelopes.
   * Default: 'flight-viewer-web'
   */
  sourceId?: string;
  /**
   * Enable verbose logging for debugging.
   */
  debug?: boolean;
}

export type BridgeEventHandler<T = any> = (payload: T) => void;

const VALID_INBOUND_COMMANDS = new Set<string>([
  'LOAD_FLIGHT',
  'LOAD_WPML',
  'PLAY',
  'PAUSE',
  'SEEK',
  'SET_RATE',
  'SET_CAMERA_MODE',
  'SET_COLOR_MODE',
  'SET_FRUSTUM_VISIBLE',
  'FLY_TO_DRONE',
]);

/**
 * Dual-Directional Bridge SDK between host application and Flight Viewer
 */
export class FlightViewerBridge {
  private options: FlightViewerBridgeOptions;
  private listeners: Map<string, Set<BridgeEventHandler>> = new Map();
  private viewer: Flight3DViewerEngine | null = null;
  private viewerUnsubscribe: (() => void) | null = null;
  private windowListener: ((event: MessageEvent) => void) | null = null;
  private isDestroyed = false;

  constructor(options: FlightViewerBridgeOptions = {}) {
    this.options = {
      allowedOrigins: '*',
      targetOrigin: '*',
      autoRegisterWindow: true,
      sourceId: 'flight-viewer-web',
      debug: false,
      ...options,
    };

    if (options.viewer) {
      this.attachViewer(options.viewer);
    }

    if (this.options.autoRegisterWindow && typeof window !== 'undefined') {
      this.registerWindowListener();
    }
  }

  /**
   * Attaches a Cesium Viewer engine instance to direct commands to.
   */
  public attachViewer(viewer: Flight3DViewerEngine): void {
    if (this.viewerUnsubscribe) {
      this.viewerUnsubscribe();
      this.viewerUnsubscribe = null;
    }

    this.viewer = viewer;

    // Automatically pipe viewer time updates out to host
    if (typeof viewer.onTimeUpdate === 'function') {
      this.viewerUnsubscribe = viewer.onTimeUpdate((timeSec, telemetry) => {
        const timeMs = telemetry?.timestamp ?? Math.round(timeSec * 1000);
        this.sendToHost('TIME_UPDATE', {
          currentTimeSec: timeSec,
          currentTimeMs: timeMs,
          telemetryFrame: telemetry,
        });
      });
    }
  }

  /**
   * Detaches currently attached viewer engine.
   */
  public detachViewer(): void {
    if (this.viewerUnsubscribe) {
      this.viewerUnsubscribe();
      this.viewerUnsubscribe = null;
    }
    this.viewer = null;
  }

  /**
   * Subscribes to a bridge event or command.
   * Returns an unsubscribe function.
   */
  public on<T = any>(type: BridgeMessageType, handler: BridgeEventHandler<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler as BridgeEventHandler);

    return () => {
      this.off(type, handler);
    };
  }

  /**
   * Unsubscribes a previously registered handler.
   */
  public off<T = any>(type: BridgeMessageType, handler: BridgeEventHandler<T>): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.delete(handler as BridgeEventHandler);
      if (handlers.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  /**
   * Emits an event to all locally registered listeners.
   */
  public emit<T = any>(type: BridgeMessageType, payload: T): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of Array.from(handlers)) {
        try {
          handler(payload);
        } catch (err) {
          if (this.options.debug) {
            console.error(`[FlightViewerBridge] Error in event listener for ${type}:`, err);
          }
        }
      }
    }
  }

  /**
   * Sends an outbound event message envelope to host container (iframe parent, Unity Vuplex, WebView2).
   */
  public sendToHost<T = any>(type: OutboundEventType, payload: T, id?: string): void {
    const envelope: OutboundEvent<T> = {
      type,
      payload,
      id,
      source: this.options.sourceId,
      timestamp: Date.now(),
    };

    // Notify local listeners
    this.emit(type, payload);

    if (typeof window === 'undefined') {
      return;
    }

    const targetOrigin = this.options.targetOrigin || '*';

    // 1. Unity Vuplex 3D WebView (window.vuplex)
    const win = window as any;
    if (win.vuplex && typeof win.vuplex.postMessage === 'function') {
      try {
        win.vuplex.postMessage(JSON.stringify(envelope));
        return;
      } catch (e) {
        if (this.options.debug) {
          console.warn('[FlightViewerBridge] Failed to postMessage via Vuplex:', e);
        }
      }
    }

    // 2. Microsoft Edge WebView2 / Unity Windows WebView (window.chrome.webview)
    if (win.chrome?.webview && typeof win.chrome.webview.postMessage === 'function') {
      try {
        win.chrome.webview.postMessage(envelope);
        return;
      } catch (e) {
        if (this.options.debug) {
          console.warn('[FlightViewerBridge] Failed to postMessage via chrome.webview:', e);
        }
      }
    }

    // 3. Iframe embedding parent window (only when embedded inside an iframe)
    if (win.parent && win.parent !== win && typeof win.parent.postMessage === 'function') {
      try {
        win.parent.postMessage(envelope, targetOrigin);
      } catch (e) {
        if (this.options.debug) {
          console.warn('[FlightViewerBridge] Failed to postMessage to parent:', e);
        }
      }
    } else if (win.opener && win.opener !== win && typeof win.opener.postMessage === 'function') {
      try {
        win.opener.postMessage(envelope, targetOrigin);
      } catch (e) {
        if (this.options.debug) {
          console.warn('[FlightViewerBridge] Failed to postMessage to opener:', e);
        }
      }
    }
  }

  /**
   * Ingests and processes an incoming message (from window.postMessage, Vuplex, CEF, or manual dispatch).
   * Validates origin and schema.
   * Returns true if message was processed successfully, false otherwise.
   */
  public handleMessage(messageOrEvent: unknown, origin?: string): boolean {
    if (this.isDestroyed) return false;

    let rawData: unknown = messageOrEvent;
    let messageOrigin = origin;

    // Detect browser MessageEvent
    if (
      typeof messageOrEvent === 'object' &&
      messageOrEvent !== null &&
      'data' in messageOrEvent &&
      'origin' in messageOrEvent
    ) {
      const msgEvent = messageOrEvent as MessageEvent;
      rawData = msgEvent.data;
      messageOrigin = messageOrigin ?? msgEvent.origin;
    }

    // Origin Validation
    if (!this.validateOrigin(messageOrigin)) {
      if (this.options.debug) {
        console.warn(`[FlightViewerBridge] Rejected message from unauthorized origin: ${messageOrigin}`);
      }
      return false;
    }

    // Parse payload if JSON string
    let parsed: any = rawData;
    if (typeof rawData === 'string') {
      try {
        parsed = JSON.parse(rawData);
      } catch (err) {
        this.sendError('PARSE_ERROR', 'Failed to parse incoming message JSON', { raw: rawData });
        return false;
      }
    }

    // Validate envelope structure
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return false;
    }

    // Ignore messages originating from this bridge itself
    if (parsed.source === this.options.sourceId) {
      return false;
    }

    // Silently ignore outbound event types received on inbound channel (prevents echo / loop storms)
    if (OUTBOUND_EVENT_TYPES.has(parsed.type)) {
      return false;
    }

    const type = parsed.type as InboundCommandType;

    // Validate command type
    if (!VALID_INBOUND_COMMANDS.has(type)) {
      this.sendError('INVALID_COMMAND', `Unrecognized command type: ${type}`, { received: parsed });
      return false;
    }

    const payload = parsed.payload;

    // Trigger registered command listeners
    this.emit(type, payload);

    // If viewer is attached, route command to viewer
    if (this.viewer) {
      this.executeViewerCommand(type, payload);
    }

    return true;
  }

  /**
   * Helper to dispatch an ERROR outbound event.
   */
  public sendError(code: string | number, message: string, details?: unknown): void {
    const errorPayload: ErrorPayload = { code, message, details };
    this.sendToHost('ERROR', errorPayload);
  }

  /**
   * Validates origin against allowedOrigins configuration.
   */
  private validateOrigin(origin?: string): boolean {
    const allowed = this.options.allowedOrigins ?? '*';

    // If wildcard or origin is undefined (local file / webview), allow
    if (allowed === '*' || !origin) {
      return true;
    }

    if (Array.isArray(allowed)) {
      return allowed.includes(origin);
    }

    return allowed === origin;
  }

  /**
   * Routes recognized inbound commands to attached Flight3DViewerEngine.
   */
  private executeViewerCommand(type: InboundCommandType, payload: any): void {
    if (!this.viewer) return;

    try {
      switch (type) {
        case 'PLAY':
          this.viewer.play();
          break;

        case 'PAUSE':
          this.viewer.pause();
          break;

        case 'SEEK': {
          const sec =
            typeof payload === 'number'
              ? payload
              : typeof payload?.timeSec === 'number'
              ? payload.timeSec
              : typeof payload?.timeMs === 'number'
              ? payload.timeMs / 1000
              : 0;
          this.viewer.seek(sec);
          break;
        }

        case 'SET_RATE': {
          const rate = typeof payload === 'number' ? payload : payload?.rate ?? 1.0;
          this.viewer.setPlaybackRate(rate);
          break;
        }

        case 'SET_CAMERA_MODE': {
          const mode = typeof payload === 'string' ? payload : payload?.mode ?? 'follow';
          this.viewer.setCameraMode(mode);
          break;
        }

        case 'SET_COLOR_MODE': {
          const mode = typeof payload === 'string' ? payload : payload?.mode ?? 'rtk';
          this.viewer.setColorMode(mode);
          break;
        }

        case 'SET_FRUSTUM_VISIBLE': {
          const visible =
            typeof payload === 'boolean' ? payload : payload?.visible !== false;
          this.viewer.setFrustumVisible(visible);
          break;
        }

        case 'FLY_TO_DRONE':
          this.viewer.flyToTrajectory();
          break;

        case 'LOAD_FLIGHT': {
          let rawPkg = payload?.flightPackage ?? payload?.flightJson ?? payload;
          if (typeof rawPkg === 'string') {
            try {
              rawPkg = JSON.parse(rawPkg);
            } catch (err) {
              this.sendError('PARSE_ERROR', 'Failed to parse flightPackage JSON string', { error: err });
              return;
            }
          }
          const pkg = rawPkg;
          let dev = payload?.deviation;
          if (typeof dev === 'string') {
            try {
              dev = JSON.parse(dev);
            } catch {
              // ignore deviation parse failure
            }
          }
          if (pkg && (pkg.telemetry || pkg.meta)) {
            if (pkg.telemetry) {
              this.ensureTelemetryTypedArrays(pkg.telemetry);
            }
            this.viewer.loadFlight(pkg, dev);
            this.sendToHost('FLIGHT_LOADED', {
              durationSec: (pkg.meta?.durationMs ?? 0) / 1000,
              pointCount: pkg.telemetry?.longitudes?.length ?? 0,
              meta: pkg.meta,
            });
          }
          break;
        }

        case 'LOAD_WPML': {
          let rawRoute = payload?.route ?? payload?.wpmlRoute ?? payload?.wpmlJson ?? payload;
          if (typeof rawRoute === 'string') {
            try {
              rawRoute = JSON.parse(rawRoute);
            } catch (err) {
              this.sendError('PARSE_ERROR', 'Failed to parse WPML route JSON string', { error: err });
              return;
            }
          }
          const route = rawRoute;
          if (route && Array.isArray(route.waypoints)) {
            this.viewer.loadPlannedRoute(route);
          }
          break;
        }
      }
    } catch (err) {
      this.sendError('EXECUTION_ERROR', `Failed executing command ${type}`, { error: err });
    }
  }

  /**
   * Ensures that telemetry streams deserialized from JSON objects or plain arrays
   * are reconstituted into proper TypedArrays expected by CesiumViewer and solvers.
   */
  private ensureTelemetryTypedArrays(telemetry: any): void {
    if (!telemetry) return;
    const toArray = (v: any) => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'object') {
        const keys = Object.keys(v).filter((k) => !isNaN(Number(k))).sort((a, b) => Number(a) - Number(b));
        return keys.map((k) => v[k]);
      }
      return [];
    };
    if (telemetry.timestamps && !(telemetry.timestamps instanceof Float64Array)) {
      telemetry.timestamps = new Float64Array(toArray(telemetry.timestamps));
    }
    if (telemetry.longitudes && !(telemetry.longitudes instanceof Float64Array)) {
      telemetry.longitudes = new Float64Array(toArray(telemetry.longitudes));
    }
    if (telemetry.latitudes && !(telemetry.latitudes instanceof Float64Array)) {
      telemetry.latitudes = new Float64Array(toArray(telemetry.latitudes));
    }
    if (telemetry.altitudes && !(telemetry.altitudes instanceof Float32Array)) {
      telemetry.altitudes = new Float32Array(toArray(telemetry.altitudes));
    }
    if (telemetry.heights && !(telemetry.heights instanceof Float32Array)) {
      telemetry.heights = new Float32Array(toArray(telemetry.heights));
    }
    if (telemetry.pitch && !(telemetry.pitch instanceof Float32Array)) {
      telemetry.pitch = new Float32Array(toArray(telemetry.pitch));
    }
    if (telemetry.roll && !(telemetry.roll instanceof Float32Array)) {
      telemetry.roll = new Float32Array(toArray(telemetry.roll));
    }
    if (telemetry.yaw && !(telemetry.yaw instanceof Float32Array)) {
      telemetry.yaw = new Float32Array(toArray(telemetry.yaw));
    }
    if (telemetry.speeds && !(telemetry.speeds instanceof Float32Array)) {
      telemetry.speeds = new Float32Array(toArray(telemetry.speeds));
    }
    if (telemetry.rtkStatus && !(telemetry.rtkStatus instanceof Uint8Array)) {
      telemetry.rtkStatus = new Uint8Array(toArray(telemetry.rtkStatus));
    }
    if (telemetry.batteryPercents && !(telemetry.batteryPercents instanceof Uint8Array)) {
      telemetry.batteryPercents = new Uint8Array(toArray(telemetry.batteryPercents));
    }
    if (telemetry.batteryVoltages && !(telemetry.batteryVoltages instanceof Float32Array)) {
      telemetry.batteryVoltages = new Float32Array(toArray(telemetry.batteryVoltages));
    }
    if (telemetry.maxCellVoltageDiff && !(telemetry.maxCellVoltageDiff instanceof Float32Array)) {
      telemetry.maxCellVoltageDiff = new Float32Array(toArray(telemetry.maxCellVoltageDiff));
    }
    if (telemetry.maxCellTemp && !(telemetry.maxCellTemp instanceof Float32Array)) {
      telemetry.maxCellTemp = new Float32Array(toArray(telemetry.maxCellTemp));
    }
    if (telemetry.gimbalPitch && !(telemetry.gimbalPitch instanceof Float32Array)) {
      telemetry.gimbalPitch = new Float32Array(toArray(telemetry.gimbalPitch));
    }
    if (telemetry.gimbalYaw && !(telemetry.gimbalYaw instanceof Float32Array)) {
      telemetry.gimbalYaw = new Float32Array(toArray(telemetry.gimbalYaw));
    }
  }

  /**
   * Registers global message event listener on window.
   */
  private registerWindowListener(): void {
    if (typeof window === 'undefined') return;

    this.windowListener = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    window.addEventListener('message', this.windowListener);

    // Global hook for direct host JavaScript injection (e.g. Unity CEF / CefSharp)
    const win = window as any;
    win.__FLIGHT_VIEWER_BRIDGE_RECEIVE__ = (msg: unknown) => {
      return this.handleMessage(msg);
    };
  }

  /**
   * Convenience programmatic controls
   */
  public play(): void {
    this.handleMessage({ type: 'PLAY', payload: {} });
  }

  public pause(): void {
    this.handleMessage({ type: 'PAUSE', payload: {} });
  }

  public seek(timeSec: number): void {
    this.handleMessage({ type: 'SEEK', payload: { timeSec } });
  }

  public setPlaybackRate(rate: number): void {
    this.handleMessage({ type: 'SET_RATE', payload: { rate } });
  }

  public setCameraMode(mode: CameraMode): void {
    this.handleMessage({ type: 'SET_CAMERA_MODE', payload: { mode } });
  }

  public setColorMode(mode: ColorMode): void {
    this.handleMessage({ type: 'SET_COLOR_MODE', payload: { mode } });
  }

  public setFrustumVisible(visible: boolean): void {
    this.handleMessage({ type: 'SET_FRUSTUM_VISIBLE', payload: { visible } });
  }

  public flyToDrone(): void {
    this.handleMessage({ type: 'FLY_TO_DRONE', payload: {} });
  }

  public loadFlight(flightPackage: FlightRecordPackage, deviation?: DeviationResult): void {
    this.handleMessage({ type: 'LOAD_FLIGHT', payload: { flightPackage, deviation } });
  }

  public loadWpml(route: WPMLRoute): void {
    this.handleMessage({ type: 'LOAD_WPML', payload: { route } });
  }

  /**
   * Initializes the bridge and signals READY to host.
   */
  public init(): void {
    this.sendToHost('READY', {
      version: '1.0.0',
      capabilities: [
        'offline-replay',
        '6dof-attitude',
        'camera-modes',
        'frustum-projection',
        'wpml-route',
        'deviation-alert',
        'hud-dashboard',
      ],
      ready: true,
    });
  }

  /**
   * Destroys bridge instance, detaches listeners and viewer hooks.
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.detachViewer();

    if (this.windowListener && typeof window !== 'undefined') {
      window.removeEventListener('message', this.windowListener);
      this.windowListener = null;
    }

    const win = typeof window !== 'undefined' ? (window as any) : null;
    if (win && win.__FLIGHT_VIEWER_BRIDGE_RECEIVE__) {
      delete win.__FLIGHT_VIEWER_BRIDGE_RECEIVE__;
    }

    this.listeners.clear();
  }
}
