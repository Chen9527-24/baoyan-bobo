interface FirstAudioObservation {
  replyId: string;
  milliseconds: number;
}

interface FirstAudioObserverOptions {
  startedAt: number;
  replyId: string;
  isCurrent: () => boolean;
  report: (observation: FirstAudioObservation) => Promise<unknown>;
  now?: () => number;
}

/** Call only from actual playback start, never from a downloaded file or text fallback. */
export function createFirstAudioObserver(options: FirstAudioObserverOptions): () => void {
  let reported = false;
  return () => {
    if (reported || !options.isCurrent()) return;
    const elapsed = (options.now ?? (() => performance.now()))() - options.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 90_000) return;
    reported = true;
    // Observation failure must not interfere with reply playback.
    try {
      void options.report({ replyId: options.replyId, milliseconds: Math.round(elapsed) }).catch(() => {});
    } catch { /* A transport unavailable at playback start is an omitted observation. */ }
  };
}
