/** A disconnected or replaced event stream must never authorize a new call. */
export class SessionSyncGate {
  private generation = 0;
  private connected = false;

  attach(): number {
    this.connected = false;
    return ++this.generation;
  }
  open(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.connected = true;
    return true;
  }
  disconnect(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.connected = false;
    return true;
  }
  detach(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.connected = false;
    ++this.generation;
    return true;
  }
  isCurrent(generation: number): boolean { return generation === this.generation; }
  get ready(): boolean { return this.connected; }
}
