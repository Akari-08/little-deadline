import { HAND_CONNECTIONS, parseHandTracking, type HandTracking } from '../src/cv/tracking.ts';

export type PreviewMetadata = { timestamp: number; width: number; height: number; tracking: HandTracking };
export function parsePreviewMetadata(header: string | null): PreviewMetadata | null {
  if (!header || header.length > 4096) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(header); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const { timestamp, width, height } = value, tracking = parseHandTracking(value.tracking);
  if (!tracking || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
    typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 8192 ||
    typeof height !== 'number' || !Number.isInteger(height) || height < 1 || height > 8192) return null;
  return { timestamp, width, height, tracking };
}

/** Draw on the exact decoded camera frame; CSS can scale the result as a unit. */
export function drawHandOverlay(context: CanvasRenderingContext2D, width: number, height: number, tracking: HandTracking): void {
  if (tracking.landmarks.length !== 21) return;
  const scale = Math.max(1, width / 400), points = tracking.landmarks;
  context.save(); context.lineCap = 'round'; context.lineJoin = 'round';
  for (const [from, to] of HAND_CONNECTIONS) {
    const a = points[from]!, b = points[to]!;
    context.beginPath(); context.moveTo(a[0] * width, a[1] * height); context.lineTo(b[0] * width, b[1] * height);
    context.strokeStyle = '#10233c'; context.lineWidth = 4 * scale; context.stroke();
    context.strokeStyle = '#75d8ff'; context.lineWidth = 2 * scale; context.stroke();
  }
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]!, tip = [4,8,12,16,20].includes(i);
    context.beginPath(); context.arc(x * width, y * height, (tip ? 4 : 2.7) * scale, 0, Math.PI * 2);
    context.fillStyle = tip ? '#ffda91' : '#e9f7ff'; context.fill();
    context.strokeStyle = '#10233c'; context.lineWidth = 1.2 * scale; context.stroke();
  }
  context.restore();
}
