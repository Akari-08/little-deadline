# Lil Deadline

A cozy local study dashboard with Sprout, a pixel companion who grows with your
progress. React + TypeScript renders one opaque **240×320 Canvas 2D surface**;
the Node.js host mirrors those same pixels to the existing ESP32 using
**TaskPet Link v1**. Branding lives in [src/branding.ts](src/branding.ts).

The app works without hardware. The installed ESP32 firmware supports the app;
800×600 camera capture requires the firmware update in [camera setup](docs/camera.md).
External IMU/environment sensors and
the physical button are absent in the current hardware setup; unavailable values
are expected. Mouse and keyboard controls drive pet interaction.

## Project status

- Responsive dashboard, animated pet, progress ring, selected task, and focus timer.
- Five mirrored display slides: Sprout, Tasks, Focus, Music, and Sensors.
- Persistent local task add/edit/complete/reopen/delete, categories, due dates,
  priorities, filters, and a clearly labelled Mock demo starter set.
- Host-owned device connection, ACK-paced 5 fps stream, bounded retries, and
  diagnostics with stale/frozen display indicators.
- Shared authenticated ESP32 MJPEG feed with native-resolution and measured-FPS reporting.
- Canvas LMS and Notion read-only task imports with backend-only credentials,
  pagination, timeouts, rate-limit handling, and persisted last-good snapshots.
- Optional Spotify playback card with host-side PKCE account linking, track,
  play/pause, skip, and volume controls.
- Optional ESP32-camera hand gestures from `CV/` change slides, control
  Spotify, and greet Sprout. Camera viewing does not record video or recognize faces.

Checking a task locally never submits Canvas coursework, changes grades, or
writes to Notion. Both real integrations remain unconfigured until you add
your credentials in Settings.

## Requirements

- Node.js 22.14 or newer (22.18+ recommended)
- npm
- An ESP32 running the supplied bridge firmware for hardware use

Python and CV dependencies are optional, for hand-gesture music control and the
separate `CV/` tools. Spotify is optional and needs Internet access.

Hardware is not required for development or automated tests.

## Quick start

From the repository root, in Windows PowerShell:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open **http://127.0.0.1:3210**. Use `npm` instead of `npm.cmd` on macOS/Linux or
in shells where `npm` is allowed. The Windows spelling avoids PowerShell's
`npm.ps1` execution-policy restriction; no policy changes are needed.

The development command serves the React frontend and Node API on one loopback
origin. Backend source changes restart the host automatically. Reload the page
after frontend changes. Stop the server with Ctrl+C.

### Production build and run

```powershell
npm.cmd run build
npm.cmd start
```

The build checks TypeScript and writes the frontend to `dist/`. `start` serves
those assets plus the local Node backend. Keep the Node host running: uploading
only `dist/` to public static hosting cannot connect to the device on your LAN.
Fonts are bundled; preview mode needs no cloud service or Internet connection.

Optional: copy [.env.example](.env.example) to `.env` and set
`LIL_DEADLINE_PORT` or `TASKPET_DATA_DIR`. Keep credentials in the app's masked
Settings fields, not in `.env`, command arguments, or public build variables.

### Everyday use

1. Add or edit tasks in **Your day**. Select a task to put it on Sprout's face.
2. Complete a task to earn sprout points and trigger a celebration. Reopen a
   locally completed task using the same checkbox.
3. Start, pause, or reset a 25-minute focus session. Its deadline is saved on
   the host and survives browser reloads and host restarts.
4. Greet Sprout with the heart button or **H**. Use **← / →** or the two arrow
   buttons to play. **Space** starts/pauses focus. Shortcuts are disabled while
   typing or editing a task.
5. Choose **Mock / local**, **Canvas LMS**, or **Notion** below the task list.
   The Mock starter set is demo data; it can be replaced with your own local tasks.
6. Use the arrows below the device preview, **[ / ]**, or **Page Up / Page Down**
   to move between its five slides. The selected slide is saved across restarts.

The preview canvas always has a 240×320 backing store; CSS only scales its
appearance. The RGB565 preview toggle quantizes the same surface before upload.
With it off, the browser shows RGB888 colors that can differ from the device.

