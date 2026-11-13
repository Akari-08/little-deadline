# TaskPet App — Agent Instructions

## Scope and objective

Apply these instructions throughout the application repository. Build a working app for a Tamagotchi-style companion whose image is mirrored to an existing ESP32 display over Wi-Fi. The computer owns pet behavior, animation, tasks, persistence, sensor interpretation, and integrations. The ESP32 is an existing screen-and-sensor bridge running **TaskPet Link v1**.

Treat the project name as a working name. Follow later explicit user instructions. Reuse the repository's established stack and conventions. For a new repository, use TypeScript, a local Node.js host process, and a browser or desktop UI with a Canvas 2D render surface. Do not require a cloud service for the device link. Keep the app usable without hardware.

## Existing hardware contract

- ESP32-WROVER-E; portrait ST7789V TFT, **240 pixels wide × 320 pixels high**.
- TFT wiring: MOSI23, SCLK18, CS27, DC26, RST25, backlight control33; SPI MISO unused.
- MPU6050 on SDA21/SCL22; BME280 or BMP280 on SDA32/SCL19.
- Future GPIO13 button is disabled in the supplied firmware. Show its unavailable state honestly.
- Sensor acquisition and physical display writes stay on the ESP32. Game logic and backend work stay on the computer.
- Preserve the existing firmware/protocol. Do not add firmware-side pet logic, new endpoints, or firmware dependencies to implement normal app features.
- The device hosts a WebSocket server. **The app connects to the device**, not the reverse.

## Source of truth and connector reuse

Use the supplied TaskPet Link package when available:

- `client/taskpet-link.mjs`: dependency-free browser/Node.js connector.
- `PROTOCOL.txt`: full TaskPet Link v1 wire contract.
- `client/taskpet-link.test.mjs` and `client/loopback-test.mjs`: connector tests.
- `client/smoke-test.mjs`: physical link test; not the pet application.

Vendor those files into a clearly named directory, such as `device-link/`, preserving their behavior and tests. Add a small typed adapter rather than rewriting the transport unnecessarily. Node.js 22+ provides the WebSocket runtime expected by this connector. If the files are unavailable, implement the complete contract below and test against it; do not invent an incompatible API.

The supplied firmware compiled successfully for ESP32 core 3.3.3. The supplied connector passed 10 simulated-peer tests and a real loopback WebSocket test. Physical Wi-Fi/display/sensor operation has not yet been verified. Never present those software checks as hardware validation.

## Connection settings and ownership

- Accept a configurable address, such as `ws://192.168.1.123:81/`. This address is an example, not a discovered device.
- Also accept the device-specific `.local` hostname shown by its serial output, with IP entry as a fallback.
- Use WebSocket subprotocol **`arduino`** and root path **`/`** on port **81**.
- Accept a private device token of 32–128 printable ASCII characters without spaces; a locally generated random hexadecimal token is suitable.
- Keep one persistent authenticated device connection in one owner process. UI components must not create competing connections. The firmware permits one authenticated app.
- If a Node host owns the socket, expose narrow local methods/events to the UI; do not give each UI component a separate device socket.
- Bind any app-local control service to loopback by default. The machine must be able to reach the device on the same LAN.
- Keep device tokens out of URLs, logs, analytics, screenshots, fixtures, source control, and frontend build-time public environment variables. Use a local settings/secret store and mask token inputs. Never distribute actual credentials.
- `ws://` is unencrypted. This bridge is for a trusted local network, not a publicly exposed device. HTTPS-hosted browser deployment may need a local host connector rather than direct `ws://` access.

## TaskPet Link v1: authentication and lifecycle

1. Open the WebSocket with subprotocol `arduino`.
2. The device sends `{"type":"hello","protocol":"taskpet-link/1","auth_required":true}`.
3. Within five seconds, send the complete text message `AUTH ` followed by the device token. Do not wrap it in JSON, add a newline, or include angle brackets.
4. Wait for `ready` before sending frames. Validate protocol, dimensions, format, and strip limit:

```json
{"type":"ready","protocol":"taskpet-link/1","width":240,"height":320,"format":"rgb565le","max_strip_rows":16,"telemetry_hz":20,"button_enabled":false}
```

5. Receive sensor JSON and frame acknowledgements on this same socket. Standard WebSocket ping/pong is supported. Optional text `PING` returns `{"type":"pong"}`.
6. On disconnect or protocol failure, reject pending work, clear unsent frames, mark telemetry stale, and reconnect with bounded exponential backoff and jitter. Stop repeated automatic attempts for authentication/configuration errors until settings change or the user retries. Respect `busy` and never fight another controlling app.
7. After reconnect, send the newest complete render. Never resume a partial frame or replay an old animation queue.

