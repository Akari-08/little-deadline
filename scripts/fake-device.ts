/**
 * Run the SIMULATED TaskPet Link device on this PC for hardware-free development.
 * It uses the device token already saved with `npm run configure -- token`, so no token
 * is printed or passed on the command line. Its sensor data is synthetic.
 *
 *   npm run fake-device [-- --port 8181 --env BME280|BMP280|none --no-imu]
 *   then: npm run configure -- address 127.0.0.1:8181
 *
 * Keys while running: d = drop connections (Wi-Fi loss), r = reboot, s = toggle frozen
 * telemetry, q / Ctrl+C = quit.
 */
import { parseArgs } from 'node:util';
import { SimulatedDevice } from '../src/simulator/simulated-device.ts';
import { AppStorage } from '../src/host/storage.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8181' },
    env: { type: 'string', default: 'BME280' },
    'no-imu': { type: 'boolean', default: false },
  },
});
const env = values.env;
if (env !== 'BME280' && env !== 'BMP280' && env !== 'none') {
  console.error('--env must be BME280, BMP280 or none');
  process.exit(1);
}
const token = new AppStorage().loadDeviceToken();
if (!token) {
  console.error('No device token saved. Run: npm run configure -- token');
  process.exit(1);
}

const device = new SimulatedDevice({ token, port: Number(values.port), environmentKind: env, imuPresent: !values['no-imu'] });
const url = await device.start();
console.log('================================================================');
console.log(' SIMULATED TaskPet device - NOT HARDWARE. Sensor data is fake.');
console.log(`  Listening on ${url} (loopback only)`);
console.log(`  Environment: ${env}${env === 'BMP280' ? ' (humidity unavailable)' : ''}; IMU: ${values['no-imu'] ? 'missing' : 'present'}`);
console.log('  Keys: d = drop link, r = reboot, s = freeze/unfreeze telemetry, q = quit');
console.log('================================================================');

let silent = false;
const quit = async () => { await device.stop(); process.exit(0); };
setInterval(() => {
  console.log(`[sim] app=${device.ownerConnected ? 'connected' : 'none'} frames=${device.stats.framesCompleted} ` +
    `auth_ok=${device.stats.authenticated} auth_failed=${device.stats.authFailures} busy=${device.stats.busyRejections} ` +
    `errors=${device.stats.errorsSent.length ? device.stats.errorsSent.slice(-3).join(',') : 'none'}`);
}, 5000).unref();

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003') void quit();
    else if (key === 'd') { device.dropConnections(); console.log('[sim] dropped all connections'); }
    else if (key === 'r') { device.reboot(); console.log('[sim] rebooted (uptime/counters reset, image cleared)'); }
    else if (key === 's') { silent = !silent; device.setSilent(silent); console.log(`[sim] telemetry ${silent ? 'frozen' : 'resumed'}`); }
  });
}
process.on('SIGINT', () => void quit());