### Display and camera setup

In **Settings**, enter the device's LAN address (for example
`ws://192.168.1.123:81/`) or its device-specific `.local` hostname from serial
output, then the private 32–128 character token. The example IP is not a
discovered device. Save and click **Connect / Retry**. Use **Disconnect** to
close the connection and cancel retries. Connections start only on your command.

The backend opens the WebSocket with `arduino` and sends RGB565LE in 20 contiguous
16-row strips. Only one frame is in flight; one latest render can replace the
pending render. A fresh render is required after a reconnect. Multiple browser
tabs share the host connection; one active renderer has a short renewable lease.
Keep a dashboard tab visible to stream its canvas. Closing/minimizing all tabs
can stop browser rendering; the UI reports stale or frozen display state.

Open **Camera** and click **Open camera** for the camera feed.
The backend attaches the Bearer token to `http://DEVICE:8080/stream`; the frontend
receives only the same-origin stream. Only one camera viewer can be active.
Preview and hand detection share one upstream request. Closing the preview
leaves active gestures running; stopping both or disconnecting cancels it.
Another preview tab receives HTTP 409. The host never polls `/status`,
`/capture`, or `/sensors` during the camera stream. HTTP 401 means invalid
authorization; 503 means the camera is unavailable.

Device WebSocket and camera HTTP traffic are unencrypted. Use trusted local Wi-Fi;
do not expose the ESP32 or host publicly. The host binds to `127.0.0.1`, checks
Host/Origin, restricts camera routing to the configured LAN device, and never
returns stored tokens. The responsive layout works in narrow desktop windows;
access from a separate phone is not enabled by the loopback-only default.

### Integrations

**Spotify music:** Create an app in the Spotify Developer Dashboard and add this
exact Redirect URI (when using the default port):

```text
http://127.0.0.1:3210/api/spotify/callback
```

If you change `LIL_DEADLINE_PORT`, use that port in the registered URI. Open Lil
Deadline at `http://127.0.0.1:3210`, enter the **Client ID** in Settings, save it,
then click **Link Spotify account**. You do not need to give the app a client
secret or paste credentials into a chat. Sign-in uses PKCE; tokens are kept in
the host's private local secret file. Spotify Premium and an active playback
device are needed for player controls. In Spotify's development mode, the app
owner must also have Premium and any other test user must be allowed in the app
settings. The ESP32 does not receive Spotify credentials or audio. Playback
occurs in a Spotify app or device, not in the 240×320 preview. See
[Spotify setup](docs/spotify.md) for details.

**CV display and music gestures:** Click **Start gestures** on the music card
or Camera page. This processes the **ESP32 camera live feed** locally. Preview
and gestures share one stream; stop each independently. Two fingers left/right
change slides, fist toggles playback, a rotated open hand skips, a pointing-finger
circle adjusts volume, and a wave greets Sprout. Slide navigation and greeting
work without Spotify.

