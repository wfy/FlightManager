/**
 * Flight HUD Instruments (Head-Up Display)
 *
 * High-performance 100% offline HTML5 Canvas-based avionics PFD:
 * 1. Artificial Horizon (Attitude Director Indicator, Pitch Ladder, Roll Arc & Pointer)
 * 2. Moving Speed Tape (Vertical Ground Speed ruler & readout window)
 * 3. Moving Altitude Tape (Vertical ASL/AGL ruler & readout window)
 * 4. Heading Compass Ribbon (Horizontal 0-360° ribbon with cardinal points)
 * 5. RTK & Battery System Status Badges
 */

import type { InterpolatedTelemetry } from '../viewport/trajectoryLayer';

export interface HUDOptions {
  theme?: 'aviation-green' | 'cyan' | 'dark';
  showSpeedTape?: boolean;
  showAltitudeTape?: boolean;
  showHeadingRibbon?: boolean;
  showAttitudeIndicator?: boolean;
  showStatusBadges?: boolean;
  altitudeSource?: 'altitudes' | 'heights';
  reticleColor?: string;
  horizonColor?: string;
  skyGroundShading?: boolean;
}

export class HUDInstruments {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private width = 480;
  private height = 360;
  private dpr = 1;
  private options: Required<HUDOptions>;
  private lastTelemetry: InterpolatedTelemetry | null = null;

  constructor(options: HUDOptions = {}) {
    this.options = {
      theme: options.theme ?? 'aviation-green',
      showSpeedTape: options.showSpeedTape ?? true,
      showAltitudeTape: options.showAltitudeTape ?? true,
      showHeadingRibbon: options.showHeadingRibbon ?? true,
      showAttitudeIndicator: options.showAttitudeIndicator ?? true,
      showStatusBadges: options.showStatusBadges ?? true,
      altitudeSource: options.altitudeSource ?? 'altitudes',
      reticleColor: options.reticleColor ?? '#00E5FF',
      horizonColor: options.horizonColor ?? '#00FF66',
      skyGroundShading: options.skyGroundShading ?? true,
    };
  }

  /**
   * Attaches HUD renderer to an HTML5 Canvas element.
   */
  public attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;

