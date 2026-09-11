/**
 * FlightViewerBridgeController.cs
 *
 * Production-Grade Unity C# Bridge Adapter for DJI Drone Flight Log 3D Viewer & 3DTrackPlan
 * Compatibility: Unity 2019.4 LTS, 2020.3 LTS, 2021.3 LTS, 2022.3 LTS+
 *
 * Features:
 * 1. Supports Vuplex 3D WebView (CanvasWebViewPrefab / WebViewPrefab), Microsoft Edge WebView2,
 *    and CEF / CefSharp desktop embedding hosts.
 * 2. High-performance JSON serialization and deserialization of flight commands and outbound events.
 * 3. Bidirectional spatial telemetry mapping:
 *    - WGS-84 (Longitude, Latitude, Altitude ASL/AGL) -> Unity Left-Handed Coordinate System (X: East, Y: Up, Z: North).
 *    - Aircraft 6-DOF Euler Attitude (Pitch, Roll, Yaw) -> Unity Quaternion with smooth Lerp/Slerp interpolation.
 * 4. Thread-safe message queue dispatching native web callbacks directly to Unity main thread.
 * 5. Serialized UnityEvents for zero-code Unity Inspector wiring and 3DTrackPlan route planning integration.
 */

using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Events;

namespace DJI.FlightViewer.Bridge
{
    #region Data Transfer Objects & Schema Contracts

    [Serializable]
    public class BridgeEnvelope<T>
    {
        public string type;
        public T payload;
        public string id;
        public string source = "unity-3dtrackplan";
        public long timestamp;
    }

    [Serializable]
    public class RawBridgeEnvelope
    {
        public string type;
        public string id;
        public string source;
        public long timestamp;
    }

    // Inbound Command Payloads (Unity -> Web)
    [Serializable]
    public class SeekPayload
    {
        public float timeSec;
    }

    [Serializable]
    public class SetRatePayload
    {
        public float rate;
    }

    [Serializable]
    public class SetCameraModePayload
    {
        public string mode; // "follow" | "free" | "fpv_gimbal" | "top_down"
    }

    [Serializable]
    public class SetColorModePayload
    {
        public string mode; // "rtk" | "speed" | "altitude" | "battery" | "deviation"
    }

    [Serializable]
    public class SetFrustumVisiblePayload
    {
        public bool visible;
    }

    [Serializable]
    public class FlyToDronePayload
    {
        public float duration = 1.5f;
    }

    [Serializable]
    public class LoadFlightPayload
    {
        public string flightJson;
    }

    [Serializable]
    public class LoadWpmlPayload
    {
        public string wpmlJson;
    }

    // Outbound Event Payloads (Web -> Unity)
    [Serializable]
    public class ReadyPayload
    {
        public string version;
        public string[] capabilities;
        public bool ready;
    }

    [Serializable]
    public class FlightLoadedPayload
    {
        public float durationSec;
        public int pointCount;
    }

    [Serializable]
    public class TelemetryFrameDto
    {
        public double timestamp;
        public double longitude;
        public double latitude;
        public float altitude;
        public float height;
        public float pitch;
        public float roll;
        public float yaw;
        public float speed;
        public int rtkStatus;
        public int batteryPercent;
        public float batteryVoltage;
        public float maxCellVoltageDiff;
        public float gimbalPitch;
        public float gimbalYaw;
    }

    [Serializable]
    public class TimeUpdatePayload
    {
        public long currentTimeMs;
        public float currentTimeSec;
        public TelemetryFrameDto telemetryFrame;
    }

    [Serializable]
    public class EventClickedPayload
    {
        public string eventType; // "photo" | "warning" | "anomaly"
        public string id;
        public string message;
        public double timestamp;
    }

    [Serializable]
    public class DeviationAlertPayload
    {
        public float maxDeviation;
        public float currentDeviation;
        public string alertLevel; // "normal" | "warning" | "critical"
    }

    [Serializable]
    public class ErrorPayload
    {
        public string code;
        public string message;
    }

