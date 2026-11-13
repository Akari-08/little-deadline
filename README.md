# little-deadline (TaskPet)

A Tamagotchi-style companion that lives on your computer and is mirrored to an
ESP32 240×320 display over Wi-Fi using **TaskPet Link v1**. The computer owns the
pet, rendering, tasks, persistence and integrations; the ESP32 only shows pixels
and reports sensors. Requirements: [`AGENTS.md`](AGENTS.md).

## Status

| Area | State |
| --- | --- |
| Device link (single socket, reconnect supervisor, ACK-paced streaming, diagnostics) | Done, tested against a simulator |
| Sensor validation (null-not-zero, live/stale/unavailable/simulated, uint32 ages, reboot, button baseline) | Done, tested |
| Local settings + separate secret store (versioned) | Done, tested |
| Simulated device (firmware protocol rules) + CLI link check | Done |
| Task store: Mock tasks (add/edit/complete/reset), Canvas snapshots, local check-off, progress | Done, tested |
| Canvas LMS provider (read-only planner sync, personal access token) | Done, tested against a mock server; **not yet run against a real Canvas** |
| "Sign in with Canvas" (OAuth2) | Parked (needs a school-issued developer key); preserved in git at `f64a89c` |
| Pet simulation, Canvas 2D renderer, host API, browser UI, tilt input | **Not started** |
| Notion | Not started |
| Physical hardware | **Not yet verified** (no device has been tested with this app) |

## Requirements

- Node.js **22.18+** (uses built-in TypeScript type stripping; developed on Node 26).
- An ESP32 flashed with the supplied firmware in `TaskPetLink/` for hardware use
  (see `TaskPetLink/README.txt`). Not needed for development or tests.

```powershell
npm install
npm run check        # typecheck + app tests + vendored connector tests (incl. real loopback WebSocket)
```

## Layout

```
device-link/        Vendored TaskPet Link connector (unchanged) + TypeScript declarations
src/device/         Address/token rules, error classification, reconnect supervisor, frame streamer
src/sensors/        Telemetry validation and tracking
src/host/           Device service (the single connection owner) and local storage
src/simulator/      SIMULATED device for tests/dev (not hardware)
src/render/         Diagnostic test card (the pet renderer will live here)
scripts/            configure, fake-device, link-check CLIs
test/               Unit + loopback integration tests
TaskPetLink/        Original supplied package: firmware, protocol, connector
```

## Configure the device connection

Settings and the device token are stored per user **outside this repo**
(`%APPDATA%\TaskPet\settings.json` and `secrets.json` on Windows; override with
`TASKPET_DATA_DIR`). The token is never printed, logged, or put in a URL. It is stored as plain text protected by your user-profile permissions (on Windows, `0o600` file modes have no effect; `%APPDATA%` is private to your account by default). An OS keychain can replace this later.

```powershell
npm run configure -- address 192.168.1.123     # or taskpet-xxxxxx.local from the serial log
npm run configure -- token                     # paste LINK_DEVICE_TOKEN from secrets.h (input hidden)
npm run configure -- show
```

If the `.local` name does not resolve on your PC, use the IP shown on the device's
serial log/screen. A DHCP reservation on your router keeps it stable.

## Check the link with hardware

```powershell
npm run link-check -- --seconds 30 --fps 5
```

Streams a **test card** (not the pet) through the full stack and prints connection
state, delivered/target FPS, ACK latency, device draw time, telemetry age, Wi-Fi RSSI
and sensor status. On the screen you should see red / green / blue bands top to
bottom, a white border, and a white square moving left→right. A frame ACK confirms
the driver write, not what the panel shows — look at the screen.

Hardware checklist still to do: colours/orientation, matched ACKs, real tilt and
environment changes, BMP280 humidity shown as n/a, missing-sensor behaviour,
wrong token (should halt, not retry), unplug/replug and Wi-Fi loss recovery.

## Develop without hardware

```powershell
npm run configure -- address 127.0.0.1:8181
npm run configure -- token                     # any 32+ char test value
npm run fake-device -- --env BME280            # in one terminal (keys: d drop, r reboot, s freeze, q quit)
npm run link-check                             # in another
```

The simulated device follows the firmware's protocol rules but its sensor data is
synthetic. Any loopback peer is labelled **SIMULATED**, never live.

## Canvas LMS (coursework)

TaskPet **only reads** Canvas: it never submits work, changes grades, or writes anything to
Canvas. Items submitted, excused, or marked done in Canvas drop off the active list on the next
refresh. Checking an item off in TaskPet is local only. Details: [`docs/canvas-lms.md`](docs/canvas-lms.md).

Each user creates their own personal access token in Canvas and enters it into their own copy
of TaskPet. It is stored only on that computer and sent only to their school's Canvas.

```powershell
npm run configure -- canvas-url https://<your-school-canvas>
npm run configure -- canvas-token      # Canvas: Account > Settings > Approved Integrations > New Access Token (input hidden)
npm run canvas-check                   # read-only summary of what's due
```

A personal token can do anything you can do in Canvas (TaskPet only reads with it), so give it
an expiry date (e.g. end of term) and revoke it in Canvas if your computer is lost. TaskPet never
asks for your school password. Instructure's API policy expects OAuth sign-in for apps used by
many people; that implementation is parked (see `src/canvas/auth.ts`) until a developer key is
available.

## Behaviour summary

- One authenticated device socket, owned by the host's `DeviceService`; UI code never opens one.
- Reconnect: exponential backoff (1 s → 30 s) with jitter. Wrong token or incompatible
  device → retries stop until settings change or you retry. `busy` → never takes over
  another app (a few slow retries only right after our own session dropped, since the
  firmware clears a dead owner after ~16–26 s). No telemetry/ACKs for 8 s → reconnect.
- Streaming starts at 5 fps, one frame in flight, newest render only; after reconnect
  the newest frame is sent from row 0 — never an old queue or a partial frame.
- `ws://` is unencrypted: trusted local network only; never expose port 81.
