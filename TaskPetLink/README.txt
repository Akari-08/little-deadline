TASKPET LINK — WI-FI SCREEN + SENSOR BRIDGE

This package is the link only. Build the pet and all app/backend logic separately.
Your machine renders a 240x320 image. The ESP32 displays those pixels and sends
sensor data back through the same WebSocket. No task/dashboard/pet logic is
embedded in this firmware. Canvas and Notion credentials belong on your machine.

PACKAGE
  firmware/TaskPetLink/TaskPetLink.ino  Arduino bridge firmware
  firmware/TaskPetLink/secrets.example.h  empty local configuration template
  client/taskpet-link.mjs  browser/Node ES module; no npm dependencies
  client/smoke-test.mjs    moving color-pattern + telemetry transport test
  client/taskpet-link.test.mjs  automated connector/protocol tests
  client/loopback-test.mjs      real local WebSocket transport test
  PROTOCOL.txt            versioned interface for any app/language
  BUILD_CHECK.txt         validation results and limits

ONE-TIME DEVICE SETUP
1. Open firmware/TaskPetLink/TaskPetLink.ino in Arduino IDE 2.x.
2. Boards Manager URL, if esp32 is not already installed:
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   Install esp32 by Espressif Systems 3.3.3.
3. Board: ESP32 Wrover Module (classic ESP32).
   Flash mode DIO; flash frequency 40 MHz; CPU 240 MHz; upload speed 115200;
   Default 4MB with spiffs partition. This board profile enables PSRAM.
   Verify the actual module/carrier and flash capacity before upload.
4. Library Manager: install the following exact versions; Install All dependencies:
   WebSockets by Markus Sattler / Links2004 2.7.2
   Adafruit ST7735 and ST7789 Library 1.11.0
   Adafruit GFX Library 1.12.6
   Adafruit MPU6050 2.2.9
   Adafruit BME280 Library 2.3.0
   Adafruit BMP280 Library 3.0.0
   Adafruit BusIO 1.17.4
   Adafruit Unified Sensor 1.1.15
   Dependency metadata can also install seesaw 1.7.9, SSD1306 2.5.17 and SD 1.3.0;
   these are not directly used by the bridge.
   WiFi, ESPmDNS, Wire, SPI, and ESP heap APIs come with the ESP32 core.
5. Copy secrets.example.h to secrets.h beside the .ino. Fill in only locally:
   LINK_WIFI_SSID, LINK_WIFI_PASSWORD, LINK_DEVICE_TOKEN.
   Use the same 2.4 GHz Wi-Fi LAN as your machine. An open network can use an
   empty password, but use your normal protected local network where possible.
   The device token must be 32-128 printable ASCII characters without spaces.
   Generate a random device token locally, for example with Node.js:
     node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
   Copy that token to secrets.h and your app's LOCAL configuration.
   This is a device-only token, never a Canvas/Notion service credential.
   Blank settings halt with a configuration message rather than opening access.
6. Verify and upload; open Serial Monitor at 115200. The display and serial log
   show a URL such as ws://192.168.1.123:81/ once connected. Use YOUR actual IP.
   The firmware also announces a device-specific taskpet-xxxxxx.local hostname.
   If .local does not resolve, use the IP. A router DHCP reservation stabilizes it.

WIRING (GPIO NUMBERS)
  TFT: MOSI23, SCLK18, CS27, DC26, RST25, BL control33. No MISO connection.
  MPU6050: SDA21/SCL22 on controller 0; address 0x68 or 0x69.
  BME280/BMP280: SDA32/SCL19 on controller 1; address 0x76 or 0x77.
  Future button: GPIO13 to GND; BUTTON_ENABLED=false until wired.
  All modules share GND; use 3.3 V logic and appropriate breakout supply ratings.
  Both I2C buses need pull-ups to 3.3 V (often already on the modules).
  For BME/BMP I2C, CSB must be high if exposed; SDO selects 0x76/0x77.
  BL33 requires a logic backlight input or suitable transistor/current limiting;
  never power a bare backlight LED directly from a GPIO.
  SPI MISO is explicitly -1 so it cannot take over environmental SCL19.
  Some ESP-WROVER-KIT carriers reserve GPIO32/33 for a crystal. Check the carrier
  schematic: WROVER-E identifies the module, not all carrier-board connections.
  Keep flash/PSRAM GPIO6-11/16/17 free.

APP INTEGRATION — JAVASCRIPT
Use client/taskpet-link.mjs from a local web app, Electron/desktop app, or Node 22+.
There is no app or server to install in this package.

Example integration into YOUR existing app code:

  import { TaskPetLink } from './taskpet-link.mjs';

  let latestSensors = null;
  const link = new TaskPetLink({
    url: deviceUrl,         // e.g. ws://192.168.1.123:81/
    token: deviceToken,     // read from your local settings
    onSensors: sample => { latestSensors = sample; },
    onStatus: status => { /* update your app connection indicator */ },
    onError: error => { /* stop the render loop and show a connection error */ }
  });
  await link.connect();

  // previewCanvas is YOUR 240x320 render surface:
  previewCanvas.width = 240;
  previewCanvas.height = 320;
  const ctx = previewCanvas.getContext('2d', { willReadFrequently: true });

  // In your app's paced async render loop:
  renderYourPet(ctx, latestSensors); // supplied by your app
  const acknowledgement = await link.sendCanvas(ctx);
  // Only now send the next/latest frame. Do not queue old animation frames.

The example names deviceUrl/deviceToken/previewCanvas/renderYourPet are supplied
by your app; they are not a second pet implementation hidden in this package.
Use a fixed 240x320 backing surface. You can enlarge its CSS preview while
preserving its backing dimensions. Composite an opaque background before sending;
alpha is ignored. The screen shows RGB565 quantized colors from that same surface.