The existing JavaScript connector handles authentication, encoding, acknowledgements, and timeouts. It does **not** automatically reconnect. Implement one reconnect supervisor around it, with explicit Stop/Disconnect cancelling retries.

## Rendering and frame transport

- Render the pet/dashboard to **one canonical 240×320 Canvas 2D backing surface**. Compose an opaque background; alpha is not transmitted.
- Use that same rendered surface for preview and device output. Do not independently rebuild the device face with DOM/CSS or a second renderer.
- CSS may enlarge the preview, but device pixel ratio, responsive layout, and CSS dimensions must not change the backing dimensions. Use nearest-neighbor preview scaling when appropriate.
- Device colors are RGB565-quantized. If offering an exact-color preview, quantize it to the same format; do not claim RGBA8888 and RGB565 have identical color fidelity.
- Render controls, task management, settings, and diagnostics outside the device face when useful. The small face must remain readable at native size.
- Start streaming at **5 fps**. Measure actual ACK latency and delivered FPS before raising the target. There is no 60-fps guarantee.
- Keep app simulation/UI responsive independently of the streaming rate. Keep at most one frame in flight and one replaceable latest render; never retain an unbounded frame queue.
- Await `frame_ack` before starting the next frame. The SDK rejects overlapping sends and has a five-second ACK timeout. Handle every rejection.
- A complete frame contains **153600 bytes** of row-major RGB565 little-endian pixels, origin at top-left, X right, Y down.
- RGB packing: `value = ((R & 0xF8) << 8) | ((G & 0xFC) << 3) | (B >> 3)`; transmit low byte, then high byte. Red is `00 F8`, green `E0 07`, blue `1F 00`.
- Do not send PNG/JPEG, base64, JSON pixel arrays, HTML, draw commands, or an entire full frame in one WebSocket message. These formats are not supported by this firmware.

### Binary strip contract

Each strip is one complete, unfragmented WebSocket binary message. TCP packet splitting is allowed. Its 12-byte header is:

- Bytes 0–3: ASCII `TPX1`, hex `54 50 58 31`.
- Bytes 4–7: `frame_id`, uint32 little-endian.
- Bytes 8–9: first row `y`, uint16 little-endian.
- Bytes 10–11: `rows`, uint16 little-endian, from 1 to 16.
- Remaining bytes: exactly `rows × 240 × 2` RGB565LE pixel bytes, without padding or a trailer.

Start at row 0, then send contiguous increasing rows with the same frame ID until all 320 rows are covered. Normally use 20 messages of 16 rows, with `y=0,16,...,304`, each 7692 bytes including its header. Do not interleave frame IDs, duplicate rows, or pause more than two seconds between strips. Frame IDs wrap modulo 2^32.

After copying a complete image to the display, the device replies:

```json
{"type":"frame_ack","frame_id":1,"frames":1,"draw_ms":65,"uptime_ms":12345}
```

Match the ACK to the outstanding frame ID. `draw_ms` measures device display-transfer time, not end-to-end latency. An ACK confirms the driver write, not optical verification. Incomplete frames are discarded; the last completed image remains on disconnect. Make stale/frozen-device state visible in the app instead of claiming the screen is still live.

## Sensor contract and interpretation

Authenticated connections receive `sensors` messages. IMU sampling/telemetry nominally target 20 Hz and environment sampling 1 Hz, but display/network operations can lower effective rates. Do not treat these as hard real-time guarantees.

```json
{
  "type": "sensors",
  "seq": 42,
  "uptime_ms": 12345,
  "imu": {
    "present": true,
    "valid": true,
    "sample_ms": 12340,
    "accel_m_s2": [0.1, -0.2, 9.8],
    "gyro_rad_s": [0.0, 0.01, 0.0],
    "temperature_c": 28.0,
    "roll_deg": -1.17,
    "pitch_deg": -0.58
  },
  "environment": {
    "kind": "BME280",
    "valid": true,
    "sample_ms": 12000,
    "temperature_c": 23.5,
    "pressure_hpa": 954.2,
    "humidity_pct": 44.1
  },
  "button": { "enabled": false, "pressed": false, "press_count": 0 },
  "display": { "frames": 12, "last_frame_id": 12 },
  "rssi_dbm": -50
}
```

