/**
 * HUD & Telemetry Dashboard Unified Coordinator
 *
 * Orchestrates:
 * 1. HUD avionics display (HUDInstruments)
 * 2. Multi-axis ECharts telemetry synchronization
 * 3. Interactive event timeline and seek scrubber (EventTimeline)
 */

import type { FlightRecordPackage } from '../core/types';
import { HUDInstruments, type HUDOptions } from './hudInstruments';
import { EventTimeline, type TimelineEventItem, type EventTimelineOptions } from './eventTimeline';
import {
  detectAbnormalCellVoltage,
  syncChartTime,
  buildTelemetryChartOptions,
  type CellVoltageAnomaly,
  type TelemetryChartConfig,
} from './telemetryCharts';
import {
  interpolateTelemetryAtTime,
  type InterpolatedTelemetry,
} from '../viewport/trajectoryLayer';

export interface HUDDashboardOptions {
  hudOptions?: HUDOptions;
  timelineOptions?: EventTimelineOptions;
  chartConfig?: TelemetryChartConfig;
  thresholdVolts?: number;
}

export class HUDDashboard {
  private pkg: FlightRecordPackage | null = null;
  private hud: HUDInstruments;
  private timeline: EventTimeline;
  private chartInstance: any = null;
  private anomalies: CellVoltageAnomaly[] = [];
  private options: HUDDashboardOptions;

  private startTimeMs = 0;
  private durationSec = 0;
  private currentFrameIndex = 0;
  private currentTimeSec = 0;

  constructor(options: HUDDashboardOptions = {}) {
    this.options = options;
    this.hud = new HUDInstruments(options.hudOptions);
    this.timeline = new EventTimeline(options.timelineOptions);
  }

  /**
   * Loads flight record package and binds telemetry to HUD and timeline.
   */
  public loadPackage(pkg: FlightRecordPackage): void {
    this.pkg = pkg;
    const threshold = this.options.thresholdVolts ?? 0.05;
    this.anomalies = detectAbnormalCellVoltage(pkg.telemetry, threshold);

    const ts = pkg.telemetry?.timestamps;
    const count = ts ? ts.length : 0;
    if (count > 0) {
      this.startTimeMs = ts[0];
      const endTs = ts[count - 1];
      this.durationSec = Math.max(0, (endTs - this.startTimeMs) / 1000);
    } else {
      this.startTimeMs = pkg.meta?.startTime || 0;
      this.durationSec = (pkg.meta?.durationMs || 0) / 1000;
    }

    this.timeline.loadPackage(pkg, this.anomalies);
    if (this.chartInstance && typeof this.chartInstance.setOption === 'function') {
      const options = buildTelemetryChartOptions(pkg.telemetry, this.options.chartConfig);
      this.chartInstance.setOption(options);
    }
    this.renderFrame(0);
  }

  /**
   * Attaches HUD canvas element.
   */
  public attachHUD(canvas: HTMLCanvasElement): void {
    this.hud.attach(canvas);
    this.renderFrame(this.currentTimeSec);
  }

  /**
   * Attaches timeline DOM container element.
   */
  public attachTimeline(container: HTMLElement): void {
    this.timeline.attach(container);
  }

  /**
   * Attaches ECharts instance for automatic cursor synchronization.
   */
  public attachChart(chartInstance: any): void {
    this.chartInstance = chartInstance;
    if (this.pkg) {
      const options = buildTelemetryChartOptions(this.pkg.telemetry, this.options.chartConfig);
      if (chartInstance && typeof chartInstance.setOption === 'function') {
        chartInstance.setOption(options);
      }
    }
  }

  /**
   * Renders HUD frame at a given frame index or relative time in seconds.
   */
  public renderFrame(indexOrTime: number): void {
    if (!this.pkg || !this.pkg.telemetry || this.pkg.telemetry.timestamps.length === 0) {
      this.hud.render(null);
      return;
    }

    const count = this.pkg.telemetry.timestamps.length;
    let targetTimeMs: number;
    let timeSec: number;

    // Check if input is a fractional timestamp/second or an integer index
    if (indexOrTime >= 0 && indexOrTime < count && Number.isInteger(indexOrTime)) {
      this.currentFrameIndex = indexOrTime;
      targetTimeMs = this.pkg.telemetry.timestamps[indexOrTime];
      timeSec = (targetTimeMs - this.startTimeMs) / 1000;
    } else {
      timeSec = Math.max(0, Math.min(this.durationSec, indexOrTime));
      targetTimeMs = this.startTimeMs + timeSec * 1000;
    }

    this.currentTimeSec = Math.max(0, timeSec);
    const interpolated = interpolateTelemetryAtTime(this.pkg.telemetry, targetTimeMs);

    this.hud.render(interpolated);
    this.timeline.setTime(this.currentTimeSec);
  }

  /**
   * Synchronizes ECharts timeline cursor to current playback time in seconds.
   */
  public syncCharts(currentTime: number, dataIndex?: number): void {
    if (this.chartInstance) {
      syncChartTime(this.chartInstance, currentTime, dataIndex);
    }
  }

  /**
   * Registers a callback triggered when user clicks an event on the timeline.
   */
  public onEventClicked(callback: (event: TimelineEventItem) => void): () => void {
    return this.timeline.onEventSelect(callback);
  }

  /**
   * Registers a callback triggered when user seeks on the timeline.
   */
  public onSeek(callback: (timeSec: number) => void): () => void {
    return this.timeline.onSeek((timeSec) => {
      this.renderFrame(timeSec);
      this.syncCharts(timeSec);
      callback(timeSec);
    });
  }

  public getHUD(): HUDInstruments {
    return this.hud;
  }

  public getTimeline(): EventTimeline {
    return this.timeline;
  }

  public getAnomalies(): CellVoltageAnomaly[] {
    return this.anomalies;
  }

  public getCurrentTime(): number {
    return this.currentTimeSec;
  }

  public getDuration(): number {
    return this.durationSec;
  }

  /**
   * Destroys all attached components and event listeners.
   */
  public destroy(): void {
    this.hud.destroy();
    this.timeline.destroy();
    this.chartInstance = null;
    this.pkg = null;
    this.anomalies = [];
    this.currentTimeSec = 0;
    this.currentFrameIndex = 0;
    this.durationSec = 0;
  }
}
