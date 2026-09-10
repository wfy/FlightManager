# DJI Drone Flight Log 3D Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一套对标 Flight Reader、面向大疆行业机巡主流的 Web 3D 飞行日志查看与时空研判系统，具备 100% 离线解密解析、CesiumJS 4D 姿态与动态视锥回放、WPML 规划 vs 实际飞行空间偏差比对、双电池工况 HUD 看板以及可直接植入 Unity (3DTrackPlan) 的嵌入式 SDK。

**Architecture:** 前端工程化模块架构：以 Web Worker 运行的离线解析内核为底座，通过紧凑 TypedArray 遥测流驱动 CesiumJS 4D 时空视景与 ECharts 多轴时序看板，并通过标准 postMessage / Bridge SDK 提供跨平台/跨系统宿主嵌入能力。

**Tech Stack:** TypeScript, Vite, CesiumJS, ECharts, Web Crypto (AES-128-CBC) / Web Worker, Vitest.

## Global Constraints

- 纯离线安全原则：解析与计算 100% 在本地浏览器端 Worker 执行，严禁任何形式的日志网络上传。
- 坐标基准：统一基于 WGS84 (EPSG:4326/4979) 椭球大地坐标系，保留高程正高转换接口。
- 代码语言：生产代码、变量、注释使用英文或规范中英双语；对外输出文档与 UI 提示为中文。
- 性能底线：解析 50MB 日志耗时 $\le 3$ 秒，三维回放渲染稳定 60 FPS，内存峰值 $\le 200MB$。

---

### Task 1: 项目工程脚手架与通用数据结构定义 (Project Scaffolding & Core Typings)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `src/core/types.ts`
- Test: `tests/core/types.test.ts`

**Interfaces:**
- Consumes: None (Root Task)
- Produces: `FlightRecordPackage`, `TelemetryStream`, `PhotoEvent`, `WarningEvent`, `WPMLRoute`, `DeviationResult`

- [ ] **Step 1: Write failing test for data contract structures**

```typescript
// tests/core/types.test.ts
import { describe, it, expect } from 'vitest';
import { createEmptyFlightPackage } from '../../src/core/types';

describe('Flight Record Types Contract', () => {
  it('should initialize empty flight package with typed arrays', () => {
    const pkg = createEmptyFlightPackage();
    expect(pkg.meta.aircraftType).toBe('Unknown');
    expect(pkg.telemetry.timestamps).toBeInstanceOf(Float64Array);
    expect(pkg.telemetry.longitudes).toBeInstanceOf(Float64Array);
    expect(pkg.telemetry.latitudes).toBeInstanceOf(Float64Array);
    expect(pkg.telemetry.altitudes).toBeInstanceOf(Float32Array);
    expect(pkg.telemetry.maxCellVoltageDiff).toBeInstanceOf(Float32Array);
    expect(pkg.events.photos).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/core/types.test.ts`
Expected: FAIL with "Cannot find module '../../src/core/types'"

- [ ] **Step 3: Write minimal implementation**

Create `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, and implement `src/core/types.ts`:

```typescript
// src/core/types.ts
export interface FlightMeta {
  aircraftType: string;
  aircraftSn: string;
  cameraSn?: string;
  batterySnList: string[];
  startTime: number;
  durationMs: number;
  totalDistance: number;
  maxAltitude: number;
  homeLocation: [number, number, number];
}

export interface TelemetryStream {
  timestamps: Float64Array;
  longitudes: Float64Array;
  latitudes: Float64Array;
  altitudes: Float32Array;
  heights: Float32Array;
  pitch: Float32Array;
  roll: Float32Array;
  yaw: Float32Array;
  speeds: Float32Array;
  rtkStatus: Uint8Array;
  batteryPercents: Uint8Array;
  batteryVoltages: Float32Array;
  maxCellVoltageDiff: Float32Array;
  maxCellTemp: Float32Array;
  gimbalPitch: Float32Array;
  gimbalYaw: Float32Array;
}

export interface PhotoEvent {
  id: string;
  timestamp: number;
  index: number;
  position: [number, number, number];
  gimbalAngles: [number, number, number];
  thumbnailBase64?: string;
}

export interface WarningEvent {
  timestamp: number;
  level: 'info' | 'warning' | 'critical';
  code: number;
  message: string;
}

export interface FlightRecordPackage {
  meta: FlightMeta;
  telemetry: TelemetryStream;
  events: {
    photos: PhotoEvent[];
    warnings: WarningEvent[];
  };
}

