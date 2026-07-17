import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createLogger } from './logger.js';

const logger = createLogger('event-loop');

const CHECK_INTERVAL_MS = 5000;
const WARN_THRESHOLD_MS = 200;

/**
 * Logs a warning when the event loop's max delay over the last interval exceeds a threshold.
 * Diagnostic only: Discord slash-command acks and voice-gateway heartbeats both have hard
 * multi-second deadlines, so if the process is failing to respond in time, this is the first
 * place to look for confirmation before chasing a specific cause.
 */
export function startEventLoopMonitor(): void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  setInterval(() => {
    const maxMs = histogram.max / 1e6;
    if (maxMs > WARN_THRESHOLD_MS) {
      logger.warn(`イベントループの遅延を検知しました: max=${maxMs.toFixed(0)}ms (直近${CHECK_INTERVAL_MS / 1000}秒間)`);
    }
    histogram.reset();
  }, CHECK_INTERVAL_MS).unref();
}
