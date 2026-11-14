/** Bounded, non-persistent hand landmarks for the optional camera guide. */
export const HAND_POSES = ['fist', 'point_right', 'point_left', 'index_pointing', 'rotate_right', 'rotate_left',
  'open_hand', 'two_fingers', 'two_fingers_right', 'two_fingers_left', 'unknown'] as const;
export type HandPose = typeof HAND_POSES[number];
export type HandTracking = { pose: HandPose | null; landmarks: Array<[number, number]> };
export const EMPTY_TRACKING: HandTracking = { pose: null, landmarks: [] };
export function parseHandTracking(raw: unknown): HandTracking | null {
  if (!raw || typeof raw !== 'object') return null;
  const { pose, landmarks } = raw as Record<string, unknown>;
  if (!Array.isArray(landmarks)) return null;
  if (pose === null && landmarks.length === 0) return { pose: null, landmarks: [] };
  if (typeof pose !== 'string' || !HAND_POSES.includes(pose as HandPose) || landmarks.length !== 21) return null;
  const points: Array<[number, number]> = [];
  for (const point of landmarks) {
    // MediaPipe may place a partly clipped hand just beyond the image boundary.
    if (!Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < -1 || v > 2)) return null;
    points.push([point[0] as number, point[1] as number]);
  }
  return { pose: pose as HandPose, landmarks: points };
}
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8], [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16], [13,17],[0,17],[17,18],[18,19],[19,20],
];
