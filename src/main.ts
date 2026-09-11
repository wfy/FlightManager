/**
 * DJI Flight Log 3D Viewer - Main Entrypoint & UI Coordinator
 *
 * 100% Offline, zero-network architecture:
 * - Local CesiumJS 4D spatiotemporal engine
 * - Real-time avionics HUD overlay
 * - Dual battery and dynamics telemetry synchronization
 * - Bi-directional Host/Unity bridge adapter
 */

import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';

import type { FlightRecordPackage, DeviationResult, WPMLRoute } from './core/types';
import { parseDjiFlightLog, buildMockDjiBinaryBuffer } from './parser/djiParser';
import { parseWPMLRoute } from './parser/wpmlParser';
import { calculateTrajectoryDeviation } from './spatial/deviationSolver';
import { Flight3DViewerEngine, type CameraMode } from './viewport/cesiumViewer';
import type { ColorMode, InterpolatedTelemetry } from './viewport/trajectoryLayer';
import { HUDDashboard } from './dashboard/hudDashboard';
import { FlightViewerBridge } from './bridge/flightViewerBridge';
import { extractBatterySeries } from './dashboard/telemetryCharts';

class FlightViewerApp {
  private viewer: Flight3DViewerEngine;
  private dashboard: HUDDashboard;
  private bridge: FlightViewerBridge;

  private currentPackage: FlightRecordPackage | null = null;
  private currentRoute: WPMLRoute | null = null;
  private currentDeviation: DeviationResult | null = null;
  private isPlaying = false;
  private altSource: 'altitudes' | 'heights' = 'altitudes';
  private currentTimeSec = 0;
  private durationSec = 0;

  // DOM Elements Cache
  private btnPlayPause!: HTMLButtonElement;
  private timeCurrent!: HTMLElement;
  private timeTotal!: HTMLElement;
  private selectCameraMode!: HTMLSelectElement;
  private selectColorMode!: HTMLSelectElement;
  private btnToggleFrustum!: HTMLButtonElement;
  private btnFlyTo!: HTMLButtonElement;
  private btnAltSource!: HTMLButtonElement;
  private telemetryDrawer!: HTMLElement;
  private btnToggleDrawer!: HTMLButtonElement;
  private btnCloseDrawer!: HTMLButtonElement;

  // Metadata Chips
  private valModel!: HTMLElement;
  private valDuration!: HTMLElement;
  private valDistance!: HTMLElement;
  private valMaxAlt!: HTMLElement;
  private valRtk!: HTMLElement;
  private valBatteryDiff!: HTMLElement;

  // Drawer Stat Elements
  private statMaxDiff!: HTMLElement;
  private statVoltageRange!: HTMLElement;
  private statMaxTemp!: HTMLElement;
  private statMaxDeviation!: HTMLElement;
  private eventsListContainer!: HTMLElement;
  private chartCursorTime!: HTMLElement;

  // Canvas Charts
  private batteryCanvas!: HTMLCanvasElement;
  private dynamicsCanvas!: HTMLCanvasElement;
  private batteryCtx: CanvasRenderingContext2D | null = null;
  private dynamicsCtx: CanvasRenderingContext2D | null = null;

  constructor() {
    this.viewer = new Flight3DViewerEngine();
    this.dashboard = new HUDDashboard({
      hudOptions: {
        theme: 'cyan',
        reticleColor: '#00e5ff',
        horizonColor: '#00ff66',
        skyGroundShading: true,
      },
    });
    this.bridge = new FlightViewerBridge({ viewer: this.viewer });
  }

