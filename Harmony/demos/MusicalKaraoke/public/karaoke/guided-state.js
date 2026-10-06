export class GuidedRunGate {
  constructor() {
    this.generation = 0;
    this.busy = false;
    this.token = null;
  }

  begin(page, step) {
    if (this.busy) return null;
    this.busy = true;
    this.token = Object.freeze({ generation: this.generation, page, step });
    return this.token;
  }

  isCurrent(token, page, step) {
    return Boolean(token)
      && this.busy
      && token === this.token
      && token.generation === this.generation
      && token.page === page
      && token.step === step;
  }

  finish(token, page, step, completed) {
    if (!this.isCurrent(token, page, step)) return false;
    this.busy = false;
    this.token = null;
    return completed === true;
  }

  cancel() {
    this.generation += 1;
    this.busy = false;
    this.token = null;
  }
}

export class SequentialReveal {
  constructor(total) {
    if (!Number.isInteger(total) || total < 1) throw new TypeError("total must be a positive integer");
    this.total = total;
    this.completed = 0;
  }

  get unlocked() { return Math.min(this.total, this.completed + 1); }
  get done() { return this.completed === this.total; }

  complete(index) {
    if (index !== this.completed || this.done) return false;
    this.completed += 1;
    return true;
  }
}
