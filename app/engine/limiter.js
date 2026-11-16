'use strict';
/** Shared speed limiter (token bucket) for all downloads. rate = bytes per second, 0 = unlimited. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Limiter {
  constructor() { this.rate = 0; this.tokens = 0; this.last = Date.now(); }

  setRate(bytesPerSec) {
    this.rate = Math.max(0, bytesPerSec || 0);
    this.tokens = 0;
    this.last = Date.now();
  }

  refill() {
    const now = Date.now();
    // allow a small burst (0.25 s worth) so throughput stays smooth
    this.tokens = Math.min(this.rate * 0.25, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  /** Wait until `n` bytes may be used. Debt is allowed, so big chunks never block forever. */
  async take(n, isStopped) {
    while (this.rate > 0) {
      this.refill();
      if (this.tokens >= 0) { this.tokens -= n; return; }
      if (isStopped && isStopped()) return;
      await sleep(Math.min(1000, Math.max(5, (-this.tokens / this.rate) * 1000)));
    }
  }
}

module.exports = { Limiter };