  public async initialize(): Promise<void> {
    this.cacheDomElements();
    this.setupEventListeners();
    this.setupDragAndDrop();

    // 1. Initialize Cesium Viewport (100% offline, zero token)
    await this.viewer.initialize('cesiumContainer', {
      showGrid: true,
      showFrustum: true,
      defaultColorMode: 'rtk',
    });

    // 2. Attach HUD and Timeline
    const hudCanvas = document.getElementById('hudCanvas') as HTMLCanvasElement;
    if (hudCanvas) {
      this.dashboard.attachHUD(hudCanvas);
    }

    const timelineContainer = document.getElementById('timelineContainer') as HTMLElement;
    if (timelineContainer) {
      this.dashboard.attachTimeline(timelineContainer);
    }

    // 3. Connect Telemetry Canvas Charts into Dashboard
    this.setupCanvasCharts();

    // 4. Bind Bi-directional Viewport & Dashboard Time Events
    this.viewer.onTimeUpdate((timeSec, telemetry) => {
      this.currentTimeSec = timeSec;
      this.updateTimeDisplay(timeSec, this.durationSec);
      this.dashboard.renderFrame(timeSec);
      this.dashboard.syncCharts(timeSec);
      this.renderChartsCursor(timeSec);
      if (telemetry) {
        this.updateLiveTelemetryReadout(telemetry);
      }
    });

    this.dashboard.onSeek((timeSec) => {
      this.viewer.seek(timeSec);
    });

    this.dashboard.onEventClicked((evt) => {
      this.viewer.seek(evt.timeSec);
    });

    // 5. Connect Bridge Commands & Outbound Events
    this.setupBridgeHandlers();

    // 6. Automatically Load Built-in Demo Flight for Immediate Interactivity
    this.loadDemoFlight();
  }

  private cacheDomElements(): void {
    this.btnPlayPause = document.getElementById('btnPlayPause') as HTMLButtonElement;
    this.timeCurrent = document.getElementById('timeCurrent') as HTMLElement;
    this.timeTotal = document.getElementById('timeTotal') as HTMLElement;
    this.selectCameraMode = document.getElementById('selectCameraMode') as HTMLSelectElement;
    this.selectColorMode = document.getElementById('selectColorMode') as HTMLSelectElement;
    this.btnToggleFrustum = document.getElementById('btnToggleFrustum') as HTMLButtonElement;
    this.btnFlyTo = document.getElementById('btnFlyTo') as HTMLButtonElement;
    this.btnAltSource = document.getElementById('btnAltSource') as HTMLButtonElement;
    this.telemetryDrawer = document.getElementById('telemetryDrawer') as HTMLElement;
    this.btnToggleDrawer = document.getElementById('btnToggleDrawer') as HTMLButtonElement;
    this.btnCloseDrawer = document.getElementById('btnCloseDrawer') as HTMLButtonElement;

    this.valModel = document.getElementById('valModel') as HTMLElement;
    this.valDuration = document.getElementById('valDuration') as HTMLElement;
    this.valDistance = document.getElementById('valDistance') as HTMLElement;
    this.valMaxAlt = document.getElementById('valMaxAlt') as HTMLElement;
    this.valRtk = document.getElementById('valRtk') as HTMLElement;
    this.valBatteryDiff = document.getElementById('valBatteryDiff') as HTMLElement;

    this.statMaxDiff = document.getElementById('statMaxDiff') as HTMLElement;
    this.statVoltageRange = document.getElementById('statVoltageRange') as HTMLElement;
    this.statMaxTemp = document.getElementById('statMaxTemp') as HTMLElement;
    this.statMaxDeviation = document.getElementById('statMaxDeviation') as HTMLElement;
    this.eventsListContainer = document.getElementById('eventsListContainer') as HTMLElement;
    this.chartCursorTime = document.getElementById('chartCursorTime') as HTMLElement;

    this.batteryCanvas = document.getElementById('batteryChartCanvas') as HTMLCanvasElement;
    this.dynamicsCanvas = document.getElementById('dynamicsChartCanvas') as HTMLCanvasElement;

    if (this.batteryCanvas) this.batteryCtx = this.batteryCanvas.getContext('2d');
    if (this.dynamicsCanvas) this.dynamicsCtx = this.dynamicsCanvas.getContext('2d');
  }

