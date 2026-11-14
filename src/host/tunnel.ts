/** Hostname suffixes served by ngrok tunnels (subdomains only). */
export const NGROK_HOST_SUFFIXES = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'];

/** True for an ngrok tunnel Host header such as `abc-123.ngrok-free.app` (optionally `:443`). */
export function isNgrokHost(host: string): boolean {
  const name = host.toLowerCase().replace(/:443$/, '');
  return /^[a-z0-9.-]+$/.test(name) && NGROK_HOST_SUFFIXES.some(suffix => name.endsWith(suffix) && name.length > suffix.length);
}
