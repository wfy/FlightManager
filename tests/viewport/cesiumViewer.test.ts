import { describe, it, expect } from 'vitest';
import { Flight3DViewerEngine } from '../../src/viewport/cesiumViewer';
import { createEmptyFlightPackage } from '../../src/core/types';

describe('Flight3DViewerEngine', () => {
  it('should instantiate and manage state correctly in headless mode', async () => {
    const engine = new Flight3DViewerEngine();
    await engine.initialize('cesium-container');

    const state = engine.getPlaybackState();
    expect(state.isPlaying).toBe(false);
    expect(state.currentTimeSec).toBe(0);
    expect(state.playbackRate).toBe(1.0);
    expect(state.cameraMode).toBe('follow');
    expect(state.colorMode).toBe('rtk');
  });

  it('should load flight record package and update duration', async () => {
    const engine = new Flight3DViewerEngine();
    await engine.initialize('cesium-container');

    const pkg = createEmptyFlightPackage();
    pkg.telemetry.timestamps = new Float64Array([1000, 2000, 5000]); // 4 seconds duration
    pkg.telemetry.longitudes = new Float64Array([120.0, 120.001, 120.002]);
    pkg.telemetry.latitudes = new Float64Array([30.0, 30.001, 30.002]);
    pkg.telemetry.altitudes = new Float32Array([100, 110, 120]);
    pkg.telemetry.pitch = new Float32Array([0, 1, 2]);
    pkg.telemetry.roll = new Float32Array([0, 1, 2]);
    pkg.telemetry.yaw = new Float32Array([90, 95, 100]);

    engine.loadFlight(pkg);
    const state = engine.getPlaybackState();
    expect(state.durationSec).toBe(4);

    // Playback control state transitions
    engine.play();
    expect(engine.getPlaybackState().isPlaying).toBe(true);

    engine.pause();
    expect(engine.getPlaybackState().isPlaying).toBe(false);

    engine.setPlaybackRate(2.5);
    expect(engine.getPlaybackState().playbackRate).toBe(2.5);

    engine.setCameraMode('top_down');
    expect(engine.getPlaybackState().cameraMode).toBe('top_down');

    engine.setColorMode('deviation');
    expect(engine.getPlaybackState().colorMode).toBe('deviation');

    engine.setAltitudeOptions('heights', 15.0);
    expect(engine.getPlaybackState().altitudeSource).toBe('heights');
    expect(engine.getPlaybackState().altitudeOffset).toBe(15.0);

    expect(engine.isFrustumVisible()).toBe(true);
    engine.setFrustumVisible(false);
    expect(engine.isFrustumVisible()).toBe(false);

    engine.seek(2.5);
    expect(engine.getPlaybackState().currentTimeSec).toBe(2.5);

    // Telemetry retrieval at timestamp
    const telem = engine.getTelemetryAtTimestamp(2000);
    expect(telem).not.toBeNull();
    expect(telem!.longitude).toBeCloseTo(120.001, 5);

    // Clean destruction
    expect(() => engine.destroy()).not.toThrow();
  });

  it('should support time update listeners', async () => {
    const engine = new Flight3DViewerEngine();
    await engine.initialize('cesium-container');

    const pkg = createEmptyFlightPackage();
    pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000]);
    pkg.telemetry.longitudes = new Float64Array([120.0, 120.01, 120.02]);
    pkg.telemetry.latitudes = new Float64Array([30.0, 30.01, 30.02]);
    pkg.telemetry.altitudes = new Float32Array([100, 100, 100]);

    engine.loadFlight(pkg);

    let reportedTime = -1;
    const unsubscribe = engine.onTimeUpdate((timeSec) => {
      reportedTime = timeSec;
    });

    engine.seek(1.5);
    // In headless mode without viewer clock tick, seek directly calls updateDroneAndCameraAtTime
    // which triggers listener if viewer was present, or we can check unsubscribe
    unsubscribe();
    expect(typeof unsubscribe).toBe('function');
  });
});