- Validate incoming JSON and ranges at the app boundary. Invalid/absent measurements are `null`, never zero-filled fabricated readings. Use each sensor's `valid` flag before using its values.
- IMU `present` means initialization succeeded; it does not prove a sensor remains connected. Gyroscope units are radians/second; accelerometer units are meters/second squared. MPU temperature is chip temperature, distinct from environment temperature.
- `roll_deg` and `pitch_deg` are accelerometer gravity estimates, not fused orientation or yaw. Calibrate, smooth, and interpret gestures on the machine. Provide software controls if motion input is unavailable.
- Environment `kind` is `BME280`, `BMP280`, or `none`. BMP280 humidity must remain unavailable/null. Pressure is local absolute hPa, not automatically sea-level corrected.
- Repeated environment `sample_ms` values are repeated observations of the same sample; do not count them as new readings.
- Uptime/sample timestamps are device-relative uint32 milliseconds, not UTC. Compute device ages as `(uptime_ms - sample_ms) >>> 0`; separately track receipt age with the host monotonic clock. Sequence numbers and counters wrap modulo 2^32.
- Use changes in debounced `button.press_count` to detect short presses. Establish a new baseline after reconnect or device reboot; do not replay historical presses. Detect reboot/session reset and reinitialize timestamp/counter assumptions.
- Distinguish `live`, `stale`, `unavailable`, and `simulated` data. Never label mock data as physical readings.

## Error handling

The device sends `{"type":"error","code":"bad_strip"}`-style messages. Codes include `busy`, `auth_failed`, `auth_required`, `bad_header`, `bad_strip`, `frame_in_progress`, `strip_order`, `frame_timeout`, `unknown_command`, and `fragmented_message_unsupported`. Transport failures/oversized messages can close without a JSON error.

On protocol errors, close the uncertain connection, reject its outstanding frame, and recover through the connection supervisor. Never silently swallow frame errors or display an optimistic "connected/streaming" badge without authenticated readiness and recent successful traffic.

## App structure and first working version

Separate device transport, validated sensor state, pet simulation, rendering, task/integration adapters, persistence, and UI. Keep the render function deterministic from explicit state/time so it can be tested without hardware.

Implement these user flows end to end:

1. Connection settings with device address, masked token, Connect/Disconnect, and useful connection errors.
2. A live 240×320 preview containing the pet, task progress, and readable status.
3. A pet with idle/blink/mood animations driven by app state; task completion changes its mood/progress.
4. A local mock-task provider with add/edit/complete/reset operations and local persistence. Label it Mock until a real provider is configured.
5. Tilt interaction calibrated on the machine, with hysteresis so a held tilt does not repeatedly trigger. Include mouse/keyboard equivalents.
6. A sensor panel showing units, validity, sample/receipt age, and missing humidity on BMP280.
7. Hardware-free preview mode with clearly marked simulated sensors, using the same simulation/render pipeline as device mode.
8. Automatic connection recovery without stale-frame replay or duplicate sockets. Preserve pet/task state through device disconnects.
9. Diagnostics showing authenticated connection state, target/delivered FPS, frame ACK latency, device draw time, telemetry age, and available Wi-Fi signal information.

Persist useful app state/settings locally, with a versioned schema and sensible defaults. Keep secret storage separate from ordinary task/pet data. Do not require the ESP32 to persist game state.

## Canvas LMS and Notion

Canvas means **Canvas LMS assignments/tasks** here; Canvas 2D is the rendering surface. Keep these concepts distinct in code and UI.

Create provider interfaces that let mock tasks later be replaced with Canvas LMS data and optional Notion synchronization. Keep remote credentials and API calls in the host/backend, never in ESP32 firmware or publicly bundled UI code. Verify official API documentation when implementing those adapters. Preserve stable remote IDs, handle pagination/rate limits/timeouts, and retain the last good snapshot on fetch failure.

Local completion is not Canvas coursework submission. Do not submit assignments, change grades, or write remote Notion data merely because a local task was checked. Require an explicitly configured remote-write behavior and make its effects clear. Until a provider is implemented and configured, label it unconfigured/mock rather than pretending synchronization works.

## Validation and delivery

- Run the repository's build/type/lint checks as applicable, plus meaningful tests of frame encoding, connection transitions, ACK pacing, disconnect recovery, invalid/stale telemetry, and persistence.
- Preserve and run the supplied connector tests; run the real loopback WebSocket test where supported.
- Exercise preview mode without hardware. Verify one canonical backing surface remains 240×320 when the app resizes or display scale changes.
- With hardware available, validate colors/orientation, matched frame ACKs, real sensor changes, missing sensors, incorrect token, and app/device reconnect. State clearly when hardware was unavailable.
- Keep credentials out of screenshots, fixtures, logs, generated examples, commits, and deliverable archives. Use empty templates and ignored local configuration files.
- Deliver runnable code and exact setup/run/test instructions. Do not stop at a static UI mockup, invented APIs, or a plan. Summarize actual checks and remaining hardware limitations accurately.
