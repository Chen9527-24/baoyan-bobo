import type { AudioController, ListeningOptions } from '../audio';

export type PressToTalkState = 'idle' | 'starting' | 'recording' | 'finishing';
type Capture = Pick<AudioController, 'startListening' | 'finishUtterance' | 'stopCapture'>;

/** Owns one deliberate press, including permission and finalization races. No DOM or network work. */
export class PressToTalkSession {
  private generation = 0;
  private phase: PressToTalkState = 'idle';

  constructor(private readonly audio: Capture, private readonly onState: (state: PressToTalkState) => void) {}

  get state(): PressToTalkState { return this.phase; }

  press(options: ListeningOptions): boolean {
    if (this.phase !== 'idle') return false;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.setState('starting');
    if (!current()) return false;
    const complete = (callback: () => void | Promise<void>) => {
      if (!current()) return;
      this.setState('idle');
      if (!current()) return;
      ++this.generation;
      return callback();
    };
    // Calling the audio controller directly here retains the pointer/keyboard activation.
    // Do not defer this start to an effect or a long-press timer.
    void this.audio.startListening({
      ...options,
      endMode: 'manual',
      onLevel: level => { if (current()) options.onLevel?.(level); },
      onSpeechStart: () => { if (current()) options.onSpeechStart?.(); },
      onProcessing: () => {
        if (!current()) return;
        this.setState('finishing');
        if (current()) options.onProcessing?.();
      },
      onUtterance: blob => {
        if (!current() || this.phase !== 'finishing') return;
        return complete(() => options.onUtterance(blob));
      },
      onSilence: () => {
        complete(() => options.onSilence?.());
      },
      onError: error => {
        complete(() => options.onError?.(error));
      },
    }).then(started => {
      if (!current()) return;
      // Finalization/cancellation may happen before this promise continuation.
      if (this.phase === 'starting') this.setState(started ? 'recording' : 'idle');
    }).catch(error => {
      complete(() => options.onError?.(error instanceof Error ? error : new Error('麦克风没有启动，请检查权限后再按住说话。')));
    });
    return true;
  }

  release(): void {
    if (this.phase === 'starting') { this.cancel(); return; }
    if (this.phase !== 'recording') return;
    const generation = this.generation;
    // Set this before finishUtterance because its callbacks may run synchronously.
    this.setState('finishing');
    if (generation !== this.generation) return;
    if (!this.audio.finishUtterance() && generation === this.generation) this.cancel();
  }

  cancel(): void {
    ++this.generation;
    this.audio.stopCapture();
    this.setState('idle');
  }

  private setState(state: PressToTalkState): void {
    this.phase = state;
    this.onState(state);
  }
}
