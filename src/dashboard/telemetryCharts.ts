/**
 * Telemetry Data Extractors and ECharts Multi-Axis Option Builders
 *
 * 100% Offline computation for:
 * 1. Battery cell voltage difference anomaly detection and thermal analysis
 * 2. Multi-channel battery series extraction for high-rate flight logging
 * 3. ECharts options generator for multi-grid telemetry dashboards
 * 4. Bidirectional time cursor synchronization
 */

import type { TelemetryStream } from '../core/types';

export interface CellVoltageAnomaly {
  index: number;
  timestamp: number;
  timeSec: number;
  voltageDiff: number;
  threshold: number;
  batteryPercent?: number;
  batteryVoltage?: number;
  maxCellTemp?: number;
}

export interface BatterySeriesData {
  timestamps: number[];
  timeSeconds: number[];
  percents: number[];
  voltages: number[];
  maxCellDiffs: number[];
  temperatures: number[];
  anomalies: CellVoltageAnomaly[];
  stats: {
    maxDiff: number;
    avgDiff: number;
    minVoltage: number;
    maxVoltage: number;
    maxTemp: number;
    anomalyCount: number;
  };
}

export interface TelemetryChartConfig {
  theme?: 'dark' | 'light';
  thresholdVolts?: number;
  showDataZoom?: boolean;
  type?: 'combined' | 'battery' | 'dynamics' | 'attitude';
}

/**
 * Detects abnormal cell voltage difference exceeding the safety threshold (default: 0.05V).
 * DJI standard practice: cell delta > 50mV indicates battery degradation or high cell resistance.
 */
export function detectAbnormalCellVoltage(
  telemetry: TelemetryStream,
  thresholdVolts = 0.05
): CellVoltageAnomaly[] {
  const anomalies: CellVoltageAnomaly[] = [];
  if (!telemetry || !telemetry.maxCellVoltageDiff || telemetry.maxCellVoltageDiff.length === 0) {
    return anomalies;
  }

  const length = telemetry.maxCellVoltageDiff.length;
  const t0 = telemetry.timestamps.length > 0 ? telemetry.timestamps[0] : 0;

  for (let i = 0; i < length; i++) {
    const diff = telemetry.maxCellVoltageDiff[i];
    if (diff > thresholdVolts) {
      const ts = telemetry.timestamps[i] ?? 0;
      const hasTs = Boolean(telemetry.timestamps && telemetry.timestamps.length > 0);
      const timeSec = hasTs ? Number(((ts - t0) / 1000).toFixed(3)) : i;

      anomalies.push({
        index: i,
        timestamp: ts,
        timeSec,
        voltageDiff: diff,
        threshold: thresholdVolts,
        batteryPercent: telemetry.batteryPercents ? telemetry.batteryPercents[i] : undefined,
        batteryVoltage: telemetry.batteryVoltages ? telemetry.batteryVoltages[i] : undefined,
        maxCellTemp: telemetry.maxCellTemp ? telemetry.maxCellTemp[i] : undefined,
      });
    }
  }

  return anomalies;
}

/**
 * Extracts continuous battery telemetry series suitable for ECharts or timeline rendering.
 */
export function extractBatterySeries(
  telemetry: TelemetryStream,
  thresholdVolts = 0.05
): BatterySeriesData {
  const length = telemetry.timestamps ? telemetry.timestamps.length : 0;
  const timestamps: number[] = new Array(length);
  const timeSeconds: number[] = new Array(length);
  const percents: number[] = new Array(length);
  const voltages: number[] = new Array(length);
  const maxCellDiffs: number[] = new Array(length);
  const temperatures: number[] = new Array(length);

  const t0 = length > 0 ? telemetry.timestamps[0] : 0;

  let maxDiff = 0;
  let sumDiff = 0;
  let minVoltage = Infinity;
  let maxVoltage = -Infinity;
  let maxTemp = -Infinity;

  for (let i = 0; i < length; i++) {
    const ts = telemetry.timestamps[i];
    timestamps[i] = ts;
    timeSeconds[i] = length > 0 ? Number(((ts - t0) / 1000).toFixed(3)) : i;

    const pct = telemetry.batteryPercents ? telemetry.batteryPercents[i] : 0;
    percents[i] = pct;

    const volt = telemetry.batteryVoltages ? telemetry.batteryVoltages[i] : 0;
    voltages[i] = Number(volt.toFixed(2));
    if (volt < minVoltage) minVoltage = volt;
    if (volt > maxVoltage) maxVoltage = volt;

    const diff = telemetry.maxCellVoltageDiff ? telemetry.maxCellVoltageDiff[i] : 0;
    maxCellDiffs[i] = Number(diff.toFixed(3));
    if (diff > maxDiff) maxDiff = diff;
    sumDiff += diff;

    const temp = telemetry.maxCellTemp ? telemetry.maxCellTemp[i] : 0;
    temperatures[i] = temp;
    if (temp > maxTemp) maxTemp = temp;
  }

  if (minVoltage === Infinity) minVoltage = 0;
  if (maxVoltage === -Infinity) maxVoltage = 0;
  if (maxTemp === -Infinity) maxTemp = 0;

  const anomalies = detectAbnormalCellVoltage(telemetry, thresholdVolts);

  return {
    timestamps,
    timeSeconds,
    percents,
    voltages,
    maxCellDiffs,
    temperatures,
    anomalies,
    stats: {
      maxDiff,
      avgDiff: length > 0 ? sumDiff / length : 0,
      minVoltage,
      maxVoltage,
      maxTemp,
      anomalyCount: anomalies.length,
    },
  };
}