    const w = canvas.clientWidth || canvas.width || 480;
    const h = canvas.clientHeight || canvas.height || 360;
    this.resize(w, h);
  }

  /**
   * Resizes canvas buffer with HiDPI / Retina devicePixelRatio support.
   */
  public resize(width: number, height: number): void {
    this.width = Math.max(100, width);
    this.height = Math.max(100, height);

    if (this.canvas) {
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      if (this.canvas.style) {
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
      }
    }
  }

  /**
   * Renders a complete HUD frame based on current interpolated flight telemetry.
   */
  public render(telemetry: InterpolatedTelemetry | null): void {
    this.lastTelemetry = telemetry;
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Clear canvas
    ctx.clearRect(0, 0, this.width, this.height);

    // Background semi-transparent cockpit shade
    ctx.fillStyle = 'rgba(8, 14, 21, 0.45)';
    ctx.fillRect(0, 0, this.width, this.height);

    const pitch = telemetry?.pitch ?? 0;
    const roll = telemetry?.roll ?? 0;
    const yaw = telemetry?.yaw ?? 0;
    const speed = telemetry?.speed ?? 0;
    const alt = this.options.altitudeSource === 'heights'
      ? (telemetry?.height ?? 0)
      : (telemetry?.altitude ?? 0);
    const rtk = telemetry?.rtkStatus ?? 0;
    const batteryPct = telemetry?.batteryPercent ?? 100;
    const batteryVolt = telemetry?.batteryVoltage ?? 0;
    const gimbalPitch = telemetry?.gimbalPitch ?? 0;

    // 1. Artificial Horizon (Center)
    if (this.options.showAttitudeIndicator) {
      this.drawArtificialHorizon(ctx, pitch, roll);
    }

    // 2. Speed Tape (Left)
    if (this.options.showSpeedTape) {
      this.drawSpeedTape(ctx, speed);
    }

    // 3. Altitude Tape (Right)
    if (this.options.showAltitudeTape) {
      this.drawAltitudeTape(ctx, alt);
    }

    // 4. Heading Ribbon (Top)
    if (this.options.showHeadingRibbon) {
      this.drawHeadingRibbon(ctx, yaw);
    }

    // 5. Status Badges (RTK, Battery, Gimbal)
    if (this.options.showStatusBadges) {
      this.drawStatusBadges(ctx, rtk, batteryPct, batteryVolt, gimbalPitch);
    }

    ctx.restore();
  }

  /**
   * Renders the Artificial Horizon, Pitch Ladder, and Roll Pointer.
   */
  private drawArtificialHorizon(ctx: CanvasRenderingContext2D, pitch: number, roll: number): void {
    const cx = this.width / 2;
    const cy = this.height / 2 + 10;
    const radius = Math.min(this.width, this.height) * 0.38;

    ctx.save();
    // Clip to central circular instrument window
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(cx, cy);
    // In aviation HUD, roll rotates the artificial horizon in reverse of aircraft bank (-roll)
    ctx.rotate((-roll * Math.PI) / 180);

    // Pitch displacement: ~4 pixels per degree
    const pxPerDegree = 4.5;
    const pitchOffset = pitch * pxPerDegree;

    // Optional Sky / Ground subtle color fill
    if (this.options.skyGroundShading) {
      ctx.fillStyle = 'rgba(0, 150, 255, 0.08)'; // sky
      ctx.fillRect(-radius * 2, -radius * 2 + pitchOffset, radius * 4, radius * 2);

      ctx.fillStyle = 'rgba(160, 100, 30, 0.08)'; // ground
      ctx.fillRect(-radius * 2, pitchOffset, radius * 4, radius * 2);
    }

    // Horizon Center Line
    ctx.strokeStyle = this.options.horizonColor;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(-radius * 0.85, pitchOffset);
    ctx.lineTo(radius * 0.85, pitchOffset);
    ctx.stroke();

    // Pitch ladder rungs (+/- 5, 10, 15, 20, 25, 30...)
    ctx.lineWidth = 1.5;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = -60; deg <= 60; deg += 5) {
      if (deg === 0) continue;

      const y = pitchOffset - deg * pxPerDegree;
      if (Math.abs(y) > radius * 0.95) continue;

      const isMajor = deg % 10 === 0;
      const halfW = isMajor ? radius * 0.28 : radius * 0.16;
      const tickH = isMajor ? 5 : 3;

      ctx.beginPath();
      if (deg > 0) {
        // Positive pitch: solid rungs with downward-pointing ticks
        ctx.setLineDash([]);
        ctx.strokeStyle = this.options.horizonColor;

        ctx.moveTo(-halfW, y);
        ctx.lineTo(-halfW, y + tickH);
        ctx.moveTo(-halfW, y);
        ctx.lineTo(-halfW * 0.35, y);

        ctx.moveTo(halfW * 0.35, y);
        ctx.lineTo(halfW, y);
        ctx.lineTo(halfW, y + tickH);
      } else {
        // Negative pitch: dashed rungs with upward-pointing ticks
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#FFB300';

        ctx.moveTo(-halfW, y);
        ctx.lineTo(-halfW, y - tickH);
        ctx.moveTo(-halfW, y);
        ctx.lineTo(-halfW * 0.35, y);

        ctx.moveTo(halfW * 0.35, y);
        ctx.lineTo(halfW, y);
        ctx.lineTo(halfW, y - tickH);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (isMajor) {
        ctx.fillStyle = deg > 0 ? this.options.horizonColor : '#FFB300';
        ctx.fillText(`${Math.abs(deg)}`, -halfW - 12, y);
        ctx.fillText(`${Math.abs(deg)}`, halfW + 12, y);
      }
    }

    ctx.restore();

    // Fixed Aircraft Boresight Reference Symbol in Center
    ctx.save();
    ctx.strokeStyle = this.options.reticleColor;
    ctx.fillStyle = this.options.reticleColor;
    ctx.lineWidth = 2.0;

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Left & Right Wings
    const wingLen = 22;
    const wingGap = 12;
    ctx.beginPath();
    // Left wing
    ctx.moveTo(cx - wingGap - wingLen, cy);
    ctx.lineTo(cx - wingGap, cy);
    ctx.lineTo(cx - wingGap, cy + 6);
    // Right wing
    ctx.moveTo(cx + wingGap + wingLen, cy);
    ctx.lineTo(cx + wingGap, cy);
    ctx.lineTo(cx + wingGap, cy + 6);
    ctx.stroke();

    // Roll Arc & Pointer at top of horizon
    const arcRadius = radius * 0.92;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;

    // Arc from -60 to +60 deg
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, (-150 * Math.PI) / 180, (-30 * Math.PI) / 180);
    ctx.stroke();

    // Roll scale tick marks
    const rollAngles = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
    for (const a of rollAngles) {
      const rad = ((-90 + a) * Math.PI) / 180;
      const len = Math.abs(a) === 30 || Math.abs(a) === 60 || a === 0 ? 8 : 4;
      const r1 = arcRadius;
      const r2 = arcRadius - len;
      ctx.beginPath();
      ctx.moveTo(cx + r1 * Math.cos(rad), cy + r1 * Math.sin(rad));
      ctx.lineTo(cx + r2 * Math.cos(rad), cy + r2 * Math.sin(rad));
      ctx.stroke();
    }

    // Roll pointer (indicating current roll angle)
    const rollRad = ((-90 - roll) * Math.PI) / 180;
    const px = cx + arcRadius * Math.cos(rollRad);
    const py = cy + arcRadius * Math.sin(rollRad);

    ctx.fillStyle = this.options.reticleColor;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(
      px + 7 * Math.cos(rollRad + 2.5),
      py + 7 * Math.sin(rollRad + 2.5)
    );
    ctx.lineTo(
      px + 7 * Math.cos(rollRad - 2.5),
      py + 7 * Math.sin(rollRad - 2.5)
    );
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  /**
   * Moving Speed Tape (Left side).
   */
  private drawSpeedTape(ctx: CanvasRenderingContext2D, currentSpeed: number): void {
    const tapeW = 54;
    const tapeH = this.height * 0.65;
    const tapeX = 14;
    const tapeY = (this.height - tapeH) / 2 + 10;
    const cy = tapeY + tapeH / 2;

    ctx.save();
    // Background tape slot
    ctx.fillStyle = 'rgba(10, 20, 30, 0.6)';
    ctx.fillRect(tapeX, tapeY, tapeW, tapeH);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tapeX, tapeY, tapeW, tapeH);

    // Clip to tape area
    ctx.beginPath();
    ctx.rect(tapeX, tapeY, tapeW, tapeH);
    ctx.clip();

    // Scale: 12 px per 1 m/s
    const pxPerUnit = 14;
    const minSpeed = Math.max(0, currentSpeed - tapeH / (2 * pxPerUnit));
    const maxSpeed = currentSpeed + tapeH / (2 * pxPerUnit);

    const startVal = Math.floor(minSpeed);
    const endVal = Math.ceil(maxSpeed);

    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let v = startVal; v <= endVal; v++) {
      if (v < 0) continue;
      const y = cy - (v - currentSpeed) * pxPerUnit;
      const isMajor = v % 5 === 0;

      ctx.strokeStyle = isMajor ? '#00FF66' : 'rgba(0, 255, 102, 0.5)';
      ctx.lineWidth = isMajor ? 1.5 : 1;

      ctx.beginPath();
      const tickLen = isMajor ? 14 : 7;
      ctx.moveTo(tapeX + tapeW, y);
      ctx.lineTo(tapeX + tapeW - tickLen, y);
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = '#E0E6ED';
        ctx.fillText(`${v}`, tapeX + tapeW - 16, y);
      }
    }

    ctx.restore();

    // Readout Window in Center
    ctx.save();
    const boxW = 58;
    const boxH = 22;
    const boxX = tapeX;
    const boxY = cy - boxH / 2;

    ctx.fillStyle = '#0F1A24';
    ctx.strokeStyle = '#00FF66';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    // Pointer chevron pointing to tape
    ctx.fillStyle = '#00FF66';
    ctx.beginPath();
    ctx.moveTo(boxX + boxW, cy);
    ctx.lineTo(boxX + boxW + 5, cy - 4);
    ctx.lineTo(boxX + boxW + 5, cy + 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#00FF66';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${currentSpeed.toFixed(1)}`, boxX + boxW / 2, cy);

    // Label on top
    ctx.fillStyle = '#00E5FF';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SPD m/s', tapeX + tapeW / 2, tapeY - 6);

    ctx.restore();
  }

  /**
   * Moving Altitude Tape (Right side).
   */
  private drawAltitudeTape(ctx: CanvasRenderingContext2D, currentAlt: number): void {
    const tapeW = 58;
    const tapeH = this.height * 0.65;
    const tapeX = this.width - tapeW - 14;
    const tapeY = (this.height - tapeH) / 2 + 10;
    const cy = tapeY + tapeH / 2;

    ctx.save();
    // Background tape slot
    ctx.fillStyle = 'rgba(10, 20, 30, 0.6)';
    ctx.fillRect(tapeX, tapeY, tapeW, tapeH);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tapeX, tapeY, tapeW, tapeH);

    // Clip to tape area
    ctx.beginPath();
    ctx.rect(tapeX, tapeY, tapeW, tapeH);
    ctx.clip();

    // Scale: 3.5 px per meter
    const pxPerUnit = 3.5;
    const minAlt = currentAlt - tapeH / (2 * pxPerUnit);
    const maxAlt = currentAlt + tapeH / (2 * pxPerUnit);

    const startVal = Math.floor(minAlt / 5) * 5;
    const endVal = Math.ceil(maxAlt / 5) * 5;

    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let v = startVal; v <= endVal; v += 5) {
      const y = cy - (v - currentAlt) * pxPerUnit;
      const isMajor = v % 20 === 0;

      ctx.strokeStyle = isMajor ? '#00FF66' : 'rgba(0, 255, 102, 0.5)';
      ctx.lineWidth = isMajor ? 1.5 : 1;

      ctx.beginPath();
      const tickLen = isMajor ? 14 : 7;
      ctx.moveTo(tapeX, y);
      ctx.lineTo(tapeX + tickLen, y);
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = '#E0E6ED';
        ctx.fillText(`${v}`, tapeX + 16, y);
      }
    }

    ctx.restore();

    // Readout Window in Center
    ctx.save();
    const boxW = 62;
    const boxH = 22;
    const boxX = tapeX;
    const boxY = cy - boxH / 2;

    ctx.fillStyle = '#0F1A24';
    ctx.strokeStyle = '#00FF66';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    // Pointer chevron pointing to tape
    ctx.fillStyle = '#00FF66';
    ctx.beginPath();
    ctx.moveTo(boxX, cy);
    ctx.lineTo(boxX - 5, cy - 4);
    ctx.lineTo(boxX - 5, cy + 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#00FF66';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${currentAlt.toFixed(1)}`, boxX + boxW / 2, cy);

    // Label on top
    ctx.fillStyle = '#00E5FF';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    const altLabel = this.options.altitudeSource === 'heights' ? 'HGT m' : 'ALT m';
    ctx.fillText(altLabel, tapeX + tapeW / 2, tapeY - 6);

    ctx.restore();
  }

  /**
   * Horizontal Heading Compass Ribbon (Top).
   */
  private drawHeadingRibbon(ctx: CanvasRenderingContext2D, currentYaw: number): void {
    const ribbonW = this.width * 0.55;
    const ribbonH = 30;
    const ribbonX = (this.width - ribbonW) / 2;
    const ribbonY = 12;
    const cx = ribbonX + ribbonW / 2;

    // Normalize yaw to [0, 360)
    let heading = currentYaw % 360;
    if (heading < 0) heading += 360;

    ctx.save();
    // Background ribbon slot
    ctx.fillStyle = 'rgba(10, 20, 30, 0.6)';
    ctx.fillRect(ribbonX, ribbonY, ribbonW, ribbonH);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ribbonX, ribbonY, ribbonW, ribbonH);

    // Clip to ribbon area
    ctx.beginPath();
    ctx.rect(ribbonX, ribbonY, ribbonW, ribbonH);
    ctx.clip();

    // Scale: 3.2 px per degree
    const pxPerDegree = 3.2;

    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let deg = -180; deg <= 540; deg += 5) {
      const diff = deg - heading;
      const x = cx + diff * pxPerDegree;
      if (x < ribbonX - 20 || x > ribbonX + ribbonW + 20) continue;

      let normDeg = Math.round(deg) % 360;
      if (normDeg < 0) normDeg += 360;

      const isCardinal = normDeg === 0 || normDeg === 90 || normDeg === 180 || normDeg === 270;
      const isMajor = normDeg % 30 === 0;

      ctx.strokeStyle = isCardinal ? '#00E5FF' : isMajor ? '#00FF66' : 'rgba(0, 255, 102, 0.4)';
      ctx.lineWidth = isCardinal ? 2 : isMajor ? 1.5 : 1;

      ctx.beginPath();
      const tickH = isCardinal ? 10 : isMajor ? 7 : 4;
      ctx.moveTo(x, ribbonY + ribbonH);
      ctx.lineTo(x, ribbonY + ribbonH - tickH);
      ctx.stroke();

      if (isCardinal || isMajor) {
        let label = '';
        if (normDeg === 0) label = 'N';
        else if (normDeg === 90) label = 'E';
        else if (normDeg === 180) label = 'S';
        else if (normDeg === 270) label = 'W';
        else label = `${normDeg.toString().padStart(3, '0')}`;

        ctx.fillStyle = isCardinal ? '#00E5FF' : '#E0E6ED';
        ctx.fillText(label, x, ribbonY + 3);
      }
    }

    ctx.restore();

    // Center Heading Cursor & Readout Window
    ctx.save();
    const boxW = 46;
    const boxH = 18;
    const boxX = cx - boxW / 2;
    const boxY = ribbonY + ribbonH + 2;

    ctx.fillStyle = '#0F1A24';
    ctx.strokeStyle = '#00FF66';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(boxX, boxY, boxW, boxH);
    ctx.fillRect(boxX, boxY, boxW, boxH);

    // Indicator triangle at top of box
    ctx.fillStyle = '#00FF66';
    ctx.beginPath();
    ctx.moveTo(cx, ribbonY + ribbonH);
    ctx.lineTo(cx - 4, boxY);
    ctx.lineTo(cx + 4, boxY);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#00FF66';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(heading).toString().padStart(3, '0')}°`, cx, boxY + boxH / 2);

    ctx.restore();
  }

  /**
   * Status Badges (RTK, Battery, Gimbal pitch angle).
   */
  private drawStatusBadges(
    ctx: CanvasRenderingContext2D,
    rtkStatus: number,
    batteryPercent: number,
    batteryVoltage: number,
    gimbalPitch: number
  ): void {
    ctx.save();
    ctx.font = 'bold 10px monospace';
    ctx.textBaseline = 'middle';

    // 1. RTK Badge (Top Left, above speed tape)
    let rtkText = 'RTK: NONE';
    let rtkBg = 'rgba(244, 67, 54, 0.25)';
    let rtkBorder = '#F44336';
    let rtkColor = '#FF8A80';

    if (rtkStatus === 2) {
      rtkText = 'RTK: FIXED';
      rtkBg = 'rgba(0, 230, 118, 0.2)';
      rtkBorder = '#00E676';
      rtkColor = '#69F0AE';
    } else if (rtkStatus === 1) {
      rtkText = 'RTK: FLOAT';
      rtkBg = 'rgba(255, 179, 0, 0.2)';
      rtkBorder = '#FFB300';
      rtkColor = '#FFE082';
    }

    const badgeW = 78;
    const badgeH = 18;
    const badgeX = 14;
    const badgeY = 12;

    ctx.fillStyle = rtkBg;
    ctx.strokeStyle = rtkBorder;
    ctx.lineWidth = 1;
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
    ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

    ctx.fillStyle = rtkColor;
    ctx.textAlign = 'center';
    ctx.fillText(rtkText, badgeX + badgeW / 2, badgeY + badgeH / 2);

    // 2. Battery Badge (Top Right, above altitude tape)
    const batW = 90;
    const batH = 18;
    const batX = this.width - batW - 14;
    const batY = 12;

    let batColor = '#00E676';
    let batBg = 'rgba(0, 230, 118, 0.2)';
    let batBorder = '#00E676';

    if (batteryPercent <= 15) {
      batColor = '#FF5252';
      batBg = 'rgba(255, 23, 68, 0.25)';
      batBorder = '#FF1744';
    } else if (batteryPercent <= 30) {
      batColor = '#FFD740';
      batBg = 'rgba(255, 171, 0, 0.2)';
      batBorder = '#FFAB00';
    }

    ctx.fillStyle = batBg;
    ctx.strokeStyle = batBorder;
    ctx.fillRect(batX, batY, batW, batH);
    ctx.strokeRect(batX, batY, batW, batH);

    ctx.fillStyle = batColor;
    const voltStr = batteryVoltage > 0 ? `${batteryVoltage.toFixed(1)}V` : '';
    ctx.fillText(`⚡ ${batteryPercent}% ${voltStr}`.trim(), batX + batW / 2, batY + batH / 2);

    // 3. Gimbal Pitch (Bottom Center)
    const gimW = 96;
    const gimH = 18;
    const gimX = (this.width - gimW) / 2;
    const gimY = this.height - gimH - 8;

    ctx.fillStyle = 'rgba(10, 20, 30, 0.6)';
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
    ctx.fillRect(gimX, gimY, gimW, gimH);
    ctx.strokeRect(gimX, gimY, gimW, gimH);

    ctx.fillStyle = '#00E5FF';
    ctx.fillText(`GIMBAL ${gimbalPitch.toFixed(1)}°`, gimX + gimW / 2, gimY + gimH / 2);

    ctx.restore();
  }

  /**
   * Returns current attached canvas or null.
   */
  public getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /**
   * Returns the last rendered telemetry frame.
   */
  public getLastTelemetry(): InterpolatedTelemetry | null {
    return this.lastTelemetry;
  }

  /**
   * Cleanly destroys HUD references and contexts.
   */
  public destroy(): void {
    if (this.canvas && this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.canvas = null;
    this.ctx = null;
    this.lastTelemetry = null;
  }
}
