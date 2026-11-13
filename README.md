# TaskPet

TaskPet is a local-first Tamagotchi-style study companion. It reads
coursework deadlines, maintains a local task and pet state, interprets
computer-vision interactions, and can mirror a 240x320 dashboard to an ESP32
over Wi-Fi.

The computer owns application logic, rendering, persistence, integrations, and
CV processing. The ESP32 is only a display and sensor bridge running
**TaskPet Link v1**.

## Project status

| Area | Status |
| --- | --- |
| TaskPet Link connection, reconnects, and ACK-paced streaming | Implemented and tested with a simulator |
| Sensor validation and stale/reboot handling | Implemented and tested |
| Local settings and separate secret storage | Implemented and tested |
| Simulated device and diagnostic link check | Implemented |
| Mock tasks, local completion, and progress | Implemented and tested |
| Canvas LMS read-only planner sync | Implemented and tested with a mock server |
| Computer vision: face detection, expression recognition, smoothing, and responses | Implemented; hardware smoke test is separate |
| Computer vision: hand gestures and music-control events | Implemented and unit tested |
| Pet simulation, browser UI, and tilt input | Not started |
| Notion synchronization | Not started |
| Physical ESP32 and webcam validation | Not yet completed |

Canvas LMS integration is read-only. TaskPet does not submit coursework, change
grades, or write to Canvas.

## Requirements

- Node.js 22.18 or newer
- npm
- Python 3.10 or newer for the CV package
- An ESP32 running the supplied bridge firmware for hardware use
- A webcam and the CV dependencies for live CV use

Hardware is not required for development or automated tests.

## Quick start

From the repository root:

```powershell
npm install
npm run check
```

`npm run check` runs the TypeScript checks, application tests, connector tests,
and the local WebSocket loopback test.

## Repository layout

```text
src/                  Application, device, sensor, task, and storage code
scripts/              Configuration, simulator, link-check, and Canvas CLIs
test/                 TypeScript unit and integration tests
CV/                   Face/emotion recognition and hand-gesture interactions
device-link/          Vendored TaskPet Link connector and protocol tests
TaskPetLink/          Original ESP32 firmware package and hardware documentation
docs/                 Integration documentation
```

## Computer vision

The [CV/](CV/) package provides:

- webcam capture and MediaPipe face detection;
- expression classification using `trpakov/vit-face-expression`;
- probability smoothing and confidence thresholds;
- presence events, break prompts, and encouragement responses;
- hand gestures for greeting, feedback, music playback, track navigation, and
  circular volume control;
- a safe recording music adapter that does not control the operating system by
  itself.

### CV tests without hardware

The unit tests use synthetic landmarks and do not open a camera or download a
model:

```powershell
& .\.venv\Scripts\python.exe -m unittest discover -s .\CV -p "test_*.py" -v
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

Gesture events are intentionally one-shot and cooldown-protected:

| Gesture | Event |
| --- | --- |
| Fist | Toggle music |
| Two fingers tilted right or left | Next or previous track |
| Circular index-finger motion | Volume up or down |
| Open-hand movement | Greet |
| Thumbs up or down | Positive or negative feedback |

### CV production notes

The face detector model is bundled in `CV/models/`. The expression model is
loaded at runtime and should be cached by the Python model tooling. Do not
commit model caches, camera captures, credentials, or generated files.

Live webcam behavior has not been validated on every camera or lighting
condition. Treat expression labels as probabilistic signals, not medical or
psychological assessments.

## Configure the device

Settings and device secrets are stored per user outside this repository:
`%APPDATA%\TaskPet\settings.json` and `secrets.json` on Windows. Set
`TASKPET_DATA_DIR` to use another local directory.

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

After flashing the firmware described in
[TaskPetLink/README.txt](TaskPetLink/README.txt):

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