Install the optional Python environment on Windows:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r CV/requirements.txt
```

The host automatically uses this environment. See [camera setup](docs/camera.md)
for Linux/macOS, troubleshooting, and the 800×600 firmware update. No camera
frames are stored or sent to a cloud service.

**Canvas LMS:** enter your school's Canvas website address once, then paste a
personal API access token in Settings. Future token replacements need only the
token; the school address stays saved. Canvas cannot determine the school from
an opaque token alone. The app imports the planner about every 15 minutes. See
[Canvas LMS details](docs/canvas-lms.md).

**Notion:** share a task data source with your Notion connection and enter its
data source UUID plus connection token. It reads the title property and optional
`Due` (date), `Category` (select), and `Done` (checkbox) properties. A data source
ID is distinct from a database ID. Refreshes occur about every 15 minutes, and
failures retain the last good snapshot. See [Notion details](docs/notion.md).

**Ask Sprout (Claude study assistant):** open **Settings → Ask Sprout**, paste a
Claude API key from [console.anthropic.com](https://console.anthropic.com/) and
save it. The key is stored only in the host's private `secrets.json`; the
browser only learns whether a key is saved. Then open **Ask Sprout** in the
sidebar and type a question, or pick a suggested one such as *"What's my most
urgent assignment right now?"* Each question is sent to Anthropic's API along
with your task list from every provider (local, Canvas LMS, Notion), so answers
can use your real deadlines. Device tokens and other credentials are never sent.
The assistant is read-only: it cannot add, complete or submit anything. See
[assistant details](docs/assistant.md).

**Notifications:** the bell in the header collects deadline reminders, such as
items due within 24 hours and 2 hours, overdue items, new Canvas/Notion
assignments, changed due dates, busy-week warnings, a morning digest, sync
problems and finished focus sessions. The most urgent one also appears as a
banner on the 240×320 display. Choose rules, lead times and quiet hours under
**Settings → Notifications**, and enable desktop notifications there. See
[notification details](docs/notifications.md).

### Checks

```powershell
npm.cmd run check
npm.cmd run build
node --import tsx scripts/render-preview.ts
```

`check` runs TypeScript, application tests, 10 preserved connector tests,
and the real local TCP WebSocket loopback test. Coverage includes task CRUD and
restart persistence, pet/timer state, deterministic opaque rendering, RGB565
color bits, strip ordering, ACK pacing, reconnects, missing/stale sensors,
camera authentication, fragmented multipart data, viewer cancellation, origin
checks, and provider pagination/failure handling. The render command writes a
hardware-free QA face image to ignored `artifacts/face-preview.png`.

The production build and software tests have passed. Browser visual inspection
was blocked by the computer-use URL access check, so responsive layout and
interactive browser rendering still need a manual pass. Physical screen colors,
orientation, camera video, Wi-Fi reliability, and live Canvas/Notion credentials
have not been verified. ACKs confirm driver writes, not optical verification.
Hand pose accuracy and higher-resolution firmware need physical validation.
Run the hardware-free Python checks from `CV/` with
`..\.venv\Scripts\python.exe -m unittest test_slide_gestures test_camera_bridge`.
The older emotion experiments additionally require their own ML dependencies.

## Repository layout

```text
src/                  Application, device, sensor, task, and storage code
web/                  React dashboard and responsive styles
src/render/face.ts     Canonical deterministic Canvas 2D renderer
src/host/server.ts     Loopback API and frontend server
src/camera/            Bounded MJPEG parser and shared preview/gesture stream
src/notion/            Read-only Notion task provider
src/spotify/           Host-side Spotify PKCE and playback service
src/cv/                Bounded Python gesture bridge
scripts/              Configuration, simulator, link-check, and Canvas CLIs
test/                 TypeScript unit and integration tests
CV/                   Face/emotion recognition and hand-gesture interactions
device-link/          Vendored TaskPet Link connector and protocol tests
TaskPetLink/          Original ESP32 firmware package and hardware documentation
docs/                 Integration documentation
```

## Computer vision

The optional hand-gesture portion is connected to the Spotify music card. Other
CV experiments remain separate from the dashboard. Python ML dependencies are
not needed for the ESP32 camera proxy.

The [CV/](CV/) package provides:

- webcam capture and MediaPipe face detection;
- expression classification using `trpakov/vit-face-expression`;
- probability smoothing and confidence thresholds;
- presence events, break prompts, and encouragement responses;
- hand gestures for display slides, greeting, feedback, music playback, track
  navigation, and circular volume control;
- a safe recording music adapter that does not control the operating system by
  itself.

### CV tests without hardware

The unit tests use synthetic landmarks and do not open a camera or download a
model:

```powershell
& .\.venv\Scripts\python.exe -m unittest discover -s .\CV -p "test_interactions.py" -v
```

The bundled face detector can be smoke-tested against a synthetic frame:

```powershell
Push-Location .\CV
try {
  & ..\.venv\Scripts\python.exe -c "import numpy as np; from face_detection import FaceDetection; d = FaceDetection(); print(d.detect(np.zeros((240, 320, 3), dtype=np.uint8))); d.close()"
} finally {
  Pop-Location
}
```

### Live CV smoke test

Install the CV dependencies in the local Python environment, connect a
webcam, and run:

```powershell
& .\.venv\Scripts\python.exe .\CV\test_emotion.py
```

The first expression-model run may download model files. The smoke test is
hardware-dependent and is not part of the default Node test command.

### Interactive webcam validation

For a live window that shows face expressions, hand landmarks, gesture names,
and the last emitted event, download the MediaPipe Hand Landmarker model once:

```powershell
Invoke-WebRequest `
  -Uri "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" `
  -OutFile ".\CV\models\hand_landmarker.task"
