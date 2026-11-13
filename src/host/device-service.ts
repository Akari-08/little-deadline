/**
 * DeviceService: the one place in the host process that owns the device connection.
 * It wires the supervisor (single socket + reconnect), the frame streamer (ACK-paced,
 * newest-frame-only) and the sensor tracker (validated, status-labelled telemetry).
 * UI code talks to this through narrow host methods/events; it never opens a socket.
 */
import { DeviceSupervisor, type ConnectionStatus, type SupervisorOptions } from '../device/supervisor.ts';
import { FrameStreamer, type FrameSource, type StreamStats } from '../device/streamer.ts';
import { parseSensorMessage } from '../sensors/validate.ts';
import { SensorTracker, type IngestResult, type SensorSnapshot } from '../sensors/tracker.ts';
import { Emitter } from '../util/emitter.ts';
import { realScheduler, type Scheduler } from '../util/scheduler.ts';
import { parseDeviceAddress } from '../device/address.ts';

export interface DeviceDiagnostics {
  connection: ConnectionStatus;
  stream: StreamStats;
  sensors: SensorSnapshot;
  /**
   * True only with an authenticated session AND recent inbound traffic. Use this (not the
   * phase alone) for any "connected/streaming" badge.
   */
  live: boolean;
}

export interface DeviceServiceEvents extends Record<string, unknown> {
  status: ConnectionStatus;
  /** A validated telemetry update with derived events (presses, reboot, new env sample). */
  sensors: IngestResult;
  /** Liveness changed (authenticated AND recent traffic). Drive any "connected" badge from this. */
  live: boolean;
}

export interface DeviceServiceOptions {
  source: FrameSource;
  scheduler?: Scheduler;
  targetFps?: number;
  supervisor?: SupervisorOptions;
  /** Inbound-traffic age beyond which the link is not shown as live. */
  liveTrafficMs?: number;
}

export class DeviceService extends Emitter<DeviceServiceEvents> {
  readonly supervisor: DeviceSupervisor;
  readonly streamer: FrameStreamer;
  readonly tracker: SensorTracker;
  private readonly liveTrafficMs: number;
  private readonly scheduler: Scheduler;
  private readonly unsubscribers: Array<() => void> = [];
  private lastLive = false;
  private liveTimer: unknown = null;

  constructor(options: DeviceServiceOptions) {
    super();
    const scheduler = options.scheduler ?? realScheduler;
    this.scheduler = scheduler;
    this.liveTrafficMs = options.liveTrafficMs ?? 2000;
    this.supervisor = new DeviceSupervisor({ scheduler, ...options.supervisor });
    this.tracker = new SensorTracker({ scheduler });
    this.streamer = new FrameStreamer({
      supervisor: this.supervisor, source: options.source, scheduler,
      ...(options.targetFps !== undefined ? { targetFps: options.targetFps } : {}),
    });

    this.unsubscribers.push(
      // Loopback peers are the simulated device: never label their data as physical readings.
      this.supervisor.on('sessionStarted', () =>
        this.tracker.sessionStarted(this.peerIsSimulated() ? 'simulated' : 'device', this.supervisor.status().url)),
      this.supervisor.on('sessionEnded', () => this.tracker.sessionEnded()),
      this.supervisor.on('status', status => { this.emit('status', status); this.checkLive(); }),
      this.supervisor.on('sensors', ({ raw }) => {
        const parsed = parseSensorMessage(raw);
        if (!parsed.ok) return;
        this.emit('sensors', this.tracker.ingest(parsed.message, parsed.issues));
      }),
    );
    this.streamer.start();
    this.pollLive();
  }

  /** Traffic age changes without events, so liveness is re-evaluated periodically. */
  private pollLive(): void {
    this.checkLive();
    this.liveTimer = this.scheduler.setTimeout(() => this.pollLive(), 250);
  }

  private checkLive(): void {
    const live = this.diagnostics().live;
    if (live === this.lastLive) return;
    this.lastLive = live;
    this.emit('live', live);
  }

  configure(target: { address: string | null; token: string | null }): void { this.supervisor.configure(target); }
  connect(): void { this.supervisor.connect(); }
  disconnect(): void { this.supervisor.disconnect(); }
  setTargetFps(fps: number): void { this.streamer.setTargetFps(fps); }

  /** True when connected to a loopback peer (the simulated device), not real hardware. */
  peerIsSimulated(): boolean {
    const url = this.supervisor.status().url;
    const parsed = url ? parseDeviceAddress(url) : null;
    return parsed?.ok === true && parsed.value.isLoopback;
  }

  diagnostics(): DeviceDiagnostics {
    const connection = this.supervisor.status();
    return {
      connection,
      stream: this.streamer.stats(),
      sensors: this.tracker.snapshot(),
      live: connection.phase === 'ready' && connection.lastTrafficAgeMs !== null &&
        connection.lastTrafficAgeMs <= this.liveTrafficMs,
    };
  }

  async dispose(): Promise<void> {
    if (this.liveTimer !== null) this.scheduler.clearTimeout(this.liveTimer);
    this.liveTimer = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.supervisor.disconnect();
    await this.streamer.dispose();
  }
}
