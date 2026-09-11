/**
 * Interactive Event Timeline & Playback Scrubber
 *
 * Provides timeline visualization and event scrubbing for:
 * 1. Photo snapshot events (thumbnail / index / coordinates)
 * 2. System and flight safety warnings (info / warning / critical)
 * 3. Battery cell voltage difference and thermal anomalies
 * 4. Interactive pointer scrubbing and seek callbacks
 */

import type { FlightRecordPackage, PhotoEvent, WarningEvent } from '../core/types';
import type { CellVoltageAnomaly } from './telemetryCharts';

export type TimelineEventType = 'photo' | 'warning' | 'anomaly';

export interface BaseTimelineItem {
  id: string;
  type: TimelineEventType;
  timestamp: number;      // Epoch ms
  timeSec: number;        // Relative seconds from flight start
  label: string;
  details?: Record<string, unknown>;
}

export interface TimelinePhotoItem extends BaseTimelineItem {
  type: 'photo';
  photo: PhotoEvent;
}

export interface TimelineWarningItem extends BaseTimelineItem {
  type: 'warning';
  warning: WarningEvent;
  level: 'info' | 'warning' | 'critical';
}

export interface TimelineAnomalyItem extends BaseTimelineItem {
  type: 'anomaly';
  anomaly: CellVoltageAnomaly;
}

export type TimelineEventItem = TimelinePhotoItem | TimelineWarningItem | TimelineAnomalyItem;

export interface EventTimelineOptions {
  container?: HTMLElement | null;
  height?: number;
  showPhotoMarkers?: boolean;
  showWarningMarkers?: boolean;
  showAnomalyMarkers?: boolean;
  primaryColor?: string;
  cursorColor?: string;
}

/**
 * Calculates normalized progress percentage (0.0 to 1.0) given timestamp.
 */
export function calculateTimelineProgress(
  timestampMs: number,
  startTimeMs: number,
  durationMs: number
): number {
  if (durationMs <= 0) return 0;
  const progress = (timestampMs - startTimeMs) / durationMs;
  return Math.min(1, Math.max(0, progress));
}

/**
 * Finds nearest timeline event to a given playback time in seconds.
 */
export function findNearestTimelineEvent(
  events: TimelineEventItem[],
  timeSec: number,
  toleranceSec = 2.0
): TimelineEventItem | null {
  if (!events || events.length === 0) return null;

  let bestItem: TimelineEventItem | null = null;
  let minDiff = Infinity;

  for (const item of events) {
    const diff = Math.abs(item.timeSec - timeSec);
    if (diff <= toleranceSec && diff < minDiff) {
      minDiff = diff;
      bestItem = item;
    }
  }

  return bestItem;
}

/**
 * Interactive Timeline Controller.
 */
export class EventTimeline {
  private startTimeMs = 0;
  private durationMs = 0;
  private durationSec = 0;
  private currentTimeSec = 0;

  private events: TimelineEventItem[] = [];
  private seekListeners: ((timeSec: number) => void)[] = [];
  private eventSelectListeners: ((event: TimelineEventItem) => void)[] = [];

  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private options: Required<EventTimelineOptions>;

  private isDragging = false;
  private boundPointerDown: ((e: MouseEvent | TouchEvent) => void) | null = null;
  private boundPointerMove: ((e: MouseEvent | TouchEvent) => void) | null = null;
  private boundPointerUp: (() => void) | null = null;

  constructor(options: EventTimelineOptions = {}) {
    this.options = {
      container: options.container ?? null,
      height: options.height ?? 40,
      showPhotoMarkers: options.showPhotoMarkers ?? true,
      showWarningMarkers: options.showWarningMarkers ?? true,
      showAnomalyMarkers: options.showAnomalyMarkers ?? true,
      primaryColor: options.primaryColor ?? '#00E5FF',
      cursorColor: options.cursorColor ?? '#FF1744',
    };

    if (options.container) {
      this.attach(options.container);
    }
  }

  /**
   * Loads flight record package and compiles all event streams.
   */
  public loadPackage(pkg: FlightRecordPackage, anomalies: CellVoltageAnomaly[] = []): void {
    const ts = pkg.telemetry?.timestamps;
    const count = ts ? ts.length : 0;

    if (count > 0) {
      this.startTimeMs = ts[0];
      const endTs = ts[count - 1];
      this.durationMs = Math.max(0, endTs - this.startTimeMs);
      this.durationSec = this.durationMs / 1000;
    } else {
      this.startTimeMs = pkg.meta?.startTime || 0;
      this.durationMs = pkg.meta?.durationMs || 0;
      this.durationSec = this.durationMs / 1000;
    }

    this.currentTimeSec = 0;
    this.compileEvents(pkg, anomalies);
    this.render();
  }