  private setupEventListeners(): void {
    // Play / Pause
    this.btnPlayPause.addEventListener('click', () => {
      this.togglePlayPause();
    });

    // Camera Mode
    this.selectCameraMode.addEventListener('change', () => {
      this.viewer.setCameraMode(this.selectCameraMode.value as CameraMode);
    });

    // Color Mode
    this.selectColorMode.addEventListener('change', () => {
      this.viewer.setColorMode(this.selectColorMode.value as ColorMode);
    });

    // Frustum Toggle
    this.btnToggleFrustum.addEventListener('click', () => {
      const isVisible = this.viewer.isFrustumVisible();
      this.viewer.setFrustumVisible(!isVisible);
      this.btnToggleFrustum.textContent = `云台视锥: ${!isVisible ? '开' : '关'}`;
      this.btnToggleFrustum.classList.toggle('active', !isVisible);
    });

    // Fly To Trajectory
    this.btnFlyTo.addEventListener('click', () => {
      this.viewer.flyToTrajectory();
    });

    // Altitude Source Reference
    this.btnAltSource.addEventListener('click', () => {
      this.altSource = this.altSource === 'altitudes' ? 'heights' : 'altitudes';
      this.btnAltSource.textContent = `高程: ${this.altSource === 'altitudes' ? '椭球高(ASL)' : '相对高(AGL)'}`;
      this.viewer.setAltitudeOptions(this.altSource);
    });

    // Playback Rate Pills
    const rateButtons = document.querySelectorAll('.rate-btn');
    rateButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        rateButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const rate = parseFloat(btn.getAttribute('data-rate') || '1.0');
        this.viewer.setPlaybackRate(rate);
      });
    });

    // Drawer Tabs
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.getAttribute('data-tab');
        this.switchDrawerTab(tab || 'battery');
      });
    });

    // Drawer Open / Close
    this.btnToggleDrawer.addEventListener('click', () => {
      this.telemetryDrawer.classList.toggle('open');
      this.drawBatteryChart();
      this.drawDynamicsChart();
    });

    this.btnCloseDrawer.addEventListener('click', () => {
      this.telemetryDrawer.classList.remove('open');
    });

    // File Open Dialogs
    const inputLog = document.getElementById('inputLogFile') as HTMLInputElement;
    const inputWpml = document.getElementById('inputWpmlFile') as HTMLInputElement;

    document.getElementById('btnOpenLog')?.addEventListener('click', () => inputLog.click());
    document.getElementById('btnOpenWpml')?.addEventListener('click', () => inputWpml.click());
    document.getElementById('btnDemo')?.addEventListener('click', () => this.loadDemoFlight());

    inputLog.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        await this.handleLogFile(file);
      }
    });

    inputWpml.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        await this.handleWpmlFile(file);
      }
    });

    // Keyboard Shortcuts: Space -> Play/Pause, ArrowLeft/Right -> Seek 5s
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        this.viewer.seek(this.currentTimeSec + 5);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        this.viewer.seek(this.currentTimeSec - 5);
      }
    });
  }

  private setupDragAndDrop(): void {
    const overlay = document.getElementById('dragOverlay') as HTMLElement;
    let dragCounter = 0;

    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      overlay.classList.add('active');
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        overlay.classList.remove('active');
      }
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.remove('active');

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = file.name.toLowerCase();
        if (name.endsWith('.dat') || name.endsWith('.txt') || name.endsWith('.bin')) {
          await this.handleLogFile(file);
        } else if (name.endsWith('.kmz') || name.endsWith('.kml') || name.endsWith('.xml')) {
          await this.handleWpmlFile(file);
        }
      }
    });
  }

  private togglePlayPause(): void {
    this.isPlaying = !this.isPlaying;
    if (this.isPlaying) {
      if (this.currentTimeSec >= this.durationSec - 0.1) {
        this.viewer.seek(0);
      }
      this.viewer.play();
      this.btnPlayPause.textContent = '⏸';
    } else {
      this.viewer.pause();
      this.btnPlayPause.textContent = '▶';
    }
  }

  private setupBridgeHandlers(): void {
    // Inbound command reactions
    this.bridge.on('LOAD_FLIGHT', (payload) => {
      if (payload && payload.flightPackage) {
        this.applyFlightPackage(payload.flightPackage, payload.deviation);
      }
    });

    this.bridge.on('LOAD_WPML', async (payload) => {
      if (payload && payload.route) {
        this.applyPlannedRoute(payload.route);
      }
    });

    this.bridge.on('PLAY', () => {
      this.isPlaying = true;
      this.viewer.play();
      this.btnPlayPause.textContent = '⏸';
    });

    this.bridge.on('PAUSE', () => {
      this.isPlaying = false;
      this.viewer.pause();
      this.btnPlayPause.textContent = '▶';
    });

    // Notify host container of viewer readiness
    this.bridge.emit('READY', {
      version: '1.0.0',
      capabilities: ['playback', 'frustum', 'deviation', 'echarts', 'unity_bridge'],
    });
  }

  public async loadDemoFlight(): Promise<void> {
    // Generate realistic simulated flight binary buffer (250 points, Matrice 350 RTK, Hangzhou inspection zone)
    const rawBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Matrice 350 RTK',
      pointsCount: 250,
      startLon: 120.1536,
      startLat: 30.2874,
      startAlt: 95.0,
      photoCount: 4,
      warningCount: 2,
    });

    const pkg = await parseDjiFlightLog(rawBuffer);

    // Standard WPML inspection route
    const plannedRoute: WPMLRoute = {
      name: '500kV_Tower_Line_Inspection',
      waypoints: [
        { index: 0, lon: 120.1536, lat: 30.2874, alt: 95.0, speed: 5.0 },
        { index: 1, lon: 120.1548, lat: 30.2885, alt: 98.0, speed: 5.0 },
        { index: 2, lon: 120.1562, lat: 30.2898, alt: 102.0, speed: 6.0 },
        { index: 3, lon: 120.1575, lat: 30.2910, alt: 96.0, speed: 5.0 },
        { index: 4, lon: 120.1588, lat: 30.2922, alt: 95.0, speed: 4.0 },
      ],
    };

    const deviation = calculateTrajectoryDeviation(pkg.telemetry, plannedRoute);
    this.applyFlightPackage(pkg, deviation);
    this.applyPlannedRoute(plannedRoute);

    // Start auto-playback
    this.togglePlayPause();
  }

  public async handleLogFile(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      const pkg = await parseDjiFlightLog(buffer);

      let dev: DeviationResult | null = null;
      if (this.currentRoute) {
        dev = calculateTrajectoryDeviation(pkg.telemetry, this.currentRoute);
      }
      this.applyFlightPackage(pkg, dev || undefined);
    } catch (err: any) {
      console.error('Failed to parse flight log file:', err);
      alert(`解析飞行日志失败: ${err?.message || '未知格式错误'}`);
    }
  }

  public async handleWpmlFile(file: File): Promise<void> {
    try {
      const bufferOrText = file.name.toLowerCase().endsWith('.kmz')
        ? await file.arrayBuffer()
        : await file.text();
      const route = await parseWPMLRoute(bufferOrText);
      this.applyPlannedRoute(route);
    } catch (err: any) {
      console.error('Failed to parse WPML route file:', err);
      alert(`解析 WPML 航线失败: ${err?.message || '未知航线格式'}`);
    }
  }

  private applyFlightPackage(pkg: FlightRecordPackage, deviation?: DeviationResult): void {
    this.currentPackage = pkg;
    this.currentDeviation = deviation || null;

    const count = pkg.telemetry.timestamps.length;
    if (count === 0) return;

    const t0 = pkg.telemetry.timestamps[0];
    const tEnd = pkg.telemetry.timestamps[count - 1];
    this.durationSec = Math.max(0, (tEnd - t0) / 1000);
    this.currentTimeSec = 0;

    // 1. Load into Cesium 3D Engine
    this.viewer.loadFlight(pkg, deviation);

    // 2. Load into HUD Avionics Dashboard
    this.dashboard.loadPackage(pkg);

    // 3. Update UI Metadata Badges
    this.valModel.textContent = pkg.meta.aircraftType || 'Matrice 350 RTK';
    this.valDuration.textContent = this.formatTime(this.durationSec);
    this.valDistance.textContent = `${pkg.meta.totalDistance.toFixed(0)} m`;
    this.valMaxAlt.textContent = `${pkg.meta.maxAltitude.toFixed(1)} m`;

    // 4. Update Battery and Deviation Stats
    const batteryData = extractBatterySeries(pkg.telemetry);
    const maxDiffMv = (batteryData.stats.maxDiff * 1000).toFixed(0);
    this.valBatteryDiff.textContent = `${maxDiffMv} mV`;

    if (batteryData.stats.maxDiff > 0.05) {
      this.statMaxDiff.innerHTML = `<span class="card-warning">${maxDiffMv}</span> <span class="stat-card-unit">mV (异常)</span>`;
    } else {
      this.statMaxDiff.innerHTML = `<span class="card-normal">${maxDiffMv}</span> <span class="stat-card-unit">mV (良好)</span>`;
    }

    this.statVoltageRange.textContent = `${batteryData.stats.minVoltage.toFixed(1)} ~ ${batteryData.stats.maxVoltage.toFixed(1)} V`;
    this.statMaxTemp.textContent = `${batteryData.stats.maxTemp.toFixed(1)} °C`;

    if (deviation) {
      this.statMaxDeviation.textContent = `${deviation.stats.maxDeviation.toFixed(2)} m`;
    } else {
      this.statMaxDeviation.textContent = '未导入航线';
    }

    // 5. Populate Events List
    this.populateEventsList(pkg, batteryData.anomalies);

    // 6. Draw Charts
    this.drawBatteryChart();
    this.drawDynamicsChart();
  }

  private applyPlannedRoute(route: WPMLRoute): void {
    this.currentRoute = route;
    this.viewer.loadPlannedRoute(route);

    if (this.currentPackage) {
      const dev = calculateTrajectoryDeviation(this.currentPackage.telemetry, route);
      this.currentDeviation = dev;
      this.statMaxDeviation.textContent = `${dev.stats.maxDeviation.toFixed(2)} m`;
      this.viewer.loadFlight(this.currentPackage, dev);
    }
  }

  private updateTimeDisplay(currentSec: number, durationSec: number): void {
    this.timeCurrent.textContent = this.formatTime(currentSec);
    this.timeTotal.textContent = this.formatTime(durationSec);
  }

  private updateLiveTelemetryReadout(telemetry: InterpolatedTelemetry): void {
    // RTK status badge
    if (telemetry.rtkStatus === 2) {
      this.valRtk.className = 'chip-badge badge-rtk-fixed';
      this.valRtk.textContent = 'RTK FIXED';
    } else if (telemetry.rtkStatus === 1) {
      this.valRtk.className = 'chip-badge badge-rtk-float';
      this.valRtk.textContent = 'RTK FLOAT';
    } else {
      this.valRtk.className = 'chip-badge badge-rtk-none';
      this.valRtk.textContent = 'SINGLE GPS';
    }

    // Chart cursor readout
    if (this.chartCursorTime) {
      this.chartCursorTime.textContent = `${this.currentTimeSec.toFixed(1)}s`;
    }
  }

  private formatTime(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
  }

  private populateEventsList(pkg: FlightRecordPackage, anomalies: any[]): void {
    if (!this.eventsListContainer) return;
    this.eventsListContainer.innerHTML = '';

    const items: Array<{ timeSec: number; tag: string; tagClass: string; desc: string }> = [];
    const t0 = pkg.telemetry.timestamps[0];

    // Photos
    for (const p of pkg.events.photos) {
      const timeSec = (p.timestamp - t0) / 1000;
      items.push({
        timeSec,
        tag: '照片',
        tagClass: 'tag-photo',
        desc: `拍摄照片 #${p.index + 1} (${p.position[0].toFixed(5)}, ${p.position[1].toFixed(5)})`,
      });
    }

    // Warnings
    for (const w of pkg.events.warnings) {
      const timeSec = (w.timestamp - t0) / 1000;
      items.push({
        timeSec,
        tag: w.level.toUpperCase(),
        tagClass: w.level === 'critical' ? 'tag-anomaly' : 'tag-warning',
        desc: w.message,
      });
    }

    // Battery Anomalies
    for (const a of anomalies) {
      items.push({
        timeSec: a.timeSec,
        tag: '压差告警',
        tagClass: 'tag-anomaly',
        desc: `电芯压差 ${(a.voltageDiff * 1000).toFixed(0)}mV 超出安全阈值`,
      });
    }

    items.sort((a, b) => a.timeSec - b.timeSec);

    if (items.length === 0) {
      this.eventsListContainer.innerHTML =
        '<div style="text-align:center; color:var(--color-text-dim); padding:20px 0;">该架次未发生异常告警或拍照事件</div>';
      return;
    }

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'event-card';
      el.innerHTML = `
        <span class="event-tag ${item.tagClass}">${item.tag}</span>
        <span class="event-desc">${item.desc}</span>
        <span class="event-time">${this.formatTime(item.timeSec)}</span>
      `;
      el.addEventListener('click', () => {
        this.viewer.seek(item.timeSec);
      });
      this.eventsListContainer.appendChild(el);
    }
  }

  private switchDrawerTab(tab: string): void {
    const secBattery = document.getElementById('sectionBatteryChart');
    const secDynamics = document.getElementById('sectionDynamicsChart');
    const secEvents = this.eventsListContainer;

    if (tab === 'battery') {
      if (secBattery) secBattery.style.display = 'block';
      if (secDynamics) secDynamics.style.display = 'none';
      if (secEvents) secEvents.style.display = 'none';
      this.drawBatteryChart();
    } else if (tab === 'dynamics') {
      if (secBattery) secBattery.style.display = 'none';
      if (secDynamics) secDynamics.style.display = 'block';
      if (secEvents) secEvents.style.display = 'none';
      this.drawDynamicsChart();
    } else if (tab === 'events') {
      if (secBattery) secBattery.style.display = 'none';
      if (secDynamics) secDynamics.style.display = 'none';
      if (secEvents) secEvents.style.display = 'flex';
    }
  }

  private setupCanvasCharts(): void {
    // Custom chart adapter implementing setOption & dispatchAction for HUDDashboard
    const chartAdapter = {
      setOption: () => {
        this.drawBatteryChart();
        this.drawDynamicsChart();
      },
      dispatchAction: (action: any) => {
        if (action && typeof action.dataIndex === 'number' && this.currentPackage) {
          const ts = this.currentPackage.telemetry.timestamps;
          if (action.dataIndex < ts.length) {
            const timeSec = (ts[action.dataIndex] - ts[0]) / 1000;
            this.renderChartsCursor(timeSec);
          }
        }
      },
    };

    this.dashboard.attachChart(chartAdapter);
  }

  private drawBatteryChart(): void {
    if (!this.batteryCtx || !this.currentPackage) return;
    const ctx = this.batteryCtx;
    const w = this.batteryCanvas.width;
    const h = this.batteryCanvas.height;

    ctx.clearRect(0, 0, w, h);

    const ts = this.currentPackage.telemetry.timestamps;
    const volts = this.currentPackage.telemetry.batteryVoltages;
    const diffs = this.currentPackage.telemetry.maxCellVoltageDiff;
    const n = ts.length;
    if (n < 2) return;

    // Draw Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let y = 20; y < h; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Min / Max calculation
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      if (volts[i] < minV) minV = volts[i];
      if (volts[i] > maxV) maxV = volts[i];
    }
    const rangeV = Math.max(1, maxV - minV);

    // 1. Draw Total Voltage Curve (Cyan line)
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - 15 - ((volts[i] - minV) / rangeV) * (h - 35);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 2. Draw Cell Diff Warning Curve (Amber/Red fill & line)
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      // Map diff 0 ~ 0.1V to chart height
      const y = h - 15 - Math.min(1, diffs[i] / 0.1) * (h - 35);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Threshold line at 50mV (0.05V)
    const threshY = h - 15 - 0.5 * (h - 35);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Legend
    ctx.font = '9px monospace';
    ctx.fillStyle = '#00e5ff';
    ctx.fillText('总电压(V)', 10, 14);
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('电芯压差(mV)', 75, 14);
    ctx.fillStyle = '#ef4444';
    ctx.fillText('50mV告警线', 155, 14);
  }

  private drawDynamicsChart(): void {
    if (!this.dynamicsCtx || !this.currentPackage) return;
    const ctx = this.dynamicsCtx;
    const w = this.dynamicsCanvas.width;
    const h = this.dynamicsCanvas.height;

    ctx.clearRect(0, 0, w, h);

    const ts = this.currentPackage.telemetry.timestamps;
    const speeds = this.currentPackage.telemetry.speeds;
    const altitudes = this.currentPackage.telemetry.altitudes;
    const n = ts.length;
    if (n < 2) return;

    // Draw Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let y = 20; y < h; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    let maxSpeed = 0.1;
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    for (let i = 0; i < n; i++) {
      if (speeds[i] > maxSpeed) maxSpeed = speeds[i];
      if (altitudes[i] < minAlt) minAlt = altitudes[i];
      if (altitudes[i] > maxAlt) maxAlt = altitudes[i];
    }
    const rangeAlt = Math.max(1, maxAlt - minAlt);

    // Speed curve (Emerald green)
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - 15 - (speeds[i] / maxSpeed) * (h - 35);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Altitude curve (Purple/Indigo)
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - 15 - ((altitudes[i] - minAlt) / rangeAlt) * (h - 35);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Legend
    ctx.font = '9px monospace';
    ctx.fillStyle = '#10b981';
    ctx.fillText('飞行地速(m/s)', 10, 14);
    ctx.fillStyle = '#818cf8';
    ctx.fillText('海拔高程(m)', 95, 14);
  }

  private renderChartsCursor(timeSec: number): void {
    if (!this.currentPackage || this.durationSec <= 0) return;
    const progress = Math.min(1, Math.max(0, timeSec / this.durationSec));

    // Battery chart cursor
    if (this.batteryCtx) {
      this.drawBatteryChart();
      const x = progress * this.batteryCanvas.width;
      this.batteryCtx.strokeStyle = '#ff1744';
      this.batteryCtx.lineWidth = 1.5;
      this.batteryCtx.beginPath();
      this.batteryCtx.moveTo(x, 0);
      this.batteryCtx.lineTo(x, this.batteryCanvas.height);
      this.batteryCtx.stroke();
    }

    // Dynamics chart cursor
    if (this.dynamicsCtx) {
      this.drawDynamicsChart();
      const x = progress * this.dynamicsCanvas.width;
      this.dynamicsCtx.strokeStyle = '#ff1744';
      this.dynamicsCtx.lineWidth = 1.5;
      this.dynamicsCtx.beginPath();
      this.dynamicsCtx.moveTo(x, 0);
      this.dynamicsCtx.lineTo(x, this.dynamicsCanvas.height);
      this.dynamicsCtx.stroke();
    }
  }
}

// Bootstrap Application when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  const app = new FlightViewerApp();
  app.initialize().catch((err) => {
    console.error('[FlightViewerApp] Fatal initialization error:', err);
  });
});
