import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FlightViewerBridge,
  type InboundCommand,
  type OutboundEvent,
  type InboundCommandType,
  type OutboundEventType,
} from '../../src/bridge/flightViewerBridge';

describe('Flight Viewer Host Bridge Protocol', () => {
  let bridge: FlightViewerBridge;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (bridge) {
      bridge.destroy();
    }
  });

  describe('Event Emitter & Subscription (on, off, emit)', () => {
    it('should correctly subscribe to outbound events with on() and receive payload via emit()', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const mockCallback = vi.fn();

      bridge.on('TIME_UPDATE', mockCallback);
      bridge.emit('TIME_UPDATE', {
        currentTimeMs: 12345,
        currentTimeSec: 12.345,
        telemetryFrame: { speed: 12.5 },
      });

      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockCallback).toHaveBeenCalledWith({
        currentTimeMs: 12345,
        currentTimeSec: 12.345,
        telemetryFrame: { speed: 12.5 },
      });
    });

    it('should allow unsubscribing via returned unsubscribe function or off()', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const unsubscribe1 = bridge.on('PLAY', callback1);
      bridge.on('PLAY', callback2);

      bridge.emit('PLAY', {});
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      // Unsubscribe callback1 via returned function
      unsubscribe1();
      // Unsubscribe callback2 via off
      bridge.off('PLAY', callback2);

      bridge.emit('PLAY', {});
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple listeners for the same event type', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const calls: string[] = [];

      bridge.on('READY', () => calls.push('first'));
      bridge.on('READY', () => calls.push('second'));

      bridge.emit('READY', { version: '1.0.0', capabilities: ['replay'] });
      expect(calls).toEqual(['first', 'second']);
    });
  });

  describe('Origin Security Validation', () => {
    it('should accept messages from allowed origin when origins list is specified', () => {
      bridge = new FlightViewerBridge({
        allowedOrigins: ['https://trackplan.enterprise.internal', 'http://localhost:8080'],
        autoRegisterWindow: false,
      });

      const playSpy = vi.fn();
      bridge.on('PLAY', playSpy);

      // Trusted origin
      const handled = bridge.handleMessage(
        { type: 'PLAY', payload: {} },
        'https://trackplan.enterprise.internal'
      );

      expect(handled).toBe(true);
      expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('should reject messages from unauthorized origins', () => {
      bridge = new FlightViewerBridge({
        allowedOrigins: ['https://trackplan.enterprise.internal'],
        autoRegisterWindow: false,
      });

      const playSpy = vi.fn();
      bridge.on('PLAY', playSpy);

      // Untrusted origin
      const handled = bridge.handleMessage(
        { type: 'PLAY', payload: {} },
        'https://malicious-attacker.com'
      );

      expect(handled).toBe(false);
      expect(playSpy).not.toHaveBeenCalled();
    });

    it('should allow wildcard origin "*" when specified', () => {
      bridge = new FlightViewerBridge({
        allowedOrigins: '*',
        autoRegisterWindow: false,
      });

      const pauseSpy = vi.fn();
      bridge.on('PAUSE', pauseSpy);

      const handled = bridge.handleMessage(
        { type: 'PAUSE', payload: {} },
        'vscode-webview://any-host'
      );

      expect(handled).toBe(true);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Inbound Command Processing & Schema Validation', () => {
    it('should parse valid stringified JSON message envelopes', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const seekSpy = vi.fn();
      bridge.on('SEEK', seekSpy);

      const jsonString = JSON.stringify({
        type: 'SEEK',
        payload: { timeSec: 42.5 },
      });

      const handled = bridge.handleMessage(jsonString);
      expect(handled).toBe(true);
      expect(seekSpy).toHaveBeenCalledWith({ timeSec: 42.5 });
    });

    it('should reject malformed JSON with ERROR event', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const errorSpy = vi.fn();
      bridge.on('ERROR', errorSpy);

      const handled = bridge.handleMessage('not-valid-json{');
      expect(handled).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0].code).toBe('PARSE_ERROR');
    });

    it('should reject messages without a recognized command type', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const errorSpy = vi.fn();
      bridge.on('ERROR', errorSpy);

      const handled = bridge.handleMessage({ type: 'UNKNOWN_CMD', payload: {} });
      expect(handled).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0].code).toBe('INVALID_COMMAND');
    });

    it('should process all defined inbound commands correctly', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });

      const received: Record<string, unknown> = {};
      const commands: InboundCommandType[] = [
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
      ];

      for (const cmd of commands) {
        bridge.on(cmd, (payload) => {
          received[cmd] = payload;
        });
      }

      bridge.handleMessage({ type: 'LOAD_FLIGHT', payload: { mockFlight: true } });
      bridge.handleMessage({ type: 'LOAD_WPML', payload: { mockRoute: true } });
      bridge.handleMessage({ type: 'PLAY', payload: {} });
      bridge.handleMessage({ type: 'PAUSE', payload: {} });
      bridge.handleMessage({ type: 'SEEK', payload: { timeSec: 15.0 } });
      bridge.handleMessage({ type: 'SET_RATE', payload: { rate: 2.0 } });
      bridge.handleMessage({ type: 'SET_CAMERA_MODE', payload: { mode: 'fpv_gimbal' } });
      bridge.handleMessage({ type: 'SET_COLOR_MODE', payload: { mode: 'deviation' } });
      bridge.handleMessage({ type: 'SET_FRUSTUM_VISIBLE', payload: { visible: false } });
      bridge.handleMessage({ type: 'FLY_TO_DRONE', payload: { duration: 2.0 } });

      expect(received['LOAD_FLIGHT']).toEqual({ mockFlight: true });
      expect(received['LOAD_WPML']).toEqual({ mockRoute: true });
      expect(received['PLAY']).toEqual({});
      expect(received['PAUSE']).toEqual({});
      expect(received['SEEK']).toEqual({ timeSec: 15.0 });
      expect(received['SET_RATE']).toEqual({ rate: 2.0 });
      expect(received['SET_CAMERA_MODE']).toEqual({ mode: 'fpv_gimbal' });
      expect(received['SET_COLOR_MODE']).toEqual({ mode: 'deviation' });
      expect(received['SET_FRUSTUM_VISIBLE']).toEqual({ visible: false });
      expect(received['FLY_TO_DRONE']).toEqual({ duration: 2.0 });
    });
  });

  describe('Outbound Host Message Dispatching', () => {
    it('should dispatch messages to parent window when embedded in iframe', () => {
      const mockPostMessage = vi.fn();
      const mockParent = { postMessage: mockPostMessage };

      const originalWindow = globalThis.window;
      // Setup mock window environment
      (globalThis as any).window = {
        parent: mockParent,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      try {
        bridge = new FlightViewerBridge({
          autoRegisterWindow: false,
          targetOrigin: 'https://unity-host.app',
        });

        bridge.sendToHost('READY', { version: '1.0.0', capabilities: ['3d-replay', 'hud'] });

        expect(mockPostMessage).toHaveBeenCalledTimes(1);
        const sentEnvelope = mockPostMessage.mock.calls[0][0];
        expect(sentEnvelope.type).toBe('READY');
        expect(sentEnvelope.payload).toEqual({
          version: '1.0.0',
          capabilities: ['3d-replay', 'hud'],
        });
        expect(mockPostMessage.mock.calls[0][1]).toBe('https://unity-host.app');
      } finally {
        globalThis.window = originalWindow;
      }
    });

    it('should dispatch messages to Vuplex 3D WebView when window.vuplex is present', () => {
      const mockVuplexPostMessage = vi.fn();
      const originalWindow = globalThis.window;

      (globalThis as any).window = {
        vuplex: { postMessage: mockVuplexPostMessage },
        parent: undefined,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      try {
        bridge = new FlightViewerBridge({ autoRegisterWindow: false });
        bridge.sendToHost('TIME_UPDATE', {
          currentTimeMs: 5000,
          currentTimeSec: 5.0,
          telemetryFrame: { altitude: 120.5 },
        });

        expect(mockVuplexPostMessage).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(mockVuplexPostMessage.mock.calls[0][0]);
        expect(parsed.type).toBe('TIME_UPDATE');
        expect(parsed.payload.currentTimeMs).toBe(5000);
      } finally {
        globalThis.window = originalWindow;
      }
    });

    it('should dispatch messages to Microsoft Edge WebView2 / Chrome WebView when present', () => {
      const mockChromePostMessage = vi.fn();
      const originalWindow = globalThis.window;

      (globalThis as any).window = {
        chrome: { webview: { postMessage: mockChromePostMessage } },
        parent: undefined,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      try {
        bridge = new FlightViewerBridge({ autoRegisterWindow: false });
        bridge.sendToHost('DEVIATION_ALERT', {
          maxDeviation: 3.8,
          alertLevel: 'warning',
        });

        expect(mockChromePostMessage).toHaveBeenCalledTimes(1);
        const sent = mockChromePostMessage.mock.calls[0][0];
        expect(sent.type).toBe('DEVIATION_ALERT');
        expect(sent.payload.alertLevel).toBe('warning');
      } finally {
        globalThis.window = originalWindow;
      }
    });
  });

  describe('Viewer Direct Attachment Integration', () => {
    it('should drive attached viewer engine methods upon receiving corresponding commands', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });

      const mockViewer = {
        play: vi.fn(),
        pause: vi.fn(),
        seek: vi.fn(),
        setPlaybackRate: vi.fn(),
        setCameraMode: vi.fn(),
        setColorMode: vi.fn(),
        setFrustumVisible: vi.fn(),
        flyToTrajectory: vi.fn(),
        loadFlight: vi.fn(),
        loadPlannedRoute: vi.fn(),
        onTimeUpdate: vi.fn(() => vi.fn()),
      };

      bridge.attachViewer(mockViewer as any);

      bridge.handleMessage({ type: 'PLAY', payload: {} });
      expect(mockViewer.play).toHaveBeenCalledTimes(1);

      bridge.handleMessage({ type: 'PAUSE', payload: {} });
      expect(mockViewer.pause).toHaveBeenCalledTimes(1);

      bridge.handleMessage({ type: 'SEEK', payload: { timeSec: 25.5 } });
      expect(mockViewer.seek).toHaveBeenCalledWith(25.5);

      bridge.handleMessage({ type: 'SET_RATE', payload: { rate: 4.0 } });
      expect(mockViewer.setPlaybackRate).toHaveBeenCalledWith(4.0);

      bridge.handleMessage({ type: 'SET_CAMERA_MODE', payload: { mode: 'top_down' } });
      expect(mockViewer.setCameraMode).toHaveBeenCalledWith('top_down');

      bridge.handleMessage({ type: 'SET_COLOR_MODE', payload: { mode: 'battery' } });
      expect(mockViewer.setColorMode).toHaveBeenCalledWith('battery');

      bridge.handleMessage({ type: 'SET_FRUSTUM_VISIBLE', payload: { visible: true } });
      expect(mockViewer.setFrustumVisible).toHaveBeenCalledWith(true);

      bridge.handleMessage({ type: 'FLY_TO_DRONE', payload: {} });
      expect(mockViewer.flyToTrajectory).toHaveBeenCalledTimes(1);
    });

    it('should forward viewer time updates to bridge host outbound channel', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });

      let registeredTimeCallback: ((sec: number, tel: any) => void) | null = null;
      const mockViewer = {
        onTimeUpdate: vi.fn((cb) => {
          registeredTimeCallback = cb;
          return () => {
            registeredTimeCallback = null;
          };
        }),
      };

      bridge.attachViewer(mockViewer as any);
      expect(registeredTimeCallback).toBeDefined();

      const timeUpdateListener = vi.fn();
      bridge.on('TIME_UPDATE', timeUpdateListener);

      // Simulate viewer tick
      registeredTimeCallback!(10.5, {
        timestamp: 1600000010500,
        longitude: 114.1,
        latitude: 22.5,
        altitude: 150.0,
      });

      expect(timeUpdateListener).toHaveBeenCalledTimes(1);
      expect(timeUpdateListener.mock.calls[0][0].currentTimeSec).toBe(10.5);
      expect(timeUpdateListener.mock.calls[0][0].currentTimeMs).toBe(1600000010500);
    });
  });

  describe('Programmatic Control APIs & Init Handshake', () => {
    it('should emit READY event on init() with version and capabilities', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const readySpy = vi.fn();
      bridge.on('READY', readySpy);

      bridge.init();

      expect(readySpy).toHaveBeenCalledTimes(1);
      const payload = readySpy.mock.calls[0][0];
      expect(payload.version).toBe('1.0.0');
      expect(payload.ready).toBe(true);
      expect(payload.capabilities).toContain('offline-replay');
      expect(payload.capabilities).toContain('6dof-attitude');
    });

    it('should invoke appropriate commands via programmatic convenience methods', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const calls: string[] = [];

      bridge.on('PLAY', () => calls.push('play'));
      bridge.on('PAUSE', () => calls.push('pause'));
      bridge.on('SEEK', (p) => calls.push(`seek:${p.timeSec}`));
      bridge.on('SET_RATE', (p) => calls.push(`rate:${p.rate}`));
      bridge.on('SET_CAMERA_MODE', (p) => calls.push(`cam:${p.mode}`));
      bridge.on('SET_COLOR_MODE', (p) => calls.push(`col:${p.mode}`));
      bridge.on('SET_FRUSTUM_VISIBLE', (p) => calls.push(`frustum:${p.visible}`));
      bridge.on('FLY_TO_DRONE', () => calls.push('fly'));

      bridge.play();
      bridge.pause();
      bridge.seek(12.5);
      bridge.setPlaybackRate(2.5);
      bridge.setCameraMode('fpv_gimbal');
      bridge.setColorMode('speed');
      bridge.setFrustumVisible(false);
      bridge.flyToDrone();

      expect(calls).toEqual([
        'play',
        'pause',
        'seek:12.5',
        'rate:2.5',
        'cam:fpv_gimbal',
        'col:speed',
        'frustum:false',
        'fly',
      ]);
    });
  });

  describe('Host Direct JavaScript Injection (__FLIGHT_VIEWER_BRIDGE_RECEIVE__)', () => {
    it('should expose global injection function and handle injected commands', () => {
      const originalWindow = globalThis.window;
      const fakeWindow: any = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      (globalThis as any).window = fakeWindow;

      try {
        bridge = new FlightViewerBridge({ autoRegisterWindow: true });
        expect(fakeWindow.__FLIGHT_VIEWER_BRIDGE_RECEIVE__).toBeTypeOf('function');

        const playSpy = vi.fn();
        bridge.on('PLAY', playSpy);

        const result = fakeWindow.__FLIGHT_VIEWER_BRIDGE_RECEIVE__({ type: 'PLAY', payload: {} });
        expect(result).toBe(true);
        expect(playSpy).toHaveBeenCalledTimes(1);

        bridge.destroy();
        expect(fakeWindow.__FLIGHT_VIEWER_BRIDGE_RECEIVE__).toBeUndefined();
      } finally {
        globalThis.window = originalWindow;
      }
    });
  });

  describe('Window Event Listener Lifecycle & Detach', () => {
    it('should register and clean up window message event listeners', () => {
      const addListenerSpy = vi.fn();
      const removeListenerSpy = vi.fn();
      const originalWindow = globalThis.window;

      (globalThis as any).window = {
        addEventListener: addListenerSpy,
        removeEventListener: removeListenerSpy,
      };

      try {
        const testBridge = new FlightViewerBridge({ autoRegisterWindow: true });
        expect(addListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));

        testBridge.destroy();
        expect(removeListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
      } finally {
        globalThis.window = originalWindow;
      }
    });

    it('should cleanly detach viewer when requested or destroyed', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const unbindSpy = vi.fn();
      const mockViewer = {
        onTimeUpdate: vi.fn(() => unbindSpy),
      };

      bridge.attachViewer(mockViewer as any);
      bridge.detachViewer();
      expect(unbindSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit EXECUTION_ERROR when attached viewer method throws', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const errorSpy = vi.fn();
      bridge.on('ERROR', errorSpy);

      const faultyViewer = {
        play: () => {
          throw new Error('WebGL context lost');
        },
      };

      bridge.attachViewer(faultyViewer as any);
      bridge.handleMessage({ type: 'PLAY', payload: {} });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0].code).toBe('EXECUTION_ERROR');
    });

    it('should execute LOAD_FLIGHT with direct package and stringified flightJson, reconstructing TypedArrays', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const mockViewer = {
        loadFlight: vi.fn(),
      };
      bridge.attachViewer(mockViewer as any);

      const flightLoadedSpy = vi.fn();
      bridge.on('FLIGHT_LOADED', flightLoadedSpy);

      // Case 1: Direct object
      const pkg1 = {
        meta: { durationMs: 60000 },
        telemetry: {
          timestamps: new Float64Array([1000, 2000]),
          longitudes: new Float64Array([120.0, 120.1]),
        },
      };
      bridge.handleMessage({ type: 'LOAD_FLIGHT', payload: { flightPackage: pkg1 } });
      expect(mockViewer.loadFlight).toHaveBeenCalledTimes(1);
      expect(flightLoadedSpy).toHaveBeenCalledTimes(1);

      // Case 2: Stringified flightJson with plain arrays (e.g. from Unity JSON)
      const pkg2Json = JSON.stringify({
        meta: { durationMs: 120000 },
        telemetry: {
          timestamps: [5000, 6000, 7000],
          longitudes: [121.0, 121.1, 121.2],
          latitudes: [31.0, 31.1, 31.2],
          altitudes: [100.0, 105.0, 110.0],
        },
      });
      bridge.handleMessage({ type: 'LOAD_FLIGHT', payload: { flightJson: pkg2Json } });
      expect(mockViewer.loadFlight).toHaveBeenCalledTimes(2);
      expect(flightLoadedSpy).toHaveBeenCalledTimes(2);

      const loadedPkg = mockViewer.loadFlight.mock.calls[1][0];
      expect(loadedPkg.telemetry.timestamps).toBeInstanceOf(Float64Array);
      expect(loadedPkg.telemetry.longitudes).toBeInstanceOf(Float64Array);
      expect(loadedPkg.telemetry.altitudes).toBeInstanceOf(Float32Array);
    });

    it('should execute LOAD_WPML with direct route and stringified wpmlJson', () => {
      bridge = new FlightViewerBridge({ autoRegisterWindow: false });
      const mockViewer = {
        loadPlannedRoute: vi.fn(),
      };
      bridge.attachViewer(mockViewer as any);

      // Case 1: Direct object
      const route1 = {
        name: 'Route-1',
        waypoints: [{ index: 0, lon: 120.0, lat: 30.0, alt: 100.0 }],
      };
      bridge.handleMessage({ type: 'LOAD_WPML', payload: { route: route1 } });
      expect(mockViewer.loadPlannedRoute).toHaveBeenCalledTimes(1);

      // Case 2: Stringified wpmlJson
      const route2 = {
        name: 'Route-2',
        waypoints: [{ index: 0, lon: 121.0, lat: 31.0, alt: 120.0 }],
      };
      bridge.handleMessage({ type: 'LOAD_WPML', payload: { wpmlJson: JSON.stringify(route2) } });
      expect(mockViewer.loadPlannedRoute).toHaveBeenCalledTimes(2);
      expect(mockViewer.loadPlannedRoute).toHaveBeenLastCalledWith(route2);
    });

    it('should prevent message storms and self-loops when window.parent === window', () => {
      const originalWindow = globalThis.window;
      let postMessageCount = 0;
      let listener: any = null;

      const fakeWindow: any = {
        addEventListener: vi.fn((event, fn) => {
          listener = fn;
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn((data) => {
          postMessageCount++;
          if (listener && postMessageCount < 5) {
            listener({ data, origin: 'http://localhost' });
          }
        }),
      };
      fakeWindow.parent = fakeWindow; // Top-level window condition
      (globalThis as any).window = fakeWindow;

      try {
        bridge = new FlightViewerBridge({ autoRegisterWindow: true });
        bridge.init(); // emits READY

        // When parent === window, sendToHost must not post to parent
        expect(fakeWindow.postMessage).not.toHaveBeenCalled();

        // Even if an outbound event is received on handleMessage, it must not loop
        const handled = bridge.handleMessage({
          type: 'READY',
          payload: { version: '1.0.0' },
          source: 'dji-flight-log-viewer',
        });
        expect(handled).toBe(false);
      } finally {
        globalThis.window = originalWindow;
      }
    });
  });
});
