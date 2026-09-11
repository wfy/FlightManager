import { describe, it, expect, vi } from 'vitest';
import {
  extractBatterySeries,
  detectAbnormalCellVoltage,
  buildBatteryChartOptions,
  buildTelemetryChartOptions,
  syncChartTime,
} from '../../src/dashboard/telemetryCharts';
import { HUDInstruments } from '../../src/dashboard/hudInstruments';
import {
  EventTimeline,
  calculateTimelineProgress,
  findNearestTimelineEvent,
  type TimelineEventItem,
} from '../../src/dashboard/eventTimeline';
import { HUDDashboard } from '../../src/dashboard/hudDashboard';
import { createEmptyFlightPackage, type FlightRecordPackage } from '../../src/core/types';
import type { InterpolatedTelemetry } from '../../src/viewport/trajectoryLayer';

/**
 * Creates a mock HTMLCanvasElement and 2D rendering context for testing.
 */
function createMockCanvas(width = 480, height = 360): HTMLCanvasElement {
  const calls: { method: string; args: any[] }[] = [];

  const ctx: any = {
    canvas: null,
    save: vi.fn(() => calls.push({ method: 'save', args: [] })),
    restore: vi.fn(() => calls.push({ method: 'restore', args: [] })),
    scale: vi.fn((x, y) => calls.push({ method: 'scale', args: [x, y] })),
    translate: vi.fn((x, y) => calls.push({ method: 'translate', args: [x, y] })),
    rotate: vi.fn((rad) => calls.push({ method: 'rotate', args: [rad] })),
    clearRect: vi.fn((x, y, w, h) => calls.push({ method: 'clearRect', args: [x, y, w, h] })),
    fillRect: vi.fn((x, y, w, h) => calls.push({ method: 'fillRect', args: [x, y, w, h] })),
    strokeRect: vi.fn((x, y, w, h) => calls.push({ method: 'strokeRect', args: [x, y, w, h] })),
    beginPath: vi.fn(() => calls.push({ method: 'beginPath', args: [] })),
    closePath: vi.fn(() => calls.push({ method: 'closePath', args: [] })),
    moveTo: vi.fn((x, y) => calls.push({ method: 'moveTo', args: [x, y] })),
    lineTo: vi.fn((x, y) => calls.push({ method: 'lineTo', args: [x, y] })),
    arc: vi.fn((...args) => calls.push({ method: 'arc', args })),
    rect: vi.fn((...args) => calls.push({ method: 'rect', args })),
    fill: vi.fn(() => calls.push({ method: 'fill', args: [] })),
    stroke: vi.fn(() => calls.push({ method: 'stroke', args: [] })),
    clip: vi.fn(() => calls.push({ method: 'clip', args: [] })),
    fillText: vi.fn((text, x, y) => calls.push({ method: 'fillText', args: [text, x, y] })),
    setLineDash: vi.fn((dash) => calls.push({ method: 'setLineDash', args: [dash] })),
  };

  const canvas: any = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    getContext: vi.fn((type: string) => (type === '2d' ? ctx : null)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width, height })),
  };
  ctx.canvas = canvas;

  return canvas as unknown as HTMLCanvasElement;
}

