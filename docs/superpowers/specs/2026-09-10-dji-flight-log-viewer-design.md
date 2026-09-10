# 基于 Web 的大疆行业无人机飞行日志三维查看系统 (DJI Flight Log 3D Viewer) 技术设计规范

- **状态**：已评审通过 (Draft -> Approved Design)
- **日期**：2026-09-10
- **目标机型**：DJI Pilot 2 / 行业巡检机型（M300 RTK / M350 RTK / M30 系列 / Mavic 3 行业版系列 M3E/M3T 等）
- **核心对标**：Flight Reader (flightreader.com)
- **部署定位**：独立 Web 门户 / 局域网系统，同时支持以微前端/SDK/WebView 形式植入桌面端系统（如 `3DTrackPlan`、`UAVFlightpathCreation`）

---

## 1. 系统架构与模块全景 (System Architecture)

系统采用模块解耦的高性能三层架构设计，确保核心引擎与前端 UI、宿主环境完全隔离。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          宿主环境层 (Host Platforms)                          │
│  - 独立 Web 部署 (SPA / 纯前端离线运行)                                      │
│  - Web GIS 平台 / 电力机巡数字化看板 (Iframe / WebComponent 接入)            │
│  - Unity 桌面端系统 (3DTrackPlan / UAVFlightpathCreation 通过 WebView 接入)   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ postMessage / JSON-RPC Bridge SDK
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                    Viewer Presentation & Interaction Layer                   │
│ ┌───────────────────────────┐ ┌────────────────────────┐ ┌────────────────┐ │
│ │ 3D Cesium Viewport        │ │ Telemetry Dashboard    │ │ Event Track    │ │
│ │ - 6-DOF 航机姿态平滑插值   │ │ - 仿生飞行 HUD 仪表盘   │ │ - 拍照关键帧   │ │
│ │ - 云台/相机视锥与足印投影  │ │ - 双电池电芯压差/温升   │ │ - 避障/风偏告警│ │
│ │ - WPML 实飞vs规划偏差渲染 │ │ - 飞控油门/响应时序图   │ │ - 异常时序标记 │ │
│ └─────────────┬─────────────┘ └───────────┬────────────┘ └───────┬────────┘ │
└───────────────┼───────────────────────────┼──────────────────────┼──────────┘
                │                           │                      │
┌───────────────▼───────────────────────────▼──────────────────────▼──────────┐
│                   State Machine & Data Controller (Core)                    │
│   - 时间轴主时钟管理 (Time Synchronization Clock: Play/Pause/Scrub/1x-10x)  │
│   - 空间索引与视锥几何计算 (Frustum Intersection & Footprint Solver)         │
│   - 轨迹空间偏差快速计算器 (WPML vs Actual KD-Tree / Nearest Point Matcher)  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ TypedArray / ArrayBuffer (零拷贝转移)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                  Offline Parser Layer (Web Worker + WASM)                   │
│   - dji-parser-wasm (Rust/WASM 编译): AES-128 帧解密、TXT v13/v14 逆向解包   │
│   - DAT 黑匣子二进制解析器                                                   │
│   - WPML (KMZ/KML) 航线规划解析器                                            │
│   - 纯本地运行，数据 0 上传，严守电网数据安全保密红线                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 离线解析引擎详细设计 (Parser Engine)

### 2.1 技术路线
- **语言选型**：Rust 编写解析内核，经 `wasm-pack` 编译为 WebAssembly (`.wasm`)。
- **并发机制**：独立运行在浏览器 `Web Worker` 中，主线程只负责渲染和 UI 响应，杜绝大文件解析引起的界面卡顿。
- **协议兼容范围**：
  - **DJI Pilot 2 加密 TXT (v13, v14)**：实现 AES-128-CBC 动态密钥派生解密与 Record Frame 解码。
  - **DJI WPML (KMZ)**：解包提取 `template.kml` 与 `waylines.wpml`，解析规划航点坐标、速度、云台动作、航点动作序列。
  - **DJI DAT (部分黑匣子格式)**：支持主板高频传感器原始时序数据读取。

### 2.2 抽取数据结构定义 (TypeScript Interface)

