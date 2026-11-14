import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '../src/host/application.ts';
import { DISPLAY_SLIDE_LABELS } from '../src/pet/slides.ts';
import type { HandPose, HandTracking } from '../src/cv/tracking.ts';
import { drawHandOverlay, parsePreviewMetadata } from './gesture-overlay.ts';
import './camera.css';

type Action = (path: string, body?: Record<string, unknown>) => Promise<boolean>;
export const GESTURE_GUIDE: Array<{ pose: HandPose; symbol: string; title: string; action: string; hint: string }> = [
  { pose: 'fist', symbol: 'Ⅱ / ▶', title: 'Close your fist', action: 'Play / pause music', hint: 'Open your hand before toggling again.' },
  { pose: 'point_right', symbol: '→', title: 'Point one finger right', action: 'Next display screen', hint: 'Extend your index finger; curl the others.' },
  { pose: 'point_left', symbol: '←', title: 'Point one finger left', action: 'Previous display screen', hint: 'Direction follows the camera picture.' },
  { pose: 'rotate_right', symbol: '▶|', title: 'Tilt an open palm right', action: 'Next Spotify track', hint: 'Spread all five fingers and tilt your hand.' },
  { pose: 'rotate_left', symbol: '|◀', title: 'Tilt an open palm left', action: 'Previous Spotify track', hint: 'Keep the whole hand visible.' },
  { pose: 'index_pointing', symbol: '↻', title: 'Circle a raised index finger', action: 'Adjust volume', hint: 'Point upward. Clockwise raises volume; reverse lowers it.' },
  { pose: 'open_hand', symbol: '✦', title: 'Wave an open hand', action: 'Greet Sprout', hint: 'Move your open hand slowly side to side.' },
];

function FingerPreview({ enabled, message, onTracking }: { enabled: boolean; message: string; onTracking: (tracking: HandTracking | null) => void }) {
  const surface = useRef<HTMLCanvasElement>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(staleTimer);
      surface.current?.getContext('2d')?.clearRect(0, 0, surface.current.width, surface.current.height);
      setFresh(false); onTracking(null);
    };
    clear();
    const poll = async () => {
      try {
        const response = await fetch('/api/cv/preview', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
        if (controller.signal.aborted) return;
        if (response.status === 204) { clear(); return; }
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('preview');
        const metadata = parsePreviewMetadata(response.headers.get('x-gesture-frame'));
        const blob = await response.blob();
        if (!metadata || blob.size > 512 * 1024) throw new Error('preview');
        const bitmap = await createImageBitmap(blob);
        try {
          if (controller.signal.aborted) return;
          if (bitmap.width !== metadata.width || bitmap.height !== metadata.height) throw new Error('dimensions');
          const canvas = surface.current, context = canvas?.getContext('2d');
          if (!canvas || !context) return;
          canvas.width = metadata.width; canvas.height = metadata.height;
          context.drawImage(bitmap, 0, 0);
          drawHandOverlay(context, canvas.width, canvas.height, metadata.tracking);
          onTracking(metadata.tracking); setFresh(true);
          clearTimeout(staleTimer); staleTimer = setTimeout(clear, 1500);
        } finally { bitmap.close(); }
      } catch { if (!controller.signal.aborted) clear(); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 200); }
    };
    if (enabled) void poll();
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(staleTimer); };
  }, [enabled, onTracking]);
  return <div className="finger-preview"><canvas ref={surface} width={800} height={600} aria-label="ESP32 camera with detected finger joints"/>
    {!fresh && <span className="camera-loading">{enabled ? 'Waiting for a fresh camera frame…' : message}</span>}
    {fresh && <span className="finger-preview-label">Finger points · analyzed frames</span>}
  </div>;
}