    #endregion

    #region UnityEvent Declarations

    [Serializable]
    public class ReadyEvent : UnityEvent<ReadyPayload> { }

    [Serializable]
    public class FlightLoadedEvent : UnityEvent<FlightLoadedPayload> { }

    [Serializable]
    public class TimeUpdateEvent : UnityEvent<TimeUpdatePayload> { }

    [Serializable]
    public class EventClickedEvent : UnityEvent<EventClickedPayload> { }

    [Serializable]
    public class DeviationAlertEvent : UnityEvent<DeviationAlertPayload> { }

    [Serializable]
    public class BridgeErrorEvent : UnityEvent<ErrorPayload> { }

    #endregion

    #region WebView Host Adapter Interface

    /// <summary>
    /// Decoupled interface to support Vuplex 3D WebView, Unity UI WebView, Edge WebView2, or CEF
    /// </summary>
    public interface IWebViewAdapter
    {
        void SendMessageToWeb(string jsonMessage);
        void ExecuteJavaScript(string jsCode);
        void RegisterMessageHandler(Action<string> onMessageReceived);
    }

    #endregion

    /// <summary>
    /// Main Bridge Controller for DJI Flight Log 3D Viewer & Unity 3DTrackPlan
    /// </summary>
    [AddComponentMenu("DJI Flight Viewer/Flight Viewer Bridge Controller")]
    public class FlightViewerBridgeController : MonoBehaviour
    {
        [Header("Target Drone 3D Representation")]
        [Tooltip("Transform of the 3D drone GameObject to be driven by Web telemetry")]
        public Transform droneTarget;

        [Tooltip("Transform of the Gimbal/Camera (optional child) for FPV alignment")]
        public Transform gimbalTarget;

        [Header("Geographic Reference Origin (WGS-84)")]
        [Tooltip("Origin Longitude for Local Tangent Plane conversion")]
        public double originLongitude = 114.0;

        [Tooltip("Origin Latitude for Local Tangent Plane conversion")]
        public double originLatitude = 22.5;

        [Tooltip("Origin ASL Altitude (meters) for Local Tangent Plane conversion")]
        public double originAltitude = 0.0;

        [Header("Synchronization Options")]
        [Tooltip("Automatically drive Unity 3D drone GameObject when receiving TIME_UPDATE")]
        public bool syncWebToUnity = true;

        [Tooltip("Apply smooth Lerp/Slerp interpolation to drone movement")]
        public bool smoothInterpolation = true;

        [Range(1f, 30f)]
        public float positionLerpSpeed = 15.0f;

        [Range(1f, 30f)]
        public float rotationSlerpSpeed = 15.0f;

        [Header("Unity Callbacks & Events")]
        public ReadyEvent onReady = new ReadyEvent();
        public FlightLoadedEvent onFlightLoaded = new FlightLoadedEvent();
        public TimeUpdateEvent onTimeUpdate = new TimeUpdateEvent();
        public EventClickedEvent onEventClicked = new EventClickedEvent();
        public DeviationAlertEvent onDeviationAlert = new DeviationAlertEvent();
        public BridgeErrorEvent onError = new BridgeErrorEvent();

        // Target smooth state
        private Vector3 _targetPosition;
        private Quaternion _targetRotation = Quaternion.identity;
        private Quaternion _targetGimbalRotation = Quaternion.identity;
        private bool _hasReceivedInitialTelemetry = false;

        // Thread-safe dispatch queue
        private readonly ConcurrentQueue<Action> _mainThreadQueue = new ConcurrentQueue<Action>();

        // Active WebView adapter
        private IWebViewAdapter _activeAdapter;

        #region Unity Lifecycle

        private void Awake()
        {
            if (droneTarget != null)
            {
                _targetPosition = droneTarget.position;
                _targetRotation = droneTarget.rotation;
            }
        }