/**
 * Builds ECharts options for Battery Health (Voltage, Percent, Max Cell Diff, Temperature).
 */
export function buildBatteryChartOptions(
  telemetry: TelemetryStream,
  config: TelemetryChartConfig = {}
): Record<string, any> {
  const threshold = config.thresholdVolts ?? 0.05;
  const isDark = config.theme !== 'light';
  const data = extractBatterySeries(telemetry, threshold);

  const textColor = isDark ? '#E0E6ED' : '#333333';
  const splitLineColor = isDark ? 'rgba(255, 255, 255, 0.08)' : '#EBF0F5';

  return {
    backgroundColor: isDark ? '#0d1117' : '#ffffff',
    title: {
      text: '动力电池工况与电芯健康监控 (Battery Health & Cell Status)',
      left: 'center',
      top: 10,
      textStyle: { color: textColor, fontSize: 14, fontWeight: 'bold' },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', lineStyle: { color: '#00E5FF', width: 1.5 } },
    },
    legend: {
      bottom: 10,
      textStyle: { color: textColor },
      data: ['总电压 (V)', '电量 (%)', '最大电芯压差 (V)', '最高电芯温度 (°C)'],
    },
    grid: {
      left: '5%',
      right: '5%',
      top: 50,
      bottom: 50,
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: data.timeSeconds,
      boundaryGap: false,
      axisLabel: {
        color: textColor,
        formatter: (val: string | number) => `${Number(val).toFixed(1)}s`,
      },
      splitLine: { show: true, lineStyle: { color: splitLineColor } },
    },
    yAxis: [
      {
        type: 'value',
        name: '电压 (V) / 电量 (%)',
        position: 'left',
        axisLabel: { color: textColor },
        splitLine: { show: true, lineStyle: { color: splitLineColor } },
      },
      {
        type: 'value',
        name: '压差 (V) / 温度 (°C)',
        position: 'right',
        axisLabel: { color: textColor },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '总电压 (V)',
        type: 'line',
        yAxisIndex: 0,
        showSymbol: false,
        data: data.voltages,
        lineStyle: { color: '#00E5FF', width: 2 },
      },
      {
        name: '电量 (%)',
        type: 'line',
        yAxisIndex: 0,
        showSymbol: false,
        data: data.percents,
        lineStyle: { color: '#00E676', width: 2 },
      },
      {
        name: '最大电芯压差 (V)',
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        data: data.maxCellDiffs,
        lineStyle: { color: '#FF9100', width: 2 },
        markLine: {
          symbol: 'none',
          data: [
            {
              yAxis: threshold,
              name: '压差预警阈值',
              lineStyle: { color: '#FF1744', type: 'dashed', width: 1.5 },
              label: { formatter: `阈值 ${threshold}V`, position: 'insideEndTop' },
            },
          ],
        },
      },
      {
        name: '最高电芯温度 (°C)',
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        data: data.temperatures,
        lineStyle: { color: '#E040FB', width: 1.5 },
      },
    ],
  };
}

/**
 * Builds comprehensive ECharts options for flight telemetry.
 * Supports multi-grid synchronized layouts (combined) or dedicated individual views.
 */