```

Then run:

```powershell
Push-Location .\CV
try {
  & ..\.venv\Scripts\python.exe live_test.py
} finally {
  Pop-Location
}
```

Hold one gesture at a time for about one second. Press **Q** to exit. The
harness plays a distinct Windows tone for each event; volume gestures play
higher or lower tones and do not change the operating-system volume.

Gesture events are intentionally one-shot and cooldown-protected:

| Gesture | Event |
| --- | --- |
| Fist | Toggle music |
| Rotate open hand right or left | Next or previous track |
| Circular index-finger motion | Smooth proportional volume control |
| Open-hand movement | Greet |

### CV production notes

The face detector model is bundled in `CV/models/`. The expression model is
loaded at runtime and should be cached by the Python model tooling. Do not
commit model caches, camera captures, credentials, or generated files.

Live webcam behavior has not been validated on every camera or lighting
condition. Treat expression labels as probabilistic signals, not medical or
psychological assessments.

## Configure the device

Settings, task data, companion/timer state, and device secrets are stored per user outside this repository:
`%APPDATA%\TaskPet\settings.json` and `secrets.json` on Windows. Set
`TASKPET_DATA_DIR` to use another local directory.

The existing `TaskPet` directory name is retained so previous data remains
available. `tasks.json` and `companion.json` contain non-secret state. Secret
files are separate local JSON, not an encrypted OS vault; protect your user
profile and backups. Unix permissions request a private directory/file; Windows
uses the profile's inherited ACLs.

```powershell
npm run configure -- address 192.168.1.123
npm run configure -- token
npm run configure -- show
```

Use the IP address or the device-specific `.local` hostname printed by the
firmware. Device tokens are entered interactively and are never placed in URLs,
logs, source control, or frontend build variables.

## Develop without hardware

Run the simulated bridge and link check in separate terminals:

```powershell
npm run configure -- address 127.0.0.1:8181
npm run configure -- token
npm run fake-device -- --env BME280
npm run link-check
```

The simulated device follows the protocol rules but generates synthetic sensor
data. It is always labelled **SIMULATED** and must not be presented as physical
hardware telemetry.

## Hardware link check

With the already-flashed device configured (no firmware changes required):

```powershell
npm run link-check -- --seconds 30 --fps 5
```

This sends a diagnostic test card, not the pet UI. Verify the displayed
orientation and colors, matching frame acknowledgements, telemetry changes,
missing-sensor behavior, incorrect-token handling, and reconnect recovery.
An acknowledgement confirms a display-driver write; it does not prove optical
or hardware correctness.

The bridge uses `ws://` on a trusted local network. Do not expose port 81 to
the public internet. The ESP32 token is not a Canvas credential.

## Canvas LMS

Configure a personal Canvas access token locally:

```powershell
npm run configure -- canvas-url https://<your-school-canvas>
npm run configure -- canvas-token
npm run canvas-check
```

TaskPet only reads Canvas assignments and retains the last good local snapshot
when a refresh fails. See [docs/canvas-lms.md](docs/canvas-lms.md) for provider
behavior and safety boundaries.

## Development guidance

- Keep the ESP32 firmware limited to display and sensor-bridge responsibilities.
- Keep one authenticated device socket owned by the host service.
- Keep rendering deterministic and use one canonical 240x320 surface.
- Preserve null, stale, unavailable, and simulated sensor states; never
  fabricate missing measurements as zero.
- Run `npm run check` and the CV unit tests before submitting changes.
- Keep credentials, model caches, camera captures, and local settings out of
  commits and screenshots.
