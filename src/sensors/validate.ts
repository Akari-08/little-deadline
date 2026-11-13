/**
 * Boundary validation for TaskPet Link `sensors` JSON. Each field is checked for type and
 * plausible range; anything else becomes null and is listed in `issues`. A reading is only
 * marked valid when the device said so AND its core fields survived validation.
 */
import type { ButtonReading, EnvironmentKind, EnvironmentReading, ImuReading, SensorMessage, Vec3 } from './types.ts';

export type SensorParseResult =
  | { ok: true; message: SensorMessage; issues: string[] }
  | { ok: false; error: string };

// Ranges: MPU6050 is configured for +/-4 g and +/-500 deg/s (PROTOCOL.txt); limits leave headroom.
const ACCEL_LIMIT = 80;        // m/s^2 (4 g = 39.2)
const GYRO_LIMIT = 20;         // rad/s (500 deg/s = 8.73)
const MPU_TEMP = [-60, 125] as const;
const ENV_TEMP = [-60, 100] as const;
const PRESSURE = [300, 1100] as const;
const HUMIDITY = [0, 100] as const;
const RSSI = [-127, -1] as const; // 0 means "no reading" on ESP32

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function parseSensorMessage(raw: unknown): SensorParseResult {
  if (!isObj(raw) || raw.type !== 'sensors') return { ok: false, error: 'Not a sensors message' };
  const issues: string[] = [];

  const num = (value: unknown, [lo, hi]: readonly [number, number], field: string): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi) return value;
    issues.push(`${field} out of range`);
    return null;
  };
  const uint = (value: unknown, field: string): number | null => {
    if (value === null || value === undefined) return null;
    if (isUint32(value)) return value;
    issues.push(`${field} is not a uint32`);
    return null;
  };
  const vec = (value: unknown, limit: number, field: string): Vec3 | null => {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value) && value.length === 3 &&
        value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit)) {
      return [value[0], value[1], value[2]] as Vec3;
    }
    // [null, null, null] is the device's normal "invalid" encoding; only flag other shapes.
    if (!(Array.isArray(value) && value.every(v => v === null))) issues.push(`${field} out of range`);
    return null;
  };

  // IMU ---------------------------------------------------------------------
  const imuRaw = isObj(raw.imu) ? raw.imu : {};
  if (!isObj(raw.imu)) issues.push('imu missing');
  const imuClaimsValid = imuRaw.valid === true;
  let imu: ImuReading = {
    present: imuRaw.present === true,
    valid: false,
    sampleMs: null, accel: null, gyro: null, chipTemperatureC: null, rollDeg: null, pitchDeg: null,
  };
  if (imuClaimsValid) {
    imu = {
      ...imu,
      sampleMs: uint(imuRaw.sample_ms, 'imu.sample_ms'),
      accel: vec(imuRaw.accel_m_s2, ACCEL_LIMIT, 'imu.accel_m_s2'),
      gyro: vec(imuRaw.gyro_rad_s, GYRO_LIMIT, 'imu.gyro_rad_s'),
      chipTemperatureC: num(imuRaw.temperature_c, MPU_TEMP, 'imu.temperature_c'),
      rollDeg: num(imuRaw.roll_deg, [-180, 180], 'imu.roll_deg'),
      pitchDeg: num(imuRaw.pitch_deg, [-180, 180], 'imu.pitch_deg'),
    };
    imu.valid = imu.sampleMs !== null && imu.accel !== null && imu.gyro !== null;
  }

  // Environment -------------------------------------------------------------
  const envRaw = isObj(raw.environment) ? raw.environment : {};
  if (!isObj(raw.environment)) issues.push('environment missing');
  const kind: EnvironmentKind =
    envRaw.kind === 'BME280' || envRaw.kind === 'BMP280' ? envRaw.kind : 'none';
  if (envRaw.kind !== undefined && envRaw.kind !== kind) issues.push('environment.kind unknown');
  let environment: EnvironmentReading = {
    kind, valid: false, sampleMs: null, temperatureC: null, pressureHpa: null, humidityPct: null,
  };
  if (kind !== 'none' && envRaw.valid === true) {
    environment = {
      ...environment,
      sampleMs: uint(envRaw.sample_ms, 'environment.sample_ms'),
      temperatureC: num(envRaw.temperature_c, ENV_TEMP, 'environment.temperature_c'),
      pressureHpa: num(envRaw.pressure_hpa, PRESSURE, 'environment.pressure_hpa'),
      // BMP280 has no humidity sensor: never accept a value for it.
      humidityPct: kind === 'BME280' ? num(envRaw.humidity_pct, HUMIDITY, 'environment.humidity_pct') : null,
    };
    environment.valid = environment.sampleMs !== null && environment.temperatureC !== null &&
      environment.pressureHpa !== null && (kind !== 'BME280' || environment.humidityPct !== null);
  }

  // Button / display / Wi-Fi -------------------------------------------------
  const buttonRaw = isObj(raw.button) ? raw.button : {};
  const button: ButtonReading = {
    enabled: buttonRaw.enabled === true,
    pressed: typeof buttonRaw.pressed === 'boolean' ? buttonRaw.pressed : null,
    pressCount: uint(buttonRaw.press_count, 'button.press_count'),
  };
  const displayRaw = isObj(raw.display) ? raw.display : {};

  return {
    ok: true,
    issues,
    message: {
      seq: uint(raw.seq, 'seq'),
      uptimeMs: uint(raw.uptime_ms, 'uptime_ms'),
      imu,
      environment,
      button,
      display: { frames: uint(displayRaw.frames, 'display.frames'), lastFrameId: uint(displayRaw.last_frame_id, 'display.last_frame_id') },
      rssiDbm: num(raw.rssi_dbm, RSSI, 'rssi_dbm'),
    },
  };
}