export function buildTelemetryChartOptions(
  telemetry: TelemetryStream,
  config: TelemetryChartConfig = {}
): Record<string, any> {
  const type = config.type ?? 'combined';
  if (type === 'battery') {
    return buildBatteryChartOptions(telemetry, config);
  }

  const isDark = config.theme !== 'light';
  const textColor = isDark ? '#E0E6ED' : '#333333';
  const splitLineColor = isDark ? 'rgba(255, 255, 255, 0.08)' : '#EBF0F5';

  const len = telemetry.timestamps ? telemetry.timestamps.length : 0;
  const t0 = len > 0 ? telemetry.timestamps[0] : 0;
  const timeSeconds: number[] = new Array(len);
  const altitudes: number[] = new Array(len);
  const speeds: number[] = new Array(len);

  for (let i = 0; i < len; i++) {
    timeSeconds[i] = len > 0 ? Number(((telemetry.timestamps[i] - t0) / 1000).toFixed(3)) : i;
    altitudes[i] = telemetry.altitudes ? telemetry.altitudes[i] : 0;
    speeds[i] = telemetry.speeds ? telemetry.speeds[i] : 0;
  }

  const batteryData = extractBatterySeries(telemetry, config.thresholdVolts ?? 0.05);

  // Combined Multi-Grid Layout (Flight Dynamics & Battery Telemetry)
  return {
    backgroundColor: isDark ? '#0d1117' : '#ffffff',
    title: [
      {
        text: '飞行时序与动力电池多通道遥测看板 (Flight Dynamics & Battery Telemetry)',
        left: 'center',
        top: 8,
        textStyle: { color: textColor, fontSize: 14, fontWeight: 'bold' },
      },
    ],
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        lineStyle: { color: '#00E5FF', width: 1.5 },
      },
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
    },
    dataZoom: config.showDataZoom !== false ? [
      {
        type: 'inside',
        xAxisIndex: [0, 1],
      },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        bottom: 10,
        height: 18,
        borderColor: 'transparent',
        backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#F0F4F8',
      },
    ] : undefined,
    grid: [
      { left: '6%', right: '6%', top: '10%', height: '36%', containLabel: true },
      { left: '6%', right: '6%', top: '54%', height: '36%', containLabel: true },
    ],
    xAxis: [
      {
        gridIndex: 0,
        type: 'category',
        data: timeSeconds,
        boundaryGap: false,
        axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: splitLineColor } },
      },
      {
        gridIndex: 1,
        type: 'category',
        data: timeSeconds,
        boundaryGap: false,
        axisLabel: {
          color: textColor,
          formatter: (val: string | number) => `${Number(val).toFixed(1)}s`,
        },
        splitLine: { show: true, lineStyle: { color: splitLineColor } },
      },
    ],
    yAxis: [
      // Grid 0 (Dynamics: Altitude & Speed)
      {
        gridIndex: 0,
        type: 'value',
        name: '高度 (m)',
        position: 'left',
        axisLabel: { color: textColor },
        splitLine: { show: true, lineStyle: { color: splitLineColor } },
      },
      {
        gridIndex: 0,
        type: 'value',
        name: '速度 (m/s)',
        position: 'right',
        axisLabel: { color: textColor },
        splitLine: { show: false },
      },
      // Grid 1 (Battery: Voltage & Cell Diff)
      {
        gridIndex: 1,
        type: 'value',
        name: '总电压 (V)',
        position: 'left',
        axisLabel: { color: textColor },
        splitLine: { show: true, lineStyle: { color: splitLineColor } },
      },
      {
        gridIndex: 1,
        type: 'value',
        name: '电芯压差 (V)',
        position: 'right',
        axisLabel: { color: textColor },
        splitLine: { show: false },
      },
    ],
    series: [
      // Grid 0 series
      {
        name: '飞行高度 (m)',
        xAxisIndex: 0,
        yAxisIndex: 0,
        type: 'line',
        showSymbol: false,
        data: altitudes,
        lineStyle: { color: '#00E5FF', width: 2 },
      },
      {
        name: '飞行速度 (m/s)',
        xAxisIndex: 0,
        yAxisIndex: 1,
        type: 'line',
        showSymbol: false,
        data: speeds,
        lineStyle: { color: '#76FF03', width: 2 },
      },
      // Grid 1 series
      {
        name: '电池总电压 (V)',
        xAxisIndex: 1,
        yAxisIndex: 2,
        type: 'line',
        showSymbol: false,
        data: batteryData.voltages,
        lineStyle: { color: '#2979FF', width: 2 },
      },
      {
        name: '最大电芯压差 (V)',
        xAxisIndex: 1,
        yAxisIndex: 3,
        type: 'line',
        showSymbol: false,
        data: batteryData.maxCellDiffs,
        lineStyle: { color: '#FF1744', width: 2 },
        markLine: {
          symbol: 'none',
          data: [
            {
              yAxis: config.thresholdVolts ?? 0.05,
              name: '压差门限',
              lineStyle: { color: '#FF5252', type: 'dashed' },
            },
          ],
        },
      },
    ],
  };
}

/**
 * Synchronizes the ECharts time cursor with the current flight playback time.
 * Dispatches `showTip` action or sets axisPointer position safely without crashing.
 */
export function syncChartTime(chartInstance: any, timeSec: number, dataIndex?: number): boolean {
  if (!chartInstance) return false;

  try {
    if (typeof chartInstance.dispatchAction === 'function') {
      const targetIndex =
        dataIndex !== undefined && Number.isFinite(dataIndex)
          ? Math.max(0, dataIndex)
          : Math.max(0, Math.floor(timeSec * 10));

      chartInstance.dispatchAction({
        type: 'showTip',
        seriesIndex: 0,
        dataIndex: targetIndex,
      });
      return true;
    }
  } catch {
    // Graceful fallback for mock or destroyed chart instances
  }

  return false;
}
