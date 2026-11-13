// Transport test only, not a pet application. Node.js 22+, no npm install.
// Credentials are read from local environment variables, never printed.
import { TaskPetLink, rgbaToRGB565LE, WIDTH, HEIGHT } from './taskpet-link.mjs';

const url = process.env.TASKPET_URL;
const token = process.env.TASKPET_TOKEN;
if (!url || !token) {
  console.error('Set TASKPET_URL=ws://DEVICE_IP:81/ and TASKPET_TOKEN locally. See README.txt.');
  process.exit(1);
}
let lastSensorLog = 0;
const link = new TaskPetLink({ url, token, onSensors: sample => {
  if (Date.now() - lastSensorLog > 1000) {
    lastSensorLog = Date.now();
    console.log(JSON.stringify(sample));
  }
}});
process.on('SIGINT', () => { link.disconnect(); process.exit(0); });
try {
  const ready = await link.connect();
  console.log('Authenticated display:', ready.width, 'x', ready.height, ready.format);
  const started = Date.now();
  for (let frame = 0; frame < 50; ++frame) {
    const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; ++y) for (let x = 0; x < WIDTH; ++x) {
      const i = (y * WIDTH + x) * 4;
      // Red/green/blue bands with a white moving square.
      const white = x >= (frame * 4) % 220 && x < (frame * 4) % 220 + 20 && y >= 140 && y < 160;
      rgba[i] = white || y < 107 ? 255 : 0;
      rgba[i + 1] = white || (y >= 107 && y < 214) ? 255 : 0;
      rgba[i + 2] = white || y >= 214 ? 255 : 0;
      rgba[i + 3] = 255;
    }
    const ack = await link.sendFrame(rgbaToRGB565LE(rgba));
    if (frame % 10 === 0) console.log('Frame', ack.frame_id, 'acknowledged; TFT draw ms:', ack.draw_ms);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('PASS: 50 complete frames acknowledged. Elapsed ms:', Date.now() - started);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  link.disconnect();
}
