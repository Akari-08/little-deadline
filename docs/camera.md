# ESP32 camera and hand gestures

Configure the ESP32 address and private device token in Settings. In Camera,
choose **Open camera** for a preview and **Start gestures** for hand control.
The same gesture button is available on the dashboard music card. The
computer webcam is never opened by the app's gesture bridge.

The Node host shares one authenticated `http://DEVICE:8080/stream` request
between the preview and Python worker. It keeps device credentials in the
host. Python receives only JPEG frames and monotonic timestamps over stdin.
One frame is processed at a time with one replaceable newest pending image;
old frames cannot accumulate. Frames and landmarks are not recorded.

Stopping the preview leaves gestures active. Stopping gestures leaves the
preview active. Stop both to close the upstream stream. Device Disconnect or
changing the device settings stops both. Connection/model errors are shown
in the UI; use Retry camera or Start gestures after resolving the error.

## Local Python setup

Use Python 3.12 and the bundled `CV/models/hand_landmarker.task`.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r CV/requirements.txt
```

On macOS/Linux:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r CV/requirements.txt
```

The host selects the repository's .venv automatically. An explicit
`LIL_DEADLINE_PYTHON` executable path takes precedence. Without either, the
fallback is `py -3.12` on Windows or `python3` elsewhere. MediaPipe uses its
[video hand-landmarker API](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker?tab=Python)
with increasing frame timestamps.

Keep the whole hand visible and reasonably lit. Left/right follows the
unmirrored preview. Clockwise circles increase volume; counterclockwise reduces
it. Hold static poses for two frames; use slow circles and
waves at the camera's target 5 fps. Actual capture/detection rates depend on
Wi-Fi, the ESP and the computer. The UI reports live only after a frame has
been processed, not merely after Python starts.

## Higher resolution

`ESP_firmware/src/main.cpp` now configures native **800×600 SVGA JPEG** with
quality 12, two PSRAM buffers, and a target 5 fps. That is 6.25 times the pixels
of the former 320×240 stream. It follows the existing
[Espressif camera driver](https://github.com/espressif/esp32-camera) JPEG/PSRAM
pipeline. Hardware throughput at this resolution must be measured.

The browser scales the preview smoothly up to 1280px wide. Its badge reads
dimensions from the actual JPEG, so older firmware honestly shows 320×240.
Scaling enlarges the picture; the firmware update adds native capture detail.
The physical TFT and canonical pet canvas remain **240×320**.

Build from the repository root using the installed PlatformIO CLI:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -d ESP_firmware
```

Connect this ESP32 by USB, identify its port with `platformio device list`,
and upload to that specific port (replace COM_PORT):

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -d ESP_firmware -t upload --upload-port COM_PORT
```

The existing partition configuration has no OTA support. A Wi-Fi connection
alone cannot install this update. A normal upload preserves the existing NVS
Wi-Fi/token settings; do not erase flash. Reopen Camera afterward and verify
the badge says 800×600 and frames continue arriving alongside display ACKs.

## Checks

```powershell
npm.cmd run check
npm.cmd run build
Push-Location CV
..\.venv\Scripts\python.exe -m unittest test_slide_gestures test_camera_bridge
Pop-Location
node --import tsx scripts/gesture-check.ts
```

Python checks use synthetic landmarks and a generated blank JPEG, including
the real hand model. They do not open any camera. Native resolution, frame
rate, gesture accuracy, and simultaneous TFT streaming still require a live
device check.