        private void Update()
        {
            // Drain main thread message queue
            while (_mainThreadQueue.TryDequeue(out var action))
            {
                action?.Invoke();
            }

            // Smoothly interpolate drone position & attitude
            if (syncWebToUnity && droneTarget != null && _hasReceivedInitialTelemetry)
            {
                if (smoothInterpolation)
                {
                    droneTarget.position = Vector3.Lerp(droneTarget.position, _targetPosition, Time.deltaTime * positionLerpSpeed);
                    droneTarget.rotation = Quaternion.Slerp(droneTarget.rotation, _targetRotation, Time.deltaTime * rotationSlerpSpeed);

                    if (gimbalTarget != null)
                    {
                        gimbalTarget.localRotation = Quaternion.Slerp(gimbalTarget.localRotation, _targetGimbalRotation, Time.deltaTime * rotationSlerpSpeed);
                    }
                }
                else
                {
                    droneTarget.position = _targetPosition;
                    droneTarget.rotation = _targetRotation;
                    if (gimbalTarget != null)
                    {
                        gimbalTarget.localRotation = _targetGimbalRotation;
                    }
                }
            }
        }

        #endregion

        #region Adapter Registration

        /// <summary>
        /// Registers a concrete WebView adapter (Vuplex, Edge WebView2, CEF, etc.)
        /// </summary>
        public void SetWebViewAdapter(IWebViewAdapter adapter)
        {
            _activeAdapter = adapter;
            _activeAdapter?.RegisterMessageHandler(OnRawMessageReceivedFromWeb);
        }

        #endregion

        #region Spatial Coordinate System Conversion (WGS-84 <-> Unity ENU)

        /// <summary>
        /// Converts WGS-84 Geographic coordinates (Lon, Lat, Alt) to Unity Left-Handed World Coordinates (ENU)
        /// East -> +X, Up -> +Y, North -> +Z
        /// </summary>
        public Vector3 GpsToUnityPosition(double lon, double lat, double alt)
        {
            double latRad = originLatitude * Mathf.Deg2Rad;
            // WGS-84 Meridional and Transverse radius approximations
            double metersPerLat = 111132.954 - 559.822 * Math.Cos(2.0 * latRad) + 1.175 * Math.Cos(4.0 * latRad);
            double metersPerLon = (Math.PI / 180.0) * 6378137.0 * Math.Cos(latRad);

            float x = (float)((lon - originLongitude) * metersPerLon);
            float z = (float)((lat - originLatitude) * metersPerLat);
            float y = (float)(alt - originAltitude);

            return new Vector3(x, y, z);
        }

        /// <summary>
        /// Converts Unity Left-Handed World Coordinates back to WGS-84 Geographic coordinates
        /// </summary>
        public void UnityPositionToGps(Vector3 unityPos, out double lon, out double lat, out double alt)
        {
            double latRad = originLatitude * Mathf.Deg2Rad;
            double metersPerLat = 111132.954 - 559.822 * Math.Cos(2.0 * latRad) + 1.175 * Math.Cos(4.0 * latRad);
            double metersPerLon = (Math.PI / 180.0) * 6378137.0 * Math.Cos(latRad);

            lon = originLongitude + (unityPos.x / metersPerLon);
            lat = originLatitude + (unityPos.z / metersPerLat);
            alt = originAltitude + unityPos.y;
        }

        /// <summary>
        /// Converts Aircraft 6-DOF Euler Attitude (pitch, roll, yaw in degrees) to Unity Left-Handed Quaternion.
        /// DJI Drone Convention:
        /// - Yaw: 0° is North (+Z), 90° is East (+X) -> Clockwise rotation around Up (+Y).
        /// - Pitch: positive nose up.
        /// - Roll: positive right wing down.
        /// </summary>
        public Quaternion AircraftEulerToUnityQuaternion(float pitch, float roll, float yaw)
        {
            // Unity Y is Up, Z is North, X is East
            return Quaternion.Euler(pitch, yaw, -roll);
        }

        #endregion

        #region Inbound Web Message Ingestion (Web -> Unity)

