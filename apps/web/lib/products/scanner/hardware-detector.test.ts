import { describe, expect, it } from "vitest";
import { HARDWARE_SCAN_TUNING, HardwareScanDetector, type DetectorKey, type DetectorOutcome } from "./hardware-detector";
import { hasValidGs1CheckDigit } from "./barcode";

const EAN13 = "5000112637922";
const EAN8 = "96385074";
const UPCA = "036000291452";

// Drive the detector with synthetic timestamps — no real clock, no sleeps.
function feed(
  d: HardwareScanDetector,
  keys: string[],
  gaps: number | number[],
  startAt = 1000,
  extra: Partial<DetectorKey> = {}
) {
  let t = startAt;
  const out: DetectorOutcome[] = [];
  keys.forEach((key, i) => {
    if (i > 0) t += Array.isArray(gaps) ? gaps[i - 1] : gaps;
    out.push(d.push({ key, timeStamp: t, ...extra }));
  });
  return out;
}
const digits = (s: string) => s.split("");
const last = (o: DetectorOutcome[]) => o[o.length - 1];
const scans = (o: DetectorOutcome[]) => o.filter((x) => x.kind === "scan");

describe("test fixtures", () => {
  it("are actually valid GS1 codes", () => {
    for (const v of [EAN13, EAN8, UPCA]) expect(hasValidGs1CheckDigit(v)).toBe(true);
  });
});

describe("HardwareScanDetector — supported formats (exactly one scan each)", () => {
  it.each([
    ["EAN-13", EAN13],
    ["EAN-8", EAN8],
    ["UPC-A", UPCA],
  ])("fast valid %s + Enter", (_n, code) => {
    const out = feed(new HardwareScanDetector(), [...digits(code), "Enter"], 10);
    expect(scans(out)).toHaveLength(1);
    expect(last(out)).toEqual({ kind: "scan", value: code, terminator: "Enter" });
  });

  it("5–20 ms gaps still scan", () => {
    const gaps = Array.from({ length: 13 }, (_, i) => 5 + ((i * 7) % 16));
    const out = feed(new HardwareScanDetector(), [...digits(EAN13), "Enter"], gaps);
    expect(scans(out)).toHaveLength(1);
  });

  it("Tab terminator scans when a valid fast burst is buffered", () => {
    const out = feed(new HardwareScanDetector(), [...digits(EAN13), "Tab"], 8);
    expect(last(out)).toEqual({ kind: "scan", value: EAN13, terminator: "Tab" });
  });

  it("emits once and clears: a second Enter does nothing", () => {
    const d = new HardwareScanDetector();
    feed(d, [...digits(EAN13), "Enter"], 8);
    expect(d.bufferedLength).toBe(0);
    expect(d.push({ key: "Enter", timeStamp: 5000 })).toEqual({ kind: "ignored" });
  });

  it("back-to-back scans each emit once", () => {
    const d = new HardwareScanDetector();
    const a = feed(d, [...digits(EAN13), "Enter"], 8, 1000);
    const b = feed(d, [...digits(EAN8), "Enter"], 8, 3000);
    expect(scans(a)).toHaveLength(1);
    expect(scans(b)).toHaveLength(1);
  });
});

describe("HardwareScanDetector — human vs scanner timing", () => {
  it("slow human typing (100–300 ms gaps) is never a scan", () => {
    const gaps = Array.from({ length: 13 }, (_, i) => 100 + ((i * 53) % 200));
    const out = feed(new HardwareScanDetector(), [...digits(EAN13), "Enter"], gaps);
    expect(scans(out)).toHaveLength(0);
    expect(last(out)).toEqual({ kind: "ignored" });
  });

  it("a single slow gap mid-burst breaks the sequence", () => {
    const gaps = Array(13).fill(10);
    gaps[6] = HARDWARE_SCAN_TUNING.MAX_INTER_KEY_MS + 1;
    const out = feed(new HardwareScanDetector(), [...digits(EAN13), "Enter"], gaps);
    expect(scans(out)).toHaveLength(0);
  });

  it("borderline: every gap just under the per-key limit but mean too high is not a scan", () => {
    const out = feed(
      new HardwareScanDetector(),
      [...digits(EAN13), "Enter"],
      HARDWARE_SCAN_TUNING.MAX_INTER_KEY_MS - 2
    );
    expect(scans(out)).toHaveLength(0);
  });

  it("borderline: a late terminator is not a scan", () => {
    const gaps = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 120];
    expect(scans(feed(new HardwareScanDetector(), [...digits(EAN13), "Enter"], gaps))).toHaveLength(0);
  });

  it("a slow prefix followed by a fast valid burst still scans the burst", () => {
    const d = new HardwareScanDetector();
    feed(d, ["9", "9", "9"], 200, 1000); // human
    const out = feed(d, [...digits(EAN13), "Enter"], 8, 5000);
    expect(last(out)).toEqual({ kind: "scan", value: EAN13, terminator: "Enter" });
  });

  it("clock going backwards starts a new burst", () => {
    const d = new HardwareScanDetector();
    d.push({ key: "1", timeStamp: 1000 });
    expect(d.push({ key: "2", timeStamp: 900 })).toEqual({ kind: "buffering", started: true });
  });

  it("slow typing then Enter (manual entry) is left to normal behavior", () => {
    const out = feed(new HardwareScanDetector(), [...digits(EAN13), "Enter"], 150);
    expect(last(out)).toEqual({ kind: "ignored" });
  });
});

