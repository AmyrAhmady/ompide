/** Bound automatic restarts within a minute; a manual restart explicitly resets the budget. */
export class RecoveryPolicy {
  private since = 0;

  private attempts = 0;

  next(now = Date.now()): number | undefined {
    if (now - this.since >= 60_000) {
      this.since = now;
      this.attempts = 0;
    }
    return [250, 1000, 3000][this.attempts++];
  }

  reset(): void {
    this.since = Date.now();
    this.attempts = 0;
  }
}