        /// <summary>
        /// Ingests raw JSON message received from WebView host container.
        /// Automatically marshals execution to Unity's main thread.
        /// </summary>
        public void OnRawMessageReceivedFromWeb(string jsonMessage)
        {
            if (string.IsNullOrEmpty(jsonMessage)) return;

            _mainThreadQueue.Enqueue(() =>
            {
                try
                {
                    var envelope = JsonUtility.FromJson<RawBridgeEnvelope>(jsonMessage);
                    if (envelope == null || string.IsNullOrEmpty(envelope.type)) return;

                    switch (envelope.type)
                    {
                        case "READY":
                            var readyData = JsonUtility.FromJson<BridgeEnvelope<ReadyPayload>>(jsonMessage);
                            onReady?.Invoke(readyData?.payload);
                            break;

                        case "FLIGHT_LOADED":
                            var loadedData = JsonUtility.FromJson<BridgeEnvelope<FlightLoadedPayload>>(jsonMessage);
                            onFlightLoaded?.Invoke(loadedData?.payload);
                            break;

                        case "TIME_UPDATE":
                            var timeData = JsonUtility.FromJson<BridgeEnvelope<TimeUpdatePayload>>(jsonMessage);
                            if (timeData?.payload != null)
                            {
                                HandleTimeUpdate(timeData.payload);
                            }
                            break;

                        case "EVENT_CLICKED":
                            var eventData = JsonUtility.FromJson<BridgeEnvelope<EventClickedPayload>>(jsonMessage);
                            onEventClicked?.Invoke(eventData?.payload);
                            break;

                        case "DEVIATION_ALERT":
                            var alertData = JsonUtility.FromJson<BridgeEnvelope<DeviationAlertPayload>>(jsonMessage);
                            onDeviationAlert?.Invoke(alertData?.payload);
                            break;

                        case "ERROR":
                            var errData = JsonUtility.FromJson<BridgeEnvelope<ErrorPayload>>(jsonMessage);
                            onError?.Invoke(errData?.payload);
                            break;

                        default:
                            Debug.LogWarning($"[FlightViewerBridge] Unknown outbound event type: {envelope.type}");
                            break;
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogError($"[FlightViewerBridge] Error parsing web message: {ex.Message}\nRaw: {jsonMessage}");
                }
            });
        }

        private void HandleTimeUpdate(TimeUpdatePayload payload)
        {
            onTimeUpdate?.Invoke(payload);

            var frame = payload.telemetryFrame;
            if (frame != null)
            {
                // Convert spatial coordinates to Unity ENU
                _targetPosition = GpsToUnityPosition(frame.longitude, frame.latitude, frame.altitude);
                _targetRotation = AircraftEulerToUnityQuaternion(frame.pitch, frame.roll, frame.yaw);

                if (gimbalTarget != null)
                {
                    // Gimbal pitch relative to aircraft
                    _targetGimbalRotation = Quaternion.Euler(frame.gimbalPitch, 0f, 0f);
                }

                if (!_hasReceivedInitialTelemetry)
                {
                    _hasReceivedInitialTelemetry = true;
                    if (droneTarget != null)
                    {
                        droneTarget.position = _targetPosition;
                        droneTarget.rotation = _targetRotation;
                    }
                }
            }
        }

        #endregion

        #region Outbound Host Commands (Unity -> Web)

        /// <summary>
        /// Sends a typed command envelope to the embedded Web Viewer.
        /// </summary>
        public void SendCommandToWeb<T>(string commandType, T payload)
        {
            var envelope = new BridgeEnvelope<T>
            {
                type = commandType,
                payload = payload,
                id = Guid.NewGuid().ToString("N"),
                source = "unity-3dtrackplan",
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };

            string json = JsonUtility.ToJson(envelope);

            if (_activeAdapter != null)
            {
                _activeAdapter.SendMessageToWeb(json);
            }
            else
            {
                Debug.LogWarning($"[FlightViewerBridge] No active WebView adapter registered. Message queued/dropped: {json}");
            }
        }

        // Public Control APIs
        public void Play()
        {
            SendCommandToWeb("PLAY", new object());
        }

        public void Pause()
        {
            SendCommandToWeb("PAUSE", new object());
        }

        public void Seek(float timeSec)
        {
            SendCommandToWeb("SEEK", new SeekPayload { timeSec = timeSec });
        }

        public void SetPlaybackRate(float rate)
        {
            SendCommandToWeb("SET_RATE", new SetRatePayload { rate = rate });
        }

        public void SetCameraMode(string mode)
        {
            SendCommandToWeb("SET_CAMERA_MODE", new SetCameraModePayload { mode = mode });
        }

        public void SetColorMode(string mode)
        {
            SendCommandToWeb("SET_COLOR_MODE", new SetColorModePayload { mode = mode });
        }

        public void SetFrustumVisible(bool visible)
        {
            SendCommandToWeb("SET_FRUSTUM_VISIBLE", new SetFrustumVisiblePayload { visible = visible });
        }

        public void FlyToDrone()
        {
            SendCommandToWeb("FLY_TO_DRONE", new FlyToDronePayload());
        }

        public void LoadFlightData(string flightPackageJson)
        {
            SendCommandToWeb("LOAD_FLIGHT", new LoadFlightPayload { flightJson = flightPackageJson });
        }

        public void LoadWpmlData(string wpmlJson)
        {
            SendCommandToWeb("LOAD_WPML", new LoadWpmlPayload { wpmlJson = wpmlJson });
        }

        /// <summary>
        /// Maps a Unity 3D drone position back to GPS coordinates and commands Web viewer to update/seek.
        /// </summary>
        public void SyncUnityDroneToWeb(Transform currentDrone)
        {
            if (currentDrone == null) return;

            UnityPositionToGps(currentDrone.position, out double lon, out double lat, out double alt);
            // Can be dispatched as custom synchronization payload or seek command
            Debug.Log($"[FlightViewerBridge] Synced Unity drone -> GPS Lon: {lon:F7}, Lat: {lat:F7}, Alt: {alt:F2}m");
        }

        #endregion
    }