export function Camera({ s, action }: { s: AppSnapshot; action: Action }) {
  const [viewing, setViewing] = useState(false), [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<'video' | 'landmarks'>('video'), [tracking, setTracking] = useState<HandTracking | null>(null);
  const configured = !!s.settings.device.address && s.secrets.deviceTokenSet;
  const gesturesOn = s.cvMusic.phase === 'live' || s.cvMusic.phase === 'starting';
  const resolution = s.camera.width && s.camera.height ? `${s.camera.width} × ${s.camera.height} native` : 'ESP32 camera';
  const detected = GESTURE_GUIDE.find(item => item.pose === tracking?.pose);
  const open = async (nextMode = mode) => {
    setFailed(false); setAttempt(a => a + 1); setViewing(true);
    if (nextMode === 'landmarks' && !gesturesOn) await action('/api/cv/start');
  };
  return <section className="camera-card card">
    <div className="card-top"><div><span className="eyebrow">A WINDOW TO YOUR DESK</span><h2>Companion camera</h2></div><span className="pill lilac">{resolution}</span></div>
    <div className="camera-modes"><div className="segmented" role="group" aria-label="Camera view mode">
      <button aria-pressed={mode === 'video'} className={mode === 'video' ? 'selected' : ''} onClick={() => { setMode('video'); setTracking(null); }}>Live video</button>
      <button aria-pressed={mode === 'landmarks'} className={mode === 'landmarks' ? 'selected' : ''} onClick={() => { setMode('landmarks'); if (configured) void open('landmarks'); }}>Finger points</button>
    </div><span className="muted">Finger points enables gesture controls.</span></div>
    <div className="camera-view">{viewing && !failed ? mode === 'landmarks' ?
      <FingerPreview enabled={gesturesOn} message={s.cvMusic.message} onTracking={setTracking}/> : <>
        <img key={attempt} src={`/api/camera/stream?view=${attempt}`} alt="Live ESP32 camera feed" onError={() => setFailed(true)}/>
        {s.camera.phase === 'loading' && <span className="camera-loading">Opening camera…</span>}
      </> : <div className="empty"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="m8 6 2-3h4l2 3"/></svg>
        <h3>{failed ? 'The camera needs a moment.' : 'Your desk, from a little closer.'}</h3>
        <p>{failed ? s.camera.message : 'Open the camera, or choose Finger points to see your hand and try the controls below.'}</p>
      </div>}</div>
    <div className="connection-actions">
      <button className="primary" disabled={!configured} onClick={() => void open()}>{failed ? 'Retry camera' : viewing ? 'Reconnect camera' : 'Open camera'}</button>
      <button className="secondary" disabled={!viewing} onClick={() => { setViewing(false); setTracking(null); }}>Stop viewing</button>
      <button className="secondary" disabled={!configured && !gesturesOn} onClick={() => void action(gesturesOn ? '/api/cv/stop' : '/api/cv/start')}>{gesturesOn ? 'Stop gestures' : 'Start gestures'}</button>
      <span className="muted">{s.camera.message}{s.camera.phase === 'live' && s.camera.deliveredFps !== null && ` · ${s.camera.deliveredFps.toFixed(1)} fps`}</span>
    </div>
    <div className="gesture-status">
      <span><span className="eyebrow">ON YOUR DISPLAY</span><strong>{DISPLAY_SLIDE_LABELS[s.companion.displaySlide]}</strong></span>
      {mode === 'landmarks' && <span role="status"><span className="eyebrow">HAND DETECTION</span><strong>{!tracking ? gesturesOn ? 'Waiting for detection' : 'Detection is off' : detected ? detected.title : tracking.landmarks.length ? 'Try a gesture below' : 'No hand detected'}</strong></span>}
      <span><span className="eyebrow">LAST GESTURE</span><strong>{s.cvMusic.lastGesture ? ({ music_toggle: 'Play / pause', slide_next: 'Next screen', slide_previous: 'Previous screen', music_next: 'Next track', music_previous: 'Previous track', volume_change: 'Volume', greet: 'Greet Sprout' } as Record<string, string>)[s.cvMusic.lastGesture] : 'Waiting for a gesture'}</strong></span>
    </div>
    <p className="fineprint">{s.cvMusic.message}</p>
    <div className="gesture-guide-heading"><h3>What your hands can do</h3><p>Hold a pose briefly, then relax your hand to use it again. Left and right follow the picture.</p></div>
    <div className="gesture-guide">{GESTURE_GUIDE.map(item => <div key={item.pose} className={`gesture-guide-item${mode === 'landmarks' && tracking?.pose === item.pose ? ' detected' : ''}`}>
      <span className="gesture-symbol" aria-hidden="true">{item.symbol}</span><div><strong>{item.action}</strong><span>{item.title}</span><p>{item.hint}</p></div>
    </div>)}</div>
    {!s.spotify.connected && <p className="inline-note">Link Spotify for music controls. Display screens and greeting work without it.</p>}
    <p className="fineprint">Preview and gestures share one ESP32 feed. Stopping the preview leaves active gestures running. Finger points shows all 21 joints on the frame that was analyzed. No recording or facial recognition.</p>
    {s.camera.width !== null && s.camera.width < 800 && <p className="inline-note">The camera is sending {s.camera.width} × {s.camera.height}. Install the updated ESP firmware for 800 × 600 capture.</p>}
    {!configured && <p className="inline-note">Add your device address and token in Settings to use the camera.</p>}
  </section>;
}