```typescript
export interface FlightRecordPackage {
  meta: {
    aircraftType: string;         // 如 "Matrice 350 RTK", "Mavic 3 Enterprise"
    aircraftSn: string;           // 机身序列号
    cameraSn?: string;            // 云台相机序列号
    batterySnList: string[];      // 电池序列号列表
    startTime: number;            // 毫秒时间戳
    durationMs: number;           // 总飞行时长
    totalDistance: number;        // 总航程 (米)
    maxAltitude: number;          // 最大海拔高 (米)
    homeLocation: [number, number, number]; // [经度, 纬度, 高度]
  };
  
  // 10Hz 时序遥测流 (密集采样，使用 TypedArray 优化内存)
  telemetry: {
    timestamps: Float64Array;     // 时间轴偏移量 (秒)
    longitudes: Float64Array;     // WGS84 经度
    latitudes: Float64Array;      // WGS84 纬度
    altitudes: Float32Array;      // 椭球高 (米)
    heights: Float32Array;        // 相对起飞高度 (米)
    pitch: Float32Array;          // 机体俯仰角 (-90° ~ 90°)
    roll: Float32Array;           // 机体横滚角 (-180° ~ 180°)
    yaw: Float32Array;            // 机体航向角 (0° ~ 360°)
    speeds: Float32Array;         // 对地合速度 (m/s)
    rtkStatus: Uint8Array;        // 0: None, 16: Single, 32: Float, 50: Fixed
    batteryPercents: Uint8Array;  // 电量百分比
    batteryVoltages: Float32Array;// 动力总电压
    maxCellVoltageDiff: Float32Array; // 最大单体电芯压差 (V)
    maxCellTemp: Float32Array;    // 最大电芯温度 (°C)
    gimbalPitch: Float32Array;    // 云台俯仰角
    gimbalYaw: Float32Array;      // 云台绝对航向角
  };

  // 离散事件流
  events: {
    photos: Array<{
      id: string;
      timestamp: number;
      index: number;
      position: [number, number, number];
      gimbalAngles: [number, number, number]; // [pitch, roll, yaw]
      thumbnailBase64?: string;
    }>;
    warnings: Array<{
      timestamp: number;
      level: 'info' | 'warning' | 'critical';
      code: number;
      message: string;
    }>;
  };
}
```

---

## 3. 三维 GIS 视景与机巡专属特性设计 (3D Spatiotemporal Engine)

### 3.1 视景基础设施
- **渲染基石**：CesiumJS（支持全球地形、天地图/影像底图离线瓦片、WGS84 空间基准）。
- **坐标系与高程基准**：
  - 严格采用 WGS84 经纬度及大地椭球高，内置 EGM96 / 85 国家高程基准面偏移转换工具，满足电力线路勘测与巡检规范。
- **机型 3D 姿态仿真**：
  - 支持 M300/M350、M30、M3E 等机型的 glTF/GLB 高仿真三维模型。
  - 基于真实机体四元数姿态矩阵每帧插值更新，机体螺旋桨转速随动力输出动态旋转。

### 3.2 云台视锥与空间地表投影 (Dynamic Camera Frustum)
1. **视锥几何构建**：
   - 依据云台实时俯仰角 $\theta_{pitch}$、航向角 $\psi_{yaw}$ 以及机载相机当前等效焦距对应的水平视场角（$HFOV$）和垂直视场角（$VFOV$），在机体坐标系下构建视锥四棱锥线框面。
2. **地形/地物相交足印 (Footprint Calculation)**：
   - 使用射线检测（Ray Casting）解算视锥 4 条主边缘射线及光轴射线与 Cesium 地表（或 3D Tiles 杆塔模型/树木点云）的交点。
   - 动态在地面生成半透明黄色投影多边形与中心十字光斑，实时呈现当前相机的照射靶区。

### 3.3 实飞与规划航迹（WPML）空间偏差比对算法
1. **时空空间对齐**：
   - 加载 DJI WPML (`waylines.wpml`) 解析出三维规划折线段 $L = \{P_1, P_2, \dots, P_n\}$。
2. **空间最近邻点距离解算**：
   - 对实飞采样的每个点 $Q(t)$，在空间中投影到对应规划折线段上，得到投影点 $P_{proj}$，计算欧氏距离偏差 $\Delta D = \| Q(t) - P_{proj} \|$。
   - 分解为横向风偏距离 $\Delta H_{lateral}$ 与高程航高误差 $\Delta Z$。
3. **分级动态渲染**：
   - **绿色 ($<0.5m$)**：航迹精准，处于安全通道中心。
   - **黄色 ($0.5m \sim 1.0m$)**：轻微风偏或 RTK 浮动，需关注。
   - **红色 ($>1.0m$)**：严重偏离规划走廊，触发安全红线警示。

### 3.4 多源电网数据底座支持
- 支持加载输电通道 **3D Tiles 点云（LAS 转换）**。
- 支持加载变电站/杆塔 **GIM / BIM 转换后的 3D 几何实体**，辅助评估无人机与高压带电导线、避雷线之间的净空距离。

---

## 4. 多源时空联动看板与 HUD 设计 (Telemetry Dashboard)

### 4.1 驾驶态势 HUD 仪表
- **人工地平仪 (Artificial Horizon)**：呈现俯仰梯形刻度、横滚指针。
- **航速/升降指示**：左侧对地航速动态刻度带，右侧气压高/椭球高动态带。
- **航向刻度条 (Heading Tape)**：顶部刻度实时显示当前机头指向（0~360°），内附 Home 点与北向符号。
- **行业 RTK 与信号徽标**：右上角醒目标记 `RTK: FIXED` (绿)、`FLOAT` (黄)、`NONE` (红)，卫星颗数、电池电量比。

### 4.2 ECharts 多轴同步联动
- **电池组专属工况分析**：
  - 双电池电压曲线、放电电流曲线。
  - **最大电芯压差（$\Delta V$）曲线**：阈值预警红线设为 $0.05V$，超过阈值区间以背景红区渲染。
  - **电芯温度曲线**：最高温与最低温包络带。