  /**
   * Compiles and sorts timeline items from photos, warnings, and battery anomalies.
   */
  private compileEvents(pkg: FlightRecordPackage, anomalies: CellVoltageAnomaly[]): void {
    this.events = [];
    const t0 = this.startTimeMs;

    // 1. Photos
    if (pkg.events?.photos && this.options.showPhotoMarkers) {
      for (const p of pkg.events.photos) {
        const timeSec = Number.isFinite(p.timestamp) ? (p.timestamp - t0) / 1000 : 0;
        this.events.push({
          id: p.id || `photo-${p.index}`,
          type: 'photo',
          timestamp: p.timestamp,
          timeSec: Math.max(0, timeSec),
          label: `Photo #${p.index + 1}`,
          photo: p,
        });
      }
    }

    // 2. Warnings
    if (pkg.events?.warnings && this.options.showWarningMarkers) {
      for (let i = 0; i < pkg.events.warnings.length; i++) {
        const w = pkg.events.warnings[i];
        const timeSec = Number.isFinite(w.timestamp) ? (w.timestamp - t0) / 1000 : 0;
        this.events.push({
          id: `warning-${i}-${w.code}`,
          type: 'warning',
          timestamp: w.timestamp,
          timeSec: Math.max(0, timeSec),
          label: `[${w.level.toUpperCase()}] ${w.message}`,
          warning: w,
          level: w.level,
        });
      }
    }

    // 3. Battery Cell Anomalies
    if (anomalies && this.options.showAnomalyMarkers) {
      for (const a of anomalies) {
        this.events.push({
          id: `anomaly-${a.index}`,
          type: 'anomaly',
          timestamp: a.timestamp,
          timeSec: Math.max(0, a.timeSec),
          label: `Cell Diff ${(a.voltageDiff * 1000).toFixed(0)}mV > ${(a.threshold * 1000).toFixed(0)}mV`,
          anomaly: a,
        });
      }
    }

    // Sort chronologically
    this.events.sort((a, b) => a.timeSec - b.timeSec);
  }