function createSamplePackage(): FlightRecordPackage {
  const pkg = createEmptyFlightPackage();
  pkg.telemetry.timestamps = new Float64Array([1000, 2000, 3000, 4000, 5000]);
  pkg.telemetry.longitudes = new Float64Array([120.0, 120.001, 120.002, 120.003, 120.004]);
  pkg.telemetry.latitudes = new Float64Array([30.0, 30.001, 30.002, 30.003, 30.004]);
  pkg.telemetry.altitudes = new Float32Array([100, 105, 110, 115, 120]);
  pkg.telemetry.heights = new Float32Array([10, 15, 20, 25, 30]);
  pkg.telemetry.speeds = new Float32Array([0, 5.2, 12.4, 8.1, 0.5]);
  pkg.telemetry.pitch = new Float32Array([0, 5.0, -3.0, 2.5, 0]);
  pkg.telemetry.roll = new Float32Array([0, -10.0, 15.0, 5.0, 0]);
  pkg.telemetry.yaw = new Float32Array([0, 45.0, 90.0, 180.0, 270.0]);
  pkg.telemetry.rtkStatus = new Uint8Array([0, 1, 2, 2, 2]);
  pkg.telemetry.batteryPercents = new Uint8Array([95, 90, 85, 80, 75]);
  pkg.telemetry.batteryVoltages = new Float32Array([25.2, 24.8, 24.5, 24.1, 23.8]);
  pkg.telemetry.maxCellVoltageDiff = new Float32Array([0.02, 0.04, 0.08, 0.03, 0.06]);
  pkg.telemetry.maxCellTemp = new Float32Array([28, 30, 35, 36, 38]);
  pkg.telemetry.gimbalPitch = new Float32Array([0, -20, -45, -60, -90]);
  pkg.telemetry.gimbalYaw = new Float32Array([0, 45, 90, 180, 270]);

  pkg.events.photos.push({
    id: 'photo-1',
    timestamp: 2500,
    index: 0,
    position: [120.0015, 30.0015, 107.5],
    gimbalAngles: [-45, 0, 90],
  });

  pkg.events.warnings.push({
    timestamp: 3200,
    level: 'warning',
    code: 1002,
    message: 'Compass interference detected',
  });

  return pkg;
}

describe('Telemetry Dashboard Data Provider', () => {
  it('should detect abnormal cell voltage difference exceeding threshold', () => {
    const pkg = createEmptyFlightPackage();
    pkg.telemetry.timestamps = new Float64Array([0, 1, 2, 3]);
    pkg.telemetry.maxCellVoltageDiff = new Float32Array([0.02, 0.04, 0.08, 0.03]); // frame 2 exceeds 0.05V

    const anomalies = detectAbnormalCellVoltage(pkg.telemetry, 0.05);
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].timestamp).toBe(2);
    expect(anomalies[0].voltageDiff).toBeCloseTo(0.08, 2);
    expect(anomalies[0].index).toBe(2);
  });

  it('should handle empty or undefined telemetry streams safely', () => {
    const emptyPkg = createEmptyFlightPackage();
    const anomalies = detectAbnormalCellVoltage(emptyPkg.telemetry);
    expect(anomalies).toEqual([]);

    const series = extractBatterySeries(emptyPkg.telemetry);
    expect(series.timestamps.length).toBe(0);
    expect(series.anomalies.length).toBe(0);
    expect(series.stats.maxDiff).toBe(0);
  });

  it('should extract battery series and compute statistics accurately', () => {
    const pkg = createSamplePackage();
    const series = extractBatterySeries(pkg.telemetry, 0.05);

    expect(series.timestamps.length).toBe(5);
    expect(series.timeSeconds[0]).toBe(0);
    expect(series.timeSeconds[4]).toBeCloseTo(4.0, 1);
    expect(series.voltages).toEqual([25.2, 24.8, 24.5, 24.1, 23.8]);
    expect(series.percents).toEqual([95, 90, 85, 80, 75]);
    expect(series.maxCellDiffs).toEqual([0.02, 0.04, 0.08, 0.03, 0.06]);
    expect(series.temperatures).toEqual([28, 30, 35, 36, 38]);

    // Anomalies exceeding 0.05V should be at frame 2 (0.08V) and frame 4 (0.06V)
    expect(series.anomalies.length).toBe(2);
    expect(series.anomalies[0].index).toBe(2);
    expect(series.anomalies[1].index).toBe(4);

    expect(series.stats.maxDiff).toBeCloseTo(0.08, 2);
    expect(series.stats.minVoltage).toBeCloseTo(23.8, 1);
    expect(series.stats.maxVoltage).toBeCloseTo(25.2, 1);
    expect(series.stats.maxTemp).toBe(38);
    expect(series.stats.anomalyCount).toBe(2);
  });

  it('should build valid ECharts option for battery health', () => {
    const pkg = createSamplePackage();
    const options = buildBatteryChartOptions(pkg.telemetry, { thresholdVolts: 0.06 });

    expect(options.title.text).toContain('电池');
    expect(options.xAxis.data.length).toBe(5);
    expect(options.yAxis.length).toBe(2);
    expect(options.series.length).toBe(4);

    // Verify cell diff series has threshold markLine
    const cellDiffSeries = options.series.find((s: any) => s.name === '最大电芯压差 (V)');
    expect(cellDiffSeries).toBeDefined();
    expect(cellDiffSeries?.markLine?.data[0].yAxis).toBe(0.06);
  });

  it('should build synchronized multi-grid ECharts option for combined telemetry', () => {
    const pkg = createSamplePackage();
    const options = buildTelemetryChartOptions(pkg.telemetry, {
      type: 'combined',
      thresholdVolts: 0.05,
      showDataZoom: true,
    });

    expect(options.grid.length).toBe(2);
    expect(options.xAxis.length).toBe(2);
    expect(options.yAxis.length).toBe(4);
    expect(options.series.length).toBe(4);
    expect(options.axisPointer?.link?.[0].xAxisIndex).toBe('all');
    expect(options.dataZoom).toBeDefined();
  });

  it('should synchronize chart cursor safely without error', () => {
    const mockChart = {
      dispatchAction: vi.fn(),
    };

    const synced = syncChartTime(mockChart, 2.5);
    expect(synced).toBe(true);
    expect(mockChart.dispatchAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'showTip',
        seriesIndex: 0,
      })
    );

    // Null or invalid chart instance
    expect(syncChartTime(null, 1.0)).toBe(false);
    expect(syncChartTime(undefined, 1.0)).toBe(false);

    // Chart that throws inside dispatchAction
    const failingChart = {
      dispatchAction: vi.fn(() => {
        throw new Error('ECharts disposed');
      }),
    };
    expect(syncChartTime(failingChart, 1.0)).toBe(false);
  });
});