- **飞控杆量 vs 姿态响应曲线**：
  - 遥控手柄 4 通道量（T/A/E/R）与姿态实际俯仰角/对地速度的同屏叠图，便于复盘是否有“打杆过度”或“强风阻力逆风飞行”。

### 4.3 时序事件轨与快照联动
- 底部时间轴集成 **Event Track**：
  - 📷 拍照点：图标标记，悬浮预览缩略图，点击机位瞬时对准并重现拍照瞬间的云台姿态与视锥。
  - ⚠️ 告警点：告警级别图标，点击跳转并展示告警原因（如“检测到机身强风，已自动减速”、“前向避障传感器触发制动”）。

---

## 5. 插件化嵌入与通信 SDK 规范 (Integration SDK)

### 5.1 协议规范与调用接口

```typescript
export interface HostToViewerProtocol {
  // 载入数据
  'LOAD_FLIGHT_LOG': { buffer: ArrayBuffer; fileName: string };
  'LOAD_PLANNED_ROUTE': { kmzBuffer: ArrayBuffer };
  'LOAD_CONTEXT_3DTILES': { url: string; options?: object };
  
  // 视景与控制
  'SEEK_TIME': { timestampMs: number };
  'SET_PLAYBACK_STATE': { isPlaying: boolean; speedRate: number }; // 0.5, 1, 2, 5, 10
  'SET_CAMERA_VIEW_MODE': { mode: 'follow' | 'free' | 'fpv_gimbal' | 'top_down' };
  'FOCUS_WAYPOINT': { waypointIndex: number };
}

export interface ViewerToHostProtocol {
  'VIEWER_READY': { version: string };
  'TIME_UPDATE': { currentTimeMs: number; telemetryFrame: object };
  'PHOTO_SELECTED': { photoId: string; index: number; lat: number; lon: number };
  'DEVIATION_ALERT': { point: [number, number, number]; deviation: number };
  'PARSER_ERROR': { error: string };
}
```

### 5.2 Unity 桌面端（3DTrackPlan / UAVFlightpathCreation）接入模式
- **承载机制**：Unity 使用 `Vuplex 3D WebView` 插件在场景 UI Canvas 中渲染本 Web 查看器（以本地 `file://` 或 `http://127.0.0.1:port` 载入）。
- **C# 桥接代码模式**：
  ```csharp
  // Unity C# 示例
  IWebView webView;
  
  // 1. 发送日志二进制给 Web 端
  byte[] logBytes = File.ReadAllBytes("DJI_FlightLog.txt");
  string base64 = Convert.ToBase64String(logBytes);
  webView.PostMessage(JsonUtility.ToJson(new {
      action = "LOAD_FLIGHT_LOG",
      payload = new { base64Data = base64, fileName = "flight.txt" }
  }));
  
  // 2. 监听 Web 端选中的航点/拍照点
  webView.MessageEmitted += (sender, eventArgs) => {
      var msg = JsonUtility.FromJson<ViewerMessage>(eventArgs.Value);
      if (msg.action == "PHOTO_SELECTED") {
          HighlightWaypointInUnity(msg.payload.index);
      }
  };
  ```

---

## 6. 性能目标与质量指标 (Quality Benchmarks)

| 场景指标 | 性能目标 |
| :--- | :--- |
| **解析速度** | 50MB 纯机巡 TXT 日志（约 15~20 万帧遥测），WASM 解密耗时 $\le 2.5$ 秒 |
| **内存占用** | 轨迹使用 Float32Array 紧凑存储，全过程网页常驻内存 $\le 200MB$ |
| **三维帧率** | 轨迹回放 + 6-DOF 姿态 + 视锥投影全开状态下，Cesium 稳定保持在 60 FPS |
| **时空同步** | 图表游标、3D 飞机位置与驾驶 HUD 仪表刷新延迟 $\le 16ms$（单帧内完成对齐） |

---

## 7. 实施计划与里程碑建议

- **Phase 1: 离线解析引擎与核心数据流 (WASM + TypedArray)**
  - 实现 Rust/Wasm 加密日志解析与 WPML 航线提取。
  - 完成解析结果内存模型与端到端解密正确性校验。
- **Phase 2: CesiumJS 4D 轨迹视景与机巡视锥投影**
  - 构建 WGS84 4D 动态轨迹、6-DOF 航机模型平滑插值。
  - 实现相机动态视锥及地面相交多边形投影。
  - 实现 WPML 规划折线 vs 实际轨迹空间欧氏距离偏差计算与分级染色。
- **Phase 3: 遥测看板、HUD 与事件时序联动**
  - 接入仿生飞行 HUD 仪表与双电池压差 ECharts 联动。
  - 打造拍照帧、安全告警时序标注轨。
- **Phase 4: 插件化 SDK 与 Unity (3DTrackPlan) 桥接联调**
  - 封装标准 `@flight-viewer/embed` postMessage SDK。
  - 编写与 Unity 3DTrackPlan C# 桥接示范工程与本地联调。
