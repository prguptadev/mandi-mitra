/* Test harness only, loaded with `node --import <this file> …`: the
 * process clock starts at FAKE_NOW (an instant, e.g. 2026-10-02T19:30:00Z,
 * which is 01:00 on 3 October in India) and runs on from there. With
 * TZ=Europe/London it shows what a computer set to London sees at night in
 * India. Without FAKE_NOW it does nothing. */
const at = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : NaN;
if (process.env.FAKE_NOW && Number.isNaN(at)) throw new Error("FAKE_NOW must be an instant, e.g. 2026-10-02T19:30:00Z");
if (!Number.isNaN(at)) {
  const RealDate = Date;
  const shift = at - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + shift); else super(...a); }
    static now() { return RealDate.now() + shift; }
  }
  globalThis.Date = FakeDate;
}