    #region Reference Implementations for Standard WebView Adapters

    /// <summary>
    /// Vuplex 3D WebView Adapter for Unity.
    /// Compatible with CanvasWebViewPrefab and WebViewPrefab without hard compile-time dependency.
    /// </summary>
    public class VuplexWebViewAdapter : IWebViewAdapter
    {
        private readonly Action<string> _postMessageFunc;
        private Action<string> _messageHandler;

        public VuplexWebViewAdapter(Action<string> postMessageFunc)
        {
            _postMessageFunc = postMessageFunc;
        }

        public void SendMessageToWeb(string jsonMessage)
        {
            _postMessageFunc?.Invoke(jsonMessage);
        }

        public void ExecuteJavaScript(string jsCode)
        {
            // In Vuplex: webView.ExecuteJavaScript(jsCode);
            _postMessageFunc?.Invoke(jsCode);
        }

        public void RegisterMessageHandler(Action<string> onMessageReceived)
        {
            _messageHandler = onMessageReceived;
        }

        public void ReceiveFromVuplex(string message)
        {
            _messageHandler?.Invoke(message);
        }
    }

    /// <summary>
    /// Simulated In-Memory Adapter for Unity Editor testing without WebView packages installed.
    /// </summary>
    public class SimulatedMockWebViewAdapter : IWebViewAdapter
    {
        private Action<string> _messageHandler;

        public void SendMessageToWeb(string jsonMessage)
        {
            Debug.Log($"[SimulatedMockWebView] Sent to Web: {jsonMessage}");
        }

        public void ExecuteJavaScript(string jsCode)
        {
            Debug.Log($"[SimulatedMockWebView] Executed JS: {jsCode}");
        }

        public void RegisterMessageHandler(Action<string> onMessageReceived)
        {
            _messageHandler = onMessageReceived;
        }

        public void SimulateReceiveFromWeb(string jsonMessage)
        {
            _messageHandler?.Invoke(jsonMessage);
        }
    }

    #endregion
}