  /**
   * Attaches interactive canvas scrubber to DOM container.
   */
  public attach(container: HTMLElement): void {
    if (this.canvas) {
      this.destroy();
    }
    this.container = container;

    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.className = 'flight-event-timeline-canvas';
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = `${this.options.height}px`;
      canvas.style.cursor = 'pointer';

      container.appendChild(canvas);
      this.canvas = canvas;
      this.ctx = canvas.getContext ? canvas.getContext('2d') : null;

      this.setupEventListeners();
    }
  }

  /**
   * Sets current playback time in seconds and re-renders cursor.
   */
  public setTime(timeSec: number): void {
    this.currentTimeSec = Math.max(0, Math.min(this.durationSec, timeSec));
    this.render();
  }

  /**
   * Returns current playback time in seconds.
   */
  public getTime(): number {
    return this.currentTimeSec;
  }

  /**
   * Returns compiled timeline events.
   */
  public getEvents(): TimelineEventItem[] {
    return this.events;
  }

  /**
   * Subscribes to interactive seek events.
   */
  public onSeek(callback: (timeSec: number) => void): () => void {
    this.seekListeners.push(callback);
    return () => {
      this.seekListeners = this.seekListeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * Subscribes to timeline event clicks (photo, warning, anomaly).
   */
  public onEventSelect(callback: (event: TimelineEventItem) => void): () => void {
    this.eventSelectListeners.push(callback);
    return () => {
      this.eventSelectListeners = this.eventSelectListeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * Dispatches seek to all listeners.
   */
  private triggerSeek(timeSec: number): void {
    this.setTime(timeSec);
    for (const listener of this.seekListeners) {
      listener(this.currentTimeSec);
    }

    // Check if clicked near an event marker
    const nearest = findNearestTimelineEvent(this.events, this.currentTimeSec, 1.5);
    if (nearest) {
      for (const cb of this.eventSelectListeners) {
        cb(nearest);
      }
    }
  }

  /**
   * Renders timeline track, event markers, and cursor thumb.
   */
  public render(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const width = canvas.clientWidth > 0 ? canvas.clientWidth : 600;
    const height = canvas.clientHeight > 0 ? canvas.clientHeight : this.options.height;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Track parameters
    const trackY = height * 0.55;
    const trackH = 8;
    const trackPadding = 16;
    const usableW = width - trackPadding * 2;

    // Background track
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.roundRect
      ? ctx.roundRect(trackPadding, trackY - trackH / 2, usableW, trackH, 4)
      : ctx.rect(trackPadding, trackY - trackH / 2, usableW, trackH);
    ctx.fill();

    // Played track fill
    const progress = this.durationSec > 0 ? this.currentTimeSec / this.durationSec : 0;
    const playedW = usableW * progress;

    if (playedW > 0) {
      ctx.fillStyle = this.options.primaryColor;
      ctx.beginPath();
      ctx.roundRect
        ? ctx.roundRect(trackPadding, trackY - trackH / 2, playedW, trackH, 4)
        : ctx.rect(trackPadding, trackY - trackH / 2, playedW, trackH);
      ctx.fill();
    }

    // Render Event Markers
    if (this.durationSec > 0) {
      for (const item of this.events) {
        const itemProg = Math.min(1, Math.max(0, item.timeSec / this.durationSec));
        const mx = trackPadding + usableW * itemProg;

        if (item.type === 'photo') {
          // Photo marker: cyan circle at top of track
          ctx.fillStyle = '#00E5FF';
          ctx.beginPath();
          ctx.arc(mx, trackY - 9, 3.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (item.type === 'warning') {
          // Warning marker: diamond below or above track
          const color =
            item.level === 'critical' ? '#FF1744' : item.level === 'warning' ? '#FF9100' : '#2979FF';
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(mx, trackY - 14);
          ctx.lineTo(mx + 4, trackY - 10);
          ctx.lineTo(mx, trackY - 6);
          ctx.lineTo(mx - 4, trackY - 10);
          ctx.closePath();
          ctx.fill();
        } else if (item.type === 'anomaly') {
          // Anomaly marker: violet vertical tick
          ctx.strokeStyle = '#E040FB';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(mx, trackY - trackH / 2 - 2);
          ctx.lineTo(mx, trackY + trackH / 2 + 2);
          ctx.stroke();
        }
      }
    }

    // Scrubber Cursor Head
    const cursorX = trackPadding + playedW;
    ctx.strokeStyle = this.options.cursorColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, 2);
    ctx.lineTo(cursorX, height - 2);
    ctx.stroke();

    // Cursor Thumb
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cursorX, trackY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = this.options.primaryColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Time Readout labels
    ctx.fillStyle = '#90A4AE';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${this.formatTime(this.currentTimeSec)}`, trackPadding, 12);
    ctx.textAlign = 'right';
    ctx.fillText(`${this.formatTime(this.durationSec)}`, width - trackPadding, 12);

    ctx.restore();
  }

  private formatTime(seconds: number): string {
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  private setupEventListeners(): void {
    if (!this.canvas) return;

    const getTimeFromEvent = (e: MouseEvent | TouchEvent): number => {
      if (!this.canvas) return 0;
      const rect = this.canvas.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const trackPadding = 16;
      const x = clientX - rect.left - trackPadding;
      const usableW = rect.width - trackPadding * 2;
      const ratio = Math.max(0, Math.min(1, x / usableW));
      return ratio * this.durationSec;
    };

    this.boundPointerDown = (e: MouseEvent | TouchEvent) => {
      this.isDragging = true;
      const t = getTimeFromEvent(e);
      this.triggerSeek(t);
    };

    this.boundPointerMove = (e: MouseEvent | TouchEvent) => {
      if (!this.isDragging) return;
      const t = getTimeFromEvent(e);
      this.triggerSeek(t);
    };

    this.boundPointerUp = () => {
      this.isDragging = false;
    };

    this.canvas.addEventListener('mousedown', this.boundPointerDown);
    this.canvas.addEventListener('touchstart', this.boundPointerDown, { passive: true });

    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', this.boundPointerMove);
      window.addEventListener('touchmove', this.boundPointerMove, { passive: true });
      window.addEventListener('mouseup', this.boundPointerUp);
      window.addEventListener('touchend', this.boundPointerUp);
    }
  }

  /**
   * Destroys timeline element and event listeners.
   */
  public destroy(): void {
    if (this.canvas && this.boundPointerDown) {
      this.canvas.removeEventListener('mousedown', this.boundPointerDown);
      this.canvas.removeEventListener('touchstart', this.boundPointerDown);
    }

    if (typeof window !== 'undefined') {
      if (this.boundPointerMove) {
        window.removeEventListener('mousemove', this.boundPointerMove);
        window.removeEventListener('touchmove', this.boundPointerMove);
      }
      if (this.boundPointerUp) {
        window.removeEventListener('mouseup', this.boundPointerUp);
        window.removeEventListener('touchend', this.boundPointerUp);
      }
    }

    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }

    this.canvas = null;
    this.ctx = null;
    this.container = null;
    this.events = [];
    this.seekListeners = [];
    this.eventSelectListeners = [];
  }
}