Other entry points:
  await link.sendRGBA(imageData.data);   // exactly 307200 RGBA bytes
  await link.sendFrame(rgb565Bytes);     // exactly 153600 RGB565LE bytes
  link.disconnect();

sendFrame/sendRGBA/sendCanvas resolve only after the ESP32 acknowledges drawing.
Only one frame can be outstanding. The client caps queued socket data, times out
and closes uncertain connections, and rejects overlapping frame calls.
Callbacks run on the app thread: keep them short. The SDK does not automatically
reconnect or replay old frames. Your app can reconnect with backoff and render its
latest state after connect() resolves. Handle each rejected frame promise.

If using another language, implement PROTOCOL.txt. No browser-only graphics format
is required: Pillow, SDL, Skia, OpenGL, etc. can all export RGB565LE pixels.

FIRST END-TO-END LINK TEST (NO APP NEEDED)
With Node.js 22+ installed, open PowerShell in this package's folder:

  $env:TASKPET_URL = 'ws://YOUR_DEVICE_IP:81/'
  $env:TASKPET_TOKEN = 'YOUR_LOCAL_DEVICE_TOKEN'
  node .\client\smoke-test.mjs

Use local values; do not paste real credentials into chat or commit them.
The test sends 50 color-pattern frames, prints acknowledgements and sensor JSON,
and exits. Expect red, green and blue horizontal bands and a moving white square.
It does not install or create the Tamagotchi app. The test prints no token.
Remove the token from that shell afterwards if desired:
  Remove-Item Env:TASKPET_TOKEN

HARDWARE TEST CHECKLIST
1. Startup: serial reports MPU detected and BME280/BMP280 type, plus Wi-Fi URL.
2. Authenticate from your machine. Expect ready metadata, then sensor JSON.
3. Run the smoke test: all 50 frames should receive matching frame_ack messages.
   Screen colors, orientation and square motion should match the test pattern.
4. Tilt the MPU: accel/gyro/roll/pitch fields should change in telemetry.
   Environment sample_ms updates about once a second. BMP humidity must be null.
5. Disconnect the app: last completed image must remain. Reconnect and stream
   fresh frames. Restarting ESP32 shows connection status until a new frame arrives.
6. Power off to disconnect a sensor, restart, and reconnect: missing/invalid
   readings must be null with valid=false; screen streaming must still work.
   Power off to reconnect wiring. Restart or send serial i to re-detect sensors.
7. Wrong device token: authentication should fail and the socket should close.
8. With your own protocol client, send a wrong-length/out-of-order strip: expect
   an error and no partial new frame committed. The supplied SDK closes on errors.

PERFORMANCE AND BEHAVIOR
Start at 5 frames per second and tune after measuring. A raw frame is 153600 bytes;
5 fps is 6.144 Mbit/s of image payload before network overhead. This is raw image
streaming, not H.264/video. No full application runs on the ESP32.
20 MHz TFT SPI alone needs at least about 61 ms per full-screen pixel transfer;
Wi-Fi transfer and other work add latency. Do not expect 60 fps.
The device stages one whole frame in PSRAM when available, then copies it to the
TFT. The TFT scanout itself can still show tearing; no TE pin is used.
Motion sampling and telemetry target 20 Hz while idle; environment targets 1 Hz.
Display writes/network library processing share the main loop, so effective
sensor rate can fall while streaming. sample_ms/uptime_ms let the app detect age.
Motion estimates are accelerometer gravity estimates, not fused orientation/yaw.
Streaming does not require sensors to be present. No automatic I2C bus recovery
for stuck-low electrical faults is included. Serial i retries detection.
An incomplete frame is discarded after a 2-second gap between strips, without
changing the TFT. Client ACK timeout defaults to 5 seconds for the whole frame.
The last completed image remains if the app or Wi-Fi disconnects; it may be stale.
If a stale-image indicator is desired, draw it in the app before intentional stop.

SECURITY / CONNECTION SCOPE
Use only on your trusted local network. Device token gates pixels and sensor
telemetry, but ws:// is not encrypted. Do not expose port 81 to the Internet.
secrets.h is ignored by Git, but compiled device credentials are recoverable
with device access. Never distribute secrets.h or a credential-bearing binary.
HTTPS-hosted browser apps may block plain ws://; use your local desktop/backend
connector for that deployment. Check browser local-network permissions as needed.
AP/client isolation or a guest Wi-Fi network can prevent the machine reaching
the ESP32 even when both have Wi-Fi. No cloud relay or router changes are needed.

WHAT REQUIRES FUTURE FIRMWARE CHANGES
Pet appearance, animation, tasks, Canvas/Notion APIs and app settings stay on your
machine. Firmware changes are needed only for new hardware, a different transport
or protocol, display size/driver changes, or bridge bug fixes. Changing the Wi-Fi
credentials/device token currently means editing local secrets.h and reflashing.
There is no claim that firmware will never need maintenance.

AUTOMATED CLIENT TESTS
  node --test .\client\taskpet-link.test.mjs
These exercise the actual connector with a simulated WebSocket peer. They do not
prove physical sensor accuracy, Wi-Fi throughput or TFT operation.
Also exercise the native Node WebSocket implementation over loopback TCP:
  node .\client\loopback-test.mjs
This test listens only on 127.0.0.1 with an ephemeral port, sends two frames to an
independent protocol peer, and closes. It does not contact or emulate real sensors.

REFERENCES
https://github.com/Links2004/arduinoWebSockets/tree/2.7.2
https://docs.espressif.com/projects/arduino-esp32/en/latest/api/wifi.html
https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2c.html
https://github.com/adafruit/Adafruit-ST7735-Library/tree/1.11.0