describe('HUDInstruments (Canvas-based Avionics PFD)', () => {
  it('should initialize and attach to canvas with HiDPI support', () => {
    const hud = new HUDInstruments({ theme: 'aviation-green' });
    const canvas = createMockCanvas(400, 300);

    hud.attach(canvas);
    expect(hud.getCanvas()).toBe(canvas);

    hud.resize(500, 400);
    expect(canvas.width).toBe(500);
    expect(canvas.height).toBe(400);
  });

  it('should render all HUD elements cleanly with telemetry frame', () => {
    const hud = new HUDInstruments();
    const canvas = createMockCanvas(480, 360);
    hud.attach(canvas);

    const telem: InterpolatedTelemetry = {
      timestamp: 3000,
      longitude: 120.002,
      latitude: 30.002,
      altitude: 110.5,
      height: 20.5,
      pitch: 12.0,
      roll: -8.0,
      yaw: 135.0,
      speed: 15.6,
      rtkStatus: 2, // Fixed
      batteryPercent: 82,
      batteryVoltage: 24.3,
      gimbalPitch: -45.0,
      gimbalYaw: 135.0,
      index: 2,
      factor: 0.5,
    };

    expect(() => hud.render(telem)).not.toThrow();
    expect(hud.getLastTelemetry()).toBe(telem);

    // Render with alternative RTK status and low battery
    const lowBatTelem: InterpolatedTelemetry = {
      ...telem,
      rtkStatus: 1, // Float
      batteryPercent: 12,
      batteryVoltage: 21.0,
    };
    expect(() => hud.render(lowBatTelem)).not.toThrow();

    // Render with RTK None and height source
    const hudHeights = new HUDInstruments({ altitudeSource: 'heights' });
    hudHeights.attach(canvas);
    const noneRtkTelem: InterpolatedTelemetry = {
      ...telem,
      rtkStatus: 0,
      batteryPercent: 25,
    };
    expect(() => hudHeights.render(noneRtkTelem)).not.toThrow();
  });

  it('should handle null telemetry in standby mode', () => {
    const hud = new HUDInstruments();
    const canvas = createMockCanvas(400, 300);
    hud.attach(canvas);

    expect(() => hud.render(null)).not.toThrow();
    expect(hud.getLastTelemetry()).toBeNull();
  });

  it('should clean up resources on destroy', () => {
    const hud = new HUDInstruments();
    const canvas = createMockCanvas(400, 300);
    hud.attach(canvas);
    expect(hud.getCanvas()).not.toBeNull();

    hud.destroy();
    expect(hud.getCanvas()).toBeNull();
    expect(hud.getLastTelemetry()).toBeNull();
  });
});

