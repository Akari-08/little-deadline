/**
 * Device address parsing. Accepts an IP, the device-specific `taskpet-xxxxxx.local`
 * hostname, or a full `ws://host:81/` URL, and normalizes it to the URL form the
 * TaskPet Link connector requires. Addresses are not secrets; tokens never go here.
 */
export const DEVICE_PORT = 81;

export interface DeviceAddress {
  /** Normalized WebSocket URL, e.g. `ws://192.168.1.123:81/`. */
  url: string;
  hostname: string;
  port: number;
  /** mDNS name such as `taskpet-a1b2c3.local`; may fail to resolve on some networks. */
  isMdns: boolean;
  /**
   * This PC itself. A real ESP32 is never reachable on loopback, so a peer here is the
   * simulated device and its readings must be labelled simulated.
   */
  isLoopback: boolean;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export function parseDeviceAddress(input: string): Parsed<DeviceAddress> {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Enter the device address, e.g. 192.168.1.123 or taskpet-xxxxxx.local' };
  if (raw.length > 300) return { ok: false, error: 'Address is too long' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `ws://${raw}`);
  } catch {
    return { ok: false, error: 'Not a valid address' };
  }
  if (url.protocol !== 'ws:') {
    return { ok: false, error: 'TaskPet Link uses plain ws:// on your local network (not wss://, http:// or https://)' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Do not put credentials in the address; enter the device token in its own field' };
  }
  if (url.search || url.hash) return { ok: false, error: 'The address must not contain ? or # parts' };
  if (url.pathname !== '/') return { ok: false, error: 'TaskPet Link uses the root path / (e.g. ws://192.168.1.123:81/)' };

  const hostname = url.hostname;
  const isIpv6 = hostname.startsWith('[') && hostname.endsWith(']');
  const isHostname = hostname.length <= 253 && hostname.split('.').every(label => LABEL.test(label));
  if (!IPV4.test(hostname) && !isIpv6 && !isHostname) {
    return { ok: false, error: 'Use an IP address such as 192.168.1.123 or a hostname such as taskpet-a1b2c3.local' };
  }
  // ws:// defaults to port 80; the firmware listens on 81. An explicit port is kept
  // (useful for the local simulated device), otherwise 81 is used.
  if (url.port === '') url.port = String(DEVICE_PORT);
  return {
    ok: true,
    value: {
      url: url.href, hostname, port: Number(url.port),
      isMdns: hostname.toLowerCase().endsWith('.local'),
      isLoopback: /^127\./.test(hostname) || hostname.toLowerCase() === 'localhost' || hostname === '[::1]',
    },
  };
}