describe("HardwareScanDetector — length & characters", () => {
  it.each(["1", "12", "123", "1234567"])("fast %s digits + Enter is not a scan", (s) => {
    const out = feed(new HardwareScanDetector(), [...digits(s), "Enter"], 8);
    expect(scans(out)).toHaveLength(0);
    expect(last(out)).toEqual({ kind: "ignored" });
  });

  it("fast burst beyond 14 digits resets (noise)", () => {
    const out = feed(new HardwareScanDetector(), [...digits("1".repeat(15)), "Enter"], 8);
    expect(scans(out)).toHaveLength(0);
    expect(last(out).kind).toBe("ignored");
  });

  it("letters / symbols break the burst and never scan", () => {
    expect(scans(feed(new HardwareScanDetector(), [..."ABC123456789", "Enter"], 8))).toHaveLength(0);
    const mixed = [..."500011263", "x", ..."7922", "Enter"];
    expect(scans(feed(new HardwareScanDetector(), mixed, 8))).toHaveLength(0);
    expect(scans(feed(new HardwareScanDetector(), [..."ABCD1234EFGH", "Enter"], 8))).toHaveLength(0);
  });
});

describe("HardwareScanDetector — invalid identifiers", () => {
  it("fast 13 digits with a bad check digit is rejected, not scanned", () => {
    const out = feed(new HardwareScanDetector(), [...digits("5000112637921"), "Enter"], 8);
    expect(last(out)).toEqual({ kind: "rejected", raw: "5000112637921", terminator: "Enter" });
    expect(scans(out)).toHaveLength(0);
  });

  it("fast 10-digit burst (unsupported length) is rejected", () => {
    expect(last(feed(new HardwareScanDetector(), [...digits("1234567890"), "Enter"], 8)).kind).toBe("rejected");
  });

  it("fast 14-digit GTIN-14 (unsupported) is rejected", () => {
    expect(last(feed(new HardwareScanDetector(), [...digits("15000112637929"), "Enter"], 8)).kind).toBe("rejected");
  });
});

describe("HardwareScanDetector — modifiers, composition, repeat", () => {
  it("Ctrl/Alt/Meta digits never enter the buffer", () => {
    for (const mod of ["ctrlKey", "altKey", "metaKey"] as const) {
      const d = new HardwareScanDetector();
      const out = feed(d, [...digits(EAN13), "Enter"], 8, 1000, { [mod]: true });
      expect(scans(out)).toHaveLength(0);
      expect(d.bufferedLength).toBe(0);
    }
  });

  it("a shortcut in the middle of a burst resets it", () => {
    const d = new HardwareScanDetector();
    feed(d, digits("50001126"), 8);
    d.push({ key: "v", timeStamp: 1100, ctrlKey: true });
    expect(d.bufferedLength).toBe(0);
  });

  it("bare Shift does not break a burst", () => {
    const keys = [...digits("5000112"), "Shift", ...digits("637922"), "Enter"];
    expect(scans(feed(new HardwareScanDetector(), keys, 8))).toHaveLength(1);
  });

  it("isComposing events (IME) are never scanner input", () => {
    const d = new HardwareScanDetector();
    const out = feed(d, [...digits(EAN13), "Enter"], 8, 1000, { isComposing: true });
    expect(scans(out)).toHaveLength(0);
    expect(d.bufferedLength).toBe(0);
  });

  it("keyCode 229 (IME Process) is ignored", () => {
    expect(new HardwareScanDetector().push({ key: "1", timeStamp: 1, keyCode: 229 })).toEqual({ kind: "ignored" });
  });

  it("auto-repeat (held key) is never a scan, even 00000000 which is a valid EAN-8", () => {
    expect(hasValidGs1CheckDigit("00000000")).toBe(true);
    const out = feed(new HardwareScanDetector(), [..."00000000", "Enter"], 30, 1000, { repeat: true });
    expect(scans(out)).toHaveLength(0);
  });

  it("Backspace / arrows / Escape / F-keys end the burst", () => {
    for (const key of ["Backspace", "ArrowLeft", "Escape", "F5"]) {
      const d = new HardwareScanDetector();
      feed(d, digits("50001126"), 8);
      d.push({ key, timeStamp: 1100 });
      expect(d.bufferedLength).toBe(0);
    }
  });
});

describe("HardwareScanDetector — terminator-only input", () => {
  it("Enter / Tab with an empty buffer are ignored (normal navigation untouched)", () => {
    const d = new HardwareScanDetector();
    expect(d.push({ key: "Enter", timeStamp: 1 })).toEqual({ kind: "ignored" });
    expect(d.push({ key: "Tab", timeStamp: 2 })).toEqual({ kind: "ignored" });
  });

  it("Tab after a short buffer is ignored so focus moves normally", () => {
    expect(last(feed(new HardwareScanDetector(), [...digits("123"), "Tab"], 8))).toEqual({ kind: "ignored" });
  });
});