describe('EventTimeline & Playback Scrubber', () => {
  it('should compute timeline progress correctly', () => {
    expect(calculateTimelineProgress(1500, 1000, 1000)).toBeCloseTo(0.5, 2);
    expect(calculateTimelineProgress(1000, 1000, 1000)).toBe(0);
    expect(calculateTimelineProgress(2000, 1000, 1000)).toBe(1);
    expect(calculateTimelineProgress(2500, 1000, 1000)).toBe(1);
    expect(calculateTimelineProgress(500, 1000, 1000)).toBe(0);
    expect(calculateTimelineProgress(1000, 1000, 0)).toBe(0);
  });

  it('should load package and compile photo, warning, and anomaly markers', () => {
    const pkg = createSamplePackage();
    const anomalies = detectAbnormalCellVoltage(pkg.telemetry, 0.05);

    const timeline = new EventTimeline();
    timeline.loadPackage(pkg, anomalies);

    const events = timeline.getEvents();
    expect(events.length).toBe(4); // 1 photo + 1 warning + 2 anomalies

    const photoEvent = events.find((e) => e.type === 'photo');
    expect(photoEvent).toBeDefined();
    expect(photoEvent?.timeSec).toBeCloseTo(1.5, 1);

    const warningEvent = events.find((e) => e.type === 'warning');
    expect(warningEvent).toBeDefined();
    expect(warningEvent?.timeSec).toBeCloseTo(2.2, 1);

    const anomalyEvents = events.filter((e) => e.type === 'anomaly');
    expect(anomalyEvents.length).toBe(2);
  });

  it('should find nearest timeline event within tolerance window', () => {
    const items: TimelineEventItem[] = [
      { id: '1', type: 'photo', timestamp: 1000, timeSec: 1.0, label: 'P1', photo: {} as any },
      { id: '2', type: 'warning', timestamp: 5000, timeSec: 5.0, label: 'W1', warning: {} as any, level: 'warning' },
    ];

    expect(findNearestTimelineEvent(items, 1.2, 0.5)?.id).toBe('1');
    expect(findNearestTimelineEvent(items, 4.8, 0.5)?.id).toBe('2');
    expect(findNearestTimelineEvent(items, 3.0, 0.5)).toBeNull();
  });

  it('should trigger seek listeners and event select callbacks', () => {
    const pkg = createSamplePackage();
    const timeline = new EventTimeline();
    timeline.loadPackage(pkg);

    let seekedTime = -1;
    const unsubSeek = timeline.onSeek((t) => {
      seekedTime = t;
    });

    timeline.setTime(3.5);
    expect(timeline.getTime()).toBe(3.5);

    unsubSeek();
    timeline.destroy();
  });
});

describe('HUDDashboard Unified Coordinator', () => {
  it('should load flight package and coordinate HUD, ECharts, and Timeline', () => {
    const dashboard = new HUDDashboard();
    const pkg = createSamplePackage();

    const canvas = createMockCanvas(480, 360);
    dashboard.attachHUD(canvas);

    const mockChart = {
      setOption: vi.fn(),
      dispatchAction: vi.fn(),
    };
    dashboard.attachChart(mockChart);

    dashboard.loadPackage(pkg);
    expect(mockChart.setOption).toHaveBeenCalled();
    expect(dashboard.getDuration()).toBeCloseTo(4.0, 1);
    expect(dashboard.getAnomalies().length).toBe(2);

    // Render by frame index
    dashboard.renderFrame(2);
    expect(dashboard.getCurrentTime()).toBeCloseTo(2.0, 1);

    // Render by fractional time seconds
    dashboard.renderFrame(3.5);
    expect(dashboard.getCurrentTime()).toBeCloseTo(3.5, 1);

    // Sync charts
    dashboard.syncCharts(3.5);
    expect(mockChart.dispatchAction).toHaveBeenCalled();

    // Event clicked listener
    let selectedEvent: any = null;
    const unsub = dashboard.onEventClicked((ev) => {
      selectedEvent = ev;
    });
    expect(typeof unsub).toBe('function');

    // Clean destruction
    dashboard.destroy();
    expect(dashboard.getCurrentTime()).toBe(0);
  });
});
