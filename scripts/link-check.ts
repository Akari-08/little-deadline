/**
 * Link check: streams the diagnostic TEST CARD (not the pet) through the full app stack
 * (supervisor + streamer + sensor validation) using the saved address/token, and prints
 * connection, FPS, ACK latency, draw time and sensor status. Use it for first hardware
 * bring-up, or against `npm run fake-device`.
 *
 *   npm run link-check [-- --seconds 30 --fps 5]
 *
 * Expected on the device: red / green / blue horizontal bands top to bottom, a white
 * border, and a white square moving left to right. ACKs confirm the driver write, not
 * what the panel optically shows: look at the screen.
 */
import { parseArgs } from 'node:util';
import { AppStorage } from '../src/host/storage.ts';
import { DeviceService } from '../src/host/device-service.ts';
import { TestCardSource } from '../src/render/test-card.ts';
import type { DataStatus } from '../src/sensors/types.ts';

const { values } = parseArgs({ options: { seconds: { type: 'string', default: '30' }, fps: { type: 'string' } } });
const storage = new AppStorage();
const settings = storage.loadSettings();
const token = storage.loadDeviceToken();
for (const warning of storage.warnings) console.warn(`Warning: ${warning}`);
if (!settings.device.address || !token) {
  console.error('Set the device first:\n  npm run configure -- address <ip-or-taskpet-xxxxxx.local>\n  npm run configure -- token');
  process.exit(1);
}

const source = new TestCardSource();
source.render();
const renderTimer = setInterval(() => source.render(), 50); // app render loop, independent of streaming
const service = new DeviceService({ source, targetFps: values.fps ? Number(values.fps) : settings.streaming.targetFps });
service.configure({ address: settings.device.address, token });

let lastPhase = '';
service.on('status', status => {
  const line = `${status.phase}${status.url ? ` ${status.url}` : ''}`;
  if (line === lastPhase) return;
  lastPhase = line;
  console.log(`[link] ${line}`);
  if ((status.phase === 'retrying' || status.phase === 'halted') && status.lastFailure) {
    console.log(`       ${status.lastFailure.kind}: ${status.lastFailure.message}` +
      (status.retryInMs !== null ? ` (retry in ${(status.retryInMs / 1000).toFixed(1)} s)` : ''));
  }
});

const fmt = (value: number | null | undefined, digits = 0, unit = '') => (value == null ? '--' : `${value.toFixed(digits)}${unit}`);
const tag = (status: DataStatus) => status.toUpperCase();
const report = setInterval(() => {
  const d = service.diagnostics();
  const s = d.sensors, m = s.latest;
  console.log(
    `[diag] ${d.live ? 'LIVE' : 'NOT LIVE'} | fps ${fmt(d.stream.deliveredFps, 1)}/${d.stream.targetFps} | ack ${fmt(d.stream.ackLatencyMs?.last, 0, ' ms')}` +
    ` (avg ${fmt(d.stream.ackLatencyMs?.average, 0)}) | draw ${fmt(d.stream.drawMs?.last, 0, ' ms')} | acked ${d.stream.framesAcked} failed ${d.stream.framesFailed}` +
    ` | telemetry age ${fmt(s.receiptAgeMs, 0, ' ms')} | rssi ${fmt(s.rssi.dbm, 0, ' dBm')}`);
  if (m) {
    console.log(
      `       IMU ${tag(s.imu.status)} roll ${fmt(m.imu.rollDeg, 1, '°')} pitch ${fmt(m.imu.pitchDeg, 1, '°')} chip ${fmt(m.imu.chipTemperatureC, 1, ' °C')}` +
      ` | ENV ${m.environment.kind} ${tag(s.environment.status)} ${fmt(m.environment.temperatureC, 1, ' °C')} ${fmt(m.environment.pressureHpa, 1, ' hPa')}` +
      ` humidity ${s.environment.humidity === 'unavailable' ? 'n/a' : fmt(m.environment.humidityPct, 1, ' %')} (age ${fmt(s.environment.deviceAgeMs, 0, ' ms')})` +
      ` | button ${m.button.enabled ? 'enabled' : 'disabled in firmware'}`);
  }
}, 2000);

const finish = async () => {
  clearInterval(report);
  clearInterval(renderTimer);
  const d = service.diagnostics();
  await service.dispose();
  console.log(`[done] frames acknowledged: ${d.stream.framesAcked}, failed: ${d.stream.framesFailed}. ` +
    'This checks software/transport only; confirm colours, orientation and motion on the actual screen.');
  process.exit(d.stream.framesAcked > 0 ? 0 : 1);
};
process.on('SIGINT', () => void finish());
setTimeout(() => void finish(), Number(values.seconds) * 1000);
service.connect();
