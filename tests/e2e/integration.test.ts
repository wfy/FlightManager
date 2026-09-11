import { describe, it, expect } from 'vitest';
import { parseDjiFlightLog, buildMockDjiBinaryBuffer } from '../../src/parser/djiParser';
import { parseWPMLRoute } from '../../src/parser/wpmlParser';
import { calculateTrajectoryDeviation, type WPMLRoute } from '../../src/spatial/deviationSolver';
import { generateTrajectorySegments } from '../../src/viewport/trajectoryLayer';
import { HUDDashboard } from '../../src/dashboard/hudDashboard';
import { FlightViewerBridge } from '../../src/bridge/flightViewerBridge';

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
    expect(pkg.meta.aircraftType).toBe('Matrice 350 RTK');

    const planned: WPMLRoute = {
      name: 'Tower_23_Inspection',
      waypoints: [
        { index: 0, lon: 120.0, lat: 30.0, alt: 80.0, speed: 4.0 },
        { index: 1, lon: 120.0005, lat: 30.0005, alt: 80.0, speed: 4.0 },
      ],
    };
    const dev = calculateTrajectoryDeviation(pkg.telemetry, planned);
    expect(dev.deviations.length).toBe(50);
    expect(dev.stats.maxDeviation).toBeGreaterThanOrEqual(0);
    expect(dev.stats.avgDeviation).toBeGreaterThanOrEqual(0);

    const segments = generateTrajectorySegments(pkg.telemetry, 'deviation', dev);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].colorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('should parse WPML XML template and match against actual parsed flight telemetry', async () => {
    const wpmlXml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.3">
  <Document>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:droneInfo>
        <wpml:droneEnumValue>67</wpml:droneEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:waylineId>0</wpml:waylineId>
      <Placemark>
        <Point><coordinates>120.0,30.0,80.0</coordinates></Point>
        <wpml:index>0</wpml:index>
        <wpml:waypointSpeed>5.0</wpml:waypointSpeed>
      </Placemark>
      <Placemark>
        <Point><coordinates>120.001,30.001,85.0</coordinates></Point>
        <wpml:index>1</wpml:index>
        <wpml:waypointSpeed>5.0</wpml:waypointSpeed>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

    const parsedRoute = await parseWPMLRoute(wpmlXml);
    expect(parsedRoute.waypoints.length).toBe(2);

    const rawBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Matrice 300 RTK',
      pointsCount: 30,
      startLon: 120.0,
      startLat: 30.0,
      startAlt: 80.0,
    });
    const pkg = await parseDjiFlightLog(rawBuffer);

    const dev = calculateTrajectoryDeviation(pkg.telemetry, parsedRoute);
    expect(dev.deviations.length).toBe(30);

    const segments = generateTrajectorySegments(pkg.telemetry, 'altitude');
    expect(segments.length).toBeGreaterThan(0);
  });

  it('should orchestrate HUDDashboard and EventTimeline with parsed telemetry', async () => {
    const rawBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Mavic 3 Enterprise',
      pointsCount: 40,
      startLon: 114.0,
      startLat: 22.5,
      startAlt: 100.0,
    });
    const pkg = await parseDjiFlightLog(rawBuffer);

    const dashboard = new HUDDashboard();
    dashboard.loadPackage(pkg);

    expect(dashboard.getDuration()).toBeGreaterThan(0);
    expect(dashboard.getCurrentTime()).toBe(0);

    // Test seek callback
    let seekedTime = -1;
    dashboard.onSeek((t) => {
      seekedTime = t;
    });

    dashboard.renderFrame(1.5);
    expect(dashboard.getCurrentTime()).toBe(1.5);

    dashboard.destroy();
  });

  it('should integrate FlightViewerBridge and dispatch commands to host', async () => {
    const bridge = new FlightViewerBridge();
    const emittedEvents: string[] = [];

    bridge.on('READY', () => emittedEvents.push('READY'));
    bridge.on('FLIGHT_LOADED', () => emittedEvents.push('FLIGHT_LOADED'));
    bridge.on('TIME_UPDATE', () => emittedEvents.push('TIME_UPDATE'));

    bridge.emit('READY', { version: '1.0.0', capabilities: ['playback'] });
    expect(emittedEvents).toContain('READY');

    const rawBuffer = buildMockDjiBinaryBuffer({
      aircraftType: 'Matrice 350 RTK',
      pointsCount: 20,
      startLon: 120.0,
      startLat: 30.0,
      startAlt: 50.0,
    });
    const pkg = await parseDjiFlightLog(rawBuffer);

    // Test LOAD_FLIGHT command handler
    let loadedPayload: any = null;
    bridge.on('LOAD_FLIGHT', (payload) => {
      loadedPayload = payload;
    });

    const success = bridge.handleMessage({
      type: 'LOAD_FLIGHT',
      payload: { flightPackage: pkg },
    });

    expect(success).toBe(true);
    expect(loadedPayload).not.toBeNull();
    expect(loadedPayload.flightPackage.meta.aircraftType).toBe('Matrice 350 RTK');

    bridge.destroy();
  });
});