export function createEmptyFlightPackage(): FlightRecordPackage {
  return {
    meta: {
      aircraftType: 'Unknown',
      aircraftSn: '',
      batterySnList: [],
      startTime: 0,
      durationMs: 0,
      totalDistance: 0,
      maxAltitude: 0,
      homeLocation: [0, 0, 0],
    },
    telemetry: {
      timestamps: new Float64Array(0),
      longitudes: new Float64Array(0),
      latitudes: new Float64Array(0),
      altitudes: new Float32Array(0),
      heights: new Float32Array(0),
      pitch: new Float32Array(0),
      roll: new Float32Array(0),
      yaw: new Float32Array(0),
      speeds: new Float32Array(0),
      rtkStatus: new Uint8Array(0),
      batteryPercents: new Uint8Array(0),
      batteryVoltages: new Float32Array(0),
      maxCellVoltageDiff: new Float32Array(0),
      maxCellTemp: new Float32Array(0),
      gimbalPitch: new Float32Array(0),
      gimbalYaw: new Float32Array(0),
    },
    events: {
      photos: [],
      warnings: [],
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vite.config.ts vitest.config.ts src/core/ tests/core/
git commit -m "feat(core): scaffold project and define core telemetry data contracts"
```

---

### Task 2: DJI Pilot 2 加密日志解密与遥测解包内核 (DJI Log Decryption & Record Parser)

**Files:**
- Create: `src/parser/cryptoUtils.ts`
- Create: `src/parser/djiParser.ts`
- Create: `src/parser/parserWorker.ts`
- Test: `tests/parser/djiParser.test.ts`

**Interfaces:**
- Consumes: `FlightRecordPackage`, `createEmptyFlightPackage` from Task 1
- Produces: `parseDjiFlightLog(buffer: ArrayBuffer): Promise<FlightRecordPackage>`

- [ ] **Step 1: Write failing test for DJI record frame decoding**

```typescript
// tests/parser/djiParser.test.ts
import { describe, it, expect } from 'vitest';
import { parseDjiFlightLog, buildMockDjiBinaryBuffer } from '../../src/parser/djiParser';

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
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/parser/djiParser.test.ts`
Expected: FAIL with "parseDjiFlightLog not defined"

- [ ] **Step 3: Write implementation for cryptoUtils and djiParser**

Implement AES-128 record decoding, DJI record header reader (Type 1: OSD, Type 2: Home, Type 3: Gimbal, Type 4: Battery, Type 5: Camera/Photo, Type 8: Warnings), extracting to typed arrays, and wrapping Web Worker message handling in `src/parser/parserWorker.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/parser/djiParser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/parser/ tests/parser/
git commit -m "feat(parser): implement offline DJI log decryption and record frame parser"
```

---

### Task 3: DJI WPML 航线规划解析器与空间偏差比对求解器 (WPML Parser & 3D Deviation Solver)

**Files:**
- Create: `src/parser/wpmlParser.ts`
- Create: `src/spatial/deviationSolver.ts`
- Test: `tests/spatial/deviationSolver.test.ts`

**Interfaces:**
- Consumes: `TelemetryStream` from Task 1
- Produces: `parseWPMLRoute(kmlOrKmzContent: string | ArrayBuffer): WPMLRoute`, `calculateTrajectoryDeviation(actual: TelemetryStream, planned: WPMLRoute): DeviationResult`

- [ ] **Step 1: Write failing test for 3D trajectory deviation calculation**

```typescript
// tests/spatial/deviationSolver.test.ts
import { describe, it, expect } from 'vitest';
import { calculateTrajectoryDeviation, WPMLRoute } from '../../src/spatial/deviationSolver';
import { createEmptyFlightPackage } from '../../src/core/types';

describe('Spatial Trajectory Deviation Solver', () => {
  it('should compute spatial Euclidean, lateral, and vertical deviations between actual and planned route', () => {
    const planned: WPMLRoute = {
      name: 'Line_Inspection_01',
      waypoints: [
        { index: 0, lon: 120.000000, lat: 30.000000, alt: 100.0, speed: 5.0 },
        { index: 1, lon: 120.001000, lat: 30.000000, alt: 100.0, speed: 5.0 },
      ],
    };
    const pkg = createEmptyFlightPackage();
    pkg.telemetry.longitudes = new Float64Array([120.000500]);
    pkg.telemetry.latitudes = new Float64Array([30.000009]); // ~1 meter north
    pkg.telemetry.altitudes = new Float32Array([100.5]);     // 0.5 meter above
    pkg.telemetry.timestamps = new Float64Array([10]);

    const result = calculateTrajectoryDeviation(pkg.telemetry, planned);
    expect(result.deviations.length).toBe(1);
    expect(result.deviations[0].euclideanDistance).toBeGreaterThan(1.0);
    expect(result.deviations[0].verticalDiff).toBeCloseTo(0.5, 1);
    expect(result.stats.maxDeviation).toBeGreaterThan(1.0);
    expect(result.deviations[0].status).toBe('warning'); // > 1.0m warning/critical
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/spatial/deviationSolver.test.ts`
Expected: FAIL with "calculateTrajectoryDeviation not defined"

- [ ] **Step 3: Write minimal implementation**

Implement:
1. `src/parser/wpmlParser.ts`: XML/KML DOM parser extracting `<Placemark>` waypoints (`wpml:executeHeight`, coordinates, gimbal angles).
2. `src/spatial/deviationSolver.ts`: Geodesic coordinate projection (WGS84 to local NED meters), 3D point-to-segment distance algorithm, status categorization (`normal` < 0.5m, `warning` 0.5-1m, `critical` > 1m).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/spatial/deviationSolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/spatial/deviationSolver.ts src/parser/wpmlParser.ts tests/spatial/
git commit -m "feat(spatial): add WPML route parser and 3D trajectory deviation solver"
```

---

### Task 4: CesiumJS 4D 时空视景与 6-DOF 姿态回放引擎 (Cesium 3D Spatiotemporal Viewport)

**Files:**
- Create: `src/viewport/cesiumViewer.ts`
- Create: `src/viewport/trajectoryLayer.ts`
- Test: `tests/viewport/trajectoryLayer.test.ts`

**Interfaces:**
- Consumes: `FlightRecordPackage`, `DeviationResult` from Tasks 1, 3
- Produces: `Flight3DViewerEngine`: methods `initialize(container: HTMLElement)`, `loadFlight(pkg: FlightRecordPackage)`, `seek(timeSec: number)`, `setCameraMode(mode: 'follow'|'free'|'fpv')`

- [ ] **Step 1: Write failing test for trajectory path generation and color segmenting**

```typescript
// tests/viewport/trajectoryLayer.test.ts
import { describe, it, expect } from 'vitest';
import { generateTrajectorySegments } from '../../src/viewport/trajectoryLayer';
import { createEmptyFlightPackage } from '../../src/core/types';

describe('Trajectory Layer Segmenter', () => {
  it('should generate color-coded polyline segments according to RTK status and deviation', () => {
    const pkg = createEmptyFlightPackage();
    pkg.telemetry.longitudes = new Float64Array([120.0, 120.0001, 120.0002]);
    pkg.telemetry.latitudes = new Float64Array([30.0, 30.0001, 30.0002]);
    pkg.telemetry.altitudes = new Float32Array([100, 105, 110]);
    pkg.telemetry.rtkStatus = new Uint8Array([50, 32, 0]); // Fixed, Float, None

    const segments = generateTrajectorySegments(pkg.telemetry, 'rtk');
    expect(segments.length).toBe(2);
    expect(segments[0].colorHex).toBe('#00E676'); // Green for Fixed
    expect(segments[1].colorHex).toBe('#FFD600'); // Yellow for Float
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/viewport/trajectoryLayer.test.ts`
Expected: FAIL with "generateTrajectorySegments not defined"

- [ ] **Step 3: Write minimal implementation**

Implement:
1. `src/viewport/trajectoryLayer.ts`: Color mapping algorithms (by altitude, speed, RTK status, or WPML deviation).
2. `src/viewport/cesiumViewer.ts`: Cesium Viewer lifecycle, WGS84 trajectory Polyline creation, Cesium `SampledPositionProperty` and `SampledProperty` quaternion orientation for 6-DOF aircraft GLB model, and camera tracking modes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/viewport/trajectoryLayer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/viewport/ tests/viewport/
git commit -m "feat(viewport): implement CesiumJS 4D spatiotemporal viewer and 6-DOF aircraft replay"
```

---

### Task 5: 云台相机动态视锥与地表足印投影 (Dynamic Gimbal Frustum & Footprint Projection)

**Files:**
- Create: `src/spatial/frustumSolver.ts`
- Create: `src/viewport/frustumLayer.ts`
- Test: `tests/spatial/frustumSolver.test.ts`

**Interfaces:**
- Consumes: `TelemetryStream` from Task 1
- Produces: `calculateFrustumGeometry(position, gimbalPitch, gimbalYaw, hfovDeg, vfovDeg, maxRange)`

- [ ] **Step 1: Write failing test for frustum geometry and ground intersection**

```typescript
// tests/spatial/frustumSolver.test.ts
import { describe, it, expect } from 'vitest';
import { calculateFrustumGeometry } from '../../src/spatial/frustumSolver';

describe('Gimbal Frustum Solver', () => {
  it('should calculate 4 pyramid rays and ground footprint polygon', () => {
    const frustum = calculateFrustumGeometry({
      position: [120.0, 30.0, 100.0],
      gimbalPitch: -45.0, // looking 45 deg down
      gimbalYaw: 90.0,    // looking East
      hfovDeg: 60.0,
      vfovDeg: 45.0,
      maxRangeMeters: 200.0,
    });
    expect(frustum.rays.length).toBe(4);
    expect(frustum.footprintPolygon.length).toBeGreaterThanOrEqual(3);
    // Footprint center must be east of the drone
    expect(frustum.footprintCenter[0]).toBeGreaterThan(120.0);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/spatial/frustumSolver.test.ts`
Expected: FAIL with "calculateFrustumGeometry not defined"

- [ ] **Step 3: Write minimal implementation**

Implement ray-plane / ray-ellipsoid projection algorithms in `src/spatial/frustumSolver.ts` and Cesium custom Geometry/Polygon primitives rendering in `src/viewport/frustumLayer.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/spatial/frustumSolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/spatial/frustumSolver.ts src/viewport/frustumLayer.ts tests/spatial/
git commit -m "feat(frustum): add dynamic camera frustum and terrain footprint projection solver"
```

---

### Task 6: 仿生飞行 HUD 仪表与双电池工况 ECharts 联动看板 (HUD & Telemetry Dashboard)

**Files:**
- Create: `src/dashboard/hudInstruments.ts`
- Create: `src/dashboard/telemetryCharts.ts`
- Create: `src/dashboard/eventTimeline.ts`
- Test: `tests/dashboard/telemetryCharts.test.ts`

**Interfaces:**
- Consumes: `FlightRecordPackage` from Task 1
- Produces: `HUDDashboard`: methods `renderFrame(index: number)`, `syncCharts(currentTime: number)`, `onEventClicked(callback)`

- [ ] **Step 1: Write failing test for battery cell difference analysis and warning detection**

```typescript
// tests/dashboard/telemetryCharts.test.ts
import { describe, it, expect } from 'vitest';
import { extractBatterySeries, detectAbnormalCellVoltage } from '../../src/dashboard/telemetryCharts';
import { createEmptyFlightPackage } from '../../src/core/types';

describe('Telemetry Dashboard Data Provider', () => {
  it('should detect abnormal cell voltage difference exceeding threshold', () => {
    const pkg = createEmptyFlightPackage();
    pkg.telemetry.timestamps = new Float64Array([0, 1, 2, 3]);
    pkg.telemetry.maxCellVoltageDiff = new Float32Array([0.02, 0.04, 0.08, 0.03]); // frame 2 exceeds 0.05V

    const anomalies = detectAbnormalCellVoltage(pkg.telemetry, 0.05);
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].timestamp).toBe(2);
    expect(anomalies[0].voltageDiff).toBeCloseTo(0.08, 2);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/dashboard/telemetryCharts.test.ts`
Expected: FAIL with "detectAbnormalCellVoltage not defined"

- [ ] **Step 3: Write minimal implementation**

Implement:
1. `src/dashboard/hudInstruments.ts`: Canvas-based Artificial Horizon ball, Speed/Alt moving tape, Heading Compass Rose, and RTK badge.
2. `src/dashboard/telemetryCharts.ts`: ECharts multi-axis options generator (Altitude/Speed, Voltage/MaxCellDiff, Throttle/Pitch), cursor synchronization handlers.
3. `src/dashboard/eventTimeline.ts`: Interactive time scrubber with photo snapshot icons and warning flags.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard/telemetryCharts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/ tests/dashboard/
git commit -m "feat(dashboard): implement flight HUD instrument and battery health ECharts sync"
```

---

### Task 7: 插件化嵌入 SDK 与 Unity (3DTrackPlan) 桥接适配器 (Embedding SDK & Unity Bridge)

**Files:**
- Create: `src/bridge/flightViewerBridge.ts`
- Create: `src/bridge/unityBridgeDemo.cs`
- Test: `tests/bridge/flightViewerBridge.test.ts`

**Interfaces:**
- Consumes: All previous tasks
- Produces: `FlightViewerBridge` class for host web embedding, Unity C# `FlightViewerController.cs`

- [ ] **Step 1: Write failing test for postMessage bridge message serialization and dispatching**

```typescript
// tests/bridge/flightViewerBridge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { FlightViewerBridge } from '../../src/bridge/flightViewerBridge';

describe('Flight Viewer Host Bridge Protocol', () => {
  it('should correctly handle incoming commands and dispatch outbound events', () => {
    const bridge = new FlightViewerBridge();
    const mockCallback = vi.fn();
    bridge.on('TIME_UPDATE', mockCallback);

    bridge.emit('TIME_UPDATE', { currentTimeMs: 12345, telemetryFrame: { speed: 12.5 } });
    expect(mockCallback).toHaveBeenCalledWith({
      currentTimeMs: 12345,
      telemetryFrame: { speed: 12.5 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/bridge/flightViewerBridge.test.ts`
Expected: FAIL with "FlightViewerBridge not defined"

- [ ] **Step 3: Write minimal implementation**

Implement:
1. `src/bridge/flightViewerBridge.ts`: Typed protocol parser, `window.addEventListener('message')` wrapper with origin validation, and `postMessage` dispatcher.
2. `src/bridge/unityBridgeDemo.cs`: Complete C# reference script for Unity 2019+ (compatible with `3DTrackPlan` architecture) implementing `Vuplex.WebView` / CEF message dispatch and receiving.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge/flightViewerBridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge/ tests/bridge/
git commit -m "feat(bridge): implement host embedding SDK and Unity 3DTrackPlan C# bridge adapter"
```

---

### Task 8: 系统整体集成、Demo 主界面与端到端质检验收 (System Integration & Verification)

**Files:**
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/style.css`
- Modify: `README.md`
- Test: `tests/e2e/integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7
- Produces: Complete working Web 3D Viewer Application runnable via `npm run dev` and buildable via `npm run build`.

- [ ] **Step 1: Write end-to-end integration test verifying complete data flow from parser to viewer and dashboard**

```typescript
// tests/e2e/integration.test.ts
import { describe, it, expect } from 'vitest';
import { parseDjiFlightLog, buildMockDjiBinaryBuffer } from '../../src/parser/djiParser';
import { calculateTrajectoryDeviation, WPMLRoute } from '../../src/spatial/deviationSolver';
import { generateTrajectorySegments } from '../../src/viewport/trajectoryLayer';

describe('End-to-End Flight Log Workflow', () => {
  it('should parse binary log, calculate deviation against WPML route, and generate 3D segments', async () => {
    const rawBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Matrice 350 RTK',
      pointsCount: 50,
      startLon: 120.0,
      startLat: 30.0,
      startAlt: 80.0,
    });
    const pkg = await parseDjiFlightLog(rawBuffer);
    expect(pkg.telemetry.timestamps.length).toBe(50);

    const planned: WPMLRoute = {
      name: 'Tower_23_Inspection',
      waypoints: [
        { index: 0, lon: 120.0, lat: 30.0, alt: 80.0, speed: 4.0 },
        { index: 1, lon: 120.0005, lat: 30.0005, alt: 80.0, speed: 4.0 },
      ],
    };
    const dev = calculateTrajectoryDeviation(pkg.telemetry, planned);
    expect(dev.deviations.length).toBe(50);

    const segments = generateTrajectorySegments(pkg.telemetry, 'deviation', dev);
    expect(segments.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run tests/e2e/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Implement main web UI and bundle styling**

Create `index.html`, `src/main.ts`, `src/style.css` connecting Cesium container, HUD overlay, ECharts drawer, and drag-and-drop log uploader.

- [ ] **Step 4: Run full project test suite and production build**

Run: `npm run test`
Run: `npm run build`
Expected: All tests pass, build succeeds with zero errors (Exit Code 0).

- [ ] **Step 5: Commit**

```bash
git add index.html src/ tests/ README.md
git commit -m "feat(app): assemble end-to-end Web 3D DJI Flight Log Viewer"
```
