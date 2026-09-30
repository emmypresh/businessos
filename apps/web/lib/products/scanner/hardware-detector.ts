// Phase 1Q-E — keyboard-wedge (USB / Bluetooth HID) barcode scanner detector.
//
// Pure, framework-free and clock-free: the caller supplies every key event's
// timestamp, so tests are deterministic and there are no timers. Its ONLY job
// is   key events → a validated candidate identifier.   It knows nothing about
// the DOM, focus, lookup or the server (see use-hardware-barcode-scanner.ts
// for the DOM side, and the existing 1Q-C action for lookup).
//
// Privacy: the buffer holds at most MAX_LENGTH digits of the CURRENT burst,
// is cleared on every non-matching key, and is never stored, logged or sent.

import { acceptDecodedBarcode } from "./barcode";

// Tunable constants. Rationale (see the 1Q-E build brief §Timing):
//  * USB HID scanners emit a character every ~1–10 ms; Bluetooth HID scanners
//    are slower and jittery (~10–30 ms). The fastest human typists on a
//    numeric keypad sustain ≳ 70–80 ms between keys and cannot hold 8+ digits
//    under 50 ms apart. 50 ms sits between the two populations with margin
//    for browser scheduling on low-end devices.
//  * The average cap rejects a burst that only just scrapes under the per-key
//    limit on every key (a pattern neither fast scanners nor humans produce).
export const HARDWARE_SCAN_TUNING = {
  /** Maximum gap between two consecutive keystrokes of one scan burst. */
  MAX_INTER_KEY_MS: 50,
  /** Maximum mean gap across the whole burst (first→last digit). */
  MAX_AVG_INTER_KEY_MS: 35,
  /** Shortest burst that can be a supported identifier (EAN-8). */
  MIN_LENGTH: 8,
  /** Longest burst we buffer (GTIN-14); longer is noise and resets. */
  MAX_LENGTH: 14,
  /**
   * Inactivity after which the DOM hook discards a PARTIAL buffer (privacy: raw
   * keystrokes must not linger). The detector stays clock-free; the timer lives in
   * use-hardware-barcode-scanner.ts. 200 ms = 4× MAX_INTER_KEY_MS, so a live scan
   * (every gap ≤ 50 ms, timer re-armed per digit) can never expire mid-burst, yet
   * ≈ 2.5× shorter than the ~500 ms+ a person pauses between thoughts, so stale
   * digits never survive a normal human interval. Must exceed MAX_INTER_KEY_MS.
   */
  IDLE_CLEAR_MS: 200,
} as const;

export type ScanTerminator = "Enter" | "Tab";

export type DetectorKey = {
  key: string;
  /** Monotonic milliseconds (KeyboardEvent.timeStamp, or a fake in tests). */
  timeStamp: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  keyCode?: number;
};

export type DetectorOutcome =
  /** Key is not part of a scan (buffer was cleared or untouched). */
  | { kind: "ignored" }
  /** A digit was buffered. `started` = first digit of a new burst. */
  | { kind: "buffering"; started: boolean }
  /** Fast burst + terminator + valid supported identifier. */
  | { kind: "scan"; value: string; terminator: ScanTerminator }
  /** Fast burst + terminator, but not a valid supported identifier. */
  | { kind: "rejected"; raw: string; terminator: ScanTerminator };

const FORMAT_BY_LENGTH: Record<number, string> = { 8: "ean_8", 12: "upc_a", 13: "ean_13" };
const PURE_MODIFIER_KEYS = new Set(["Shift", "CapsLock", "NumLock", "ScrollLock", "AltGraph"]);

export class HardwareScanDetector {
  private digits: string[] = [];
  private firstAt = 0;
  private lastAt = 0;

  reset(): void {
    this.digits = [];
    this.firstAt = 0;
    this.lastAt = 0;
  }

  /** Number of buffered digits (for tests / diagnostics only). */
  get bufferedLength(): number {
    return this.digits.length;
  }

  push(e: DetectorKey): DetectorOutcome {
    // IME composition and the legacy 229 "Process" keyCode are never scans.
    if (e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Dead") {
      this.reset();
      return { kind: "ignored" };
    }
    // Shortcuts (Ctrl+V, Alt+…, Meta+…) are never scan input.
    if (e.ctrlKey || e.altKey || e.metaKey) {
      this.reset();
      return { kind: "ignored" };
    }
    // A held key auto-repeats at ~30 ms; "00000000" is even a valid EAN-8.
    if (e.repeat) {
      this.reset();
      return { kind: "ignored" };
    }
    // Bare Shift / CapsLock etc. don't break a burst.
    if (PURE_MODIFIER_KEYS.has(e.key)) return { kind: "ignored" };

    if (e.key.length === 1) {
      if (!/^[0-9]$/.test(e.key)) {
        // Letters / symbols: only numeric identifiers are supported.
        this.reset();
        return { kind: "ignored" };
      }
      return this.pushDigit(e.key, e.timeStamp);
    }

    if (e.key === "Enter" || e.key === "Tab") {
      return this.pushTerminator(e.key, e.timeStamp);
    }

    // Any other key (Backspace, arrows, Escape, F-keys…) ends the burst.
    this.reset();
    return { kind: "ignored" };
  }

  private pushDigit(digit: string, t: number): DetectorOutcome {
    const { MAX_INTER_KEY_MS, MAX_LENGTH } = HARDWARE_SCAN_TUNING;
    if (this.digits.length > 0 && (t < this.lastAt || t - this.lastAt > MAX_INTER_KEY_MS)) {
      // Too slow (or clock went backwards): whatever was buffered was human
      // typing. This digit begins a fresh candidate burst.
      this.reset();
    }
    const started = this.digits.length === 0;
    if (started) this.firstAt = t;
    this.digits.push(digit);
    this.lastAt = t;
    if (this.digits.length > MAX_LENGTH) {
      this.reset();
      return { kind: "ignored" };
    }
    return { kind: "buffering", started };
  }

  private pushTerminator(terminator: ScanTerminator, t: number): DetectorOutcome {
    const { MAX_INTER_KEY_MS, MAX_AVG_INTER_KEY_MS, MIN_LENGTH } = HARDWARE_SCAN_TUNING;
    const n = this.digits.length;
    if (n === 0) return { kind: "ignored" };

    const raw = this.digits.join("");
    const terminatorGap = t - this.lastAt;
    const avgGap = n > 1 ? (this.lastAt - this.firstAt) / (n - 1) : 0;
    this.reset(); // always clear before deciding — the buffer never outlives a terminator

    if (n < MIN_LENGTH || terminatorGap < 0 || terminatorGap > MAX_INTER_KEY_MS || avgGap > MAX_AVG_INTER_KEY_MS) {
      return { kind: "ignored" };
    }

    const format = FORMAT_BY_LENGTH[n];
    if (format) {
      const accepted = acceptDecodedBarcode(raw, format);
      if (accepted.ok) return { kind: "scan", value: accepted.value, terminator };
    }
    return { kind: "rejected", raw, terminator };
  }
}
