// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARDWARE_SCAN_TUNING } from "./hardware-detector";
import { useHardwareBarcodeScanner } from "./use-hardware-barcode-scanner";

// Phase 1Q-E final remediation — idle clearing of a PARTIAL raw-key buffer.
//
// Two independent clocks, both fake:
//  * `clock`  — the key-event timestamp the detector sees (via timeSource). It is
//    deliberately NOT tied to timers, so a stale partial buffer would happily merge
//    with later "fast" digits if the idle timer failed to clear it.
//  * vi fake timers — drive the hook's idle setTimeout. No real sleeps anywhere.
// "Buffer empty" is therefore observed behaviourally (a stale prefix would turn a
// later burst into a different / valid scan) plus vi.getTimerCount() for leaks.

const EAN13 = "5000112637922";
const EAN13_B = "4006381333931";
const IDLE = HARDWARE_SCAN_TUNING.IDLE_CLEAR_MS;

let clock = 1000;
const timeSource = () => clock;
const onScan = vi.fn();
const onRejected = vi.fn();

function Harness({ enabled = true }: { enabled?: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  useHardwareBarcodeScanner({
    enabled,
    getScope: () => formRef.current,
    onScan,
    onRejected,
    timeSource,
  });
  return (
    <div>
      <input aria-label="Outside" />
      <form ref={formRef}>
        <input aria-label="Name" defaultValue="Coca-Cola" />
        <input aria-label="Password" type="password" />
        <button type="button">btn</button>
      </form>
    </div>
  );
}

function setup(enabled = true) {
  const utils = render(<Harness enabled={enabled} />);
  const name = utils.getByLabelText("Name") as HTMLInputElement;
  act(() => name.focus());
  return { ...utils, name };
}

/** Send keys with a gap in BOTH the event clock and the fake timer clock. */
function type(el: HTMLElement, keys: string, gapMs = 8, init: KeyboardEventInit = {}) {
  let allowed = true;
  for (const key of keys) {
    clock += gapMs;
    act(() => {
      vi.advanceTimersByTime(gapMs);
    });
    allowed = fireEvent.keyDown(el, { key, ...init });
  }
  return allowed;
}

const enter = (el: HTMLElement, gapMs = 8) => {
  clock += gapMs;
  act(() => {
    vi.advanceTimersByTime(gapMs);
  });
  return fireEvent.keyDown(el, { key: "Enter" });
};

/** Let the idle timer elapse WITHOUT moving the event clock. */
const idleFor = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1000;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("tuning", () => {
  it("idle window is comfortably above the scanner gap and far below human pauses", () => {
    expect(IDLE).toBeGreaterThanOrEqual(HARDWARE_SCAN_TUNING.MAX_INTER_KEY_MS * 2);
    expect(IDLE).toBeGreaterThanOrEqual(100);
    expect(IDLE).toBeLessThanOrEqual(250);
  });
});

describe("partial buffer idle expiry", () => {
  it("control: without an idle gap, prefix + remainder merge into one valid scan", () => {
    const { name } = setup();
    type(name, EAN13.slice(0, 4));
    type(name, EAN13.slice(4));
    const allowed = enter(name);
    expect(allowed).toBe(false);
    expect(onScan).toHaveBeenCalledWith(EAN13);
  });

  // A
  it("partial digits expire after the idle window and never join a later burst", () => {
    const { name } = setup();
    type(name, EAN13.slice(0, 4));
    expect(vi.getTimerCount()).toBe(1);
    idleFor(IDLE + 1);
    expect(vi.getTimerCount()).toBe(0);

    // If the stale "5000" survived this would complete to EAN13 and scan.
    type(name, EAN13.slice(4));
    enter(name);
    expect(onScan).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith(EAN13.slice(4));
  });

  it("does not expire just before the window elapses", () => {
    const { name } = setup();
    type(name, EAN13.slice(0, 4));
    idleFor(IDLE - 1);
    type(name, EAN13.slice(4), 0);
    enter(name, 0);
    expect(onScan).toHaveBeenCalledWith(EAN13);
  });

  // B
  it("timer resets on every digit: a continuous scan never expires mid-burst", () => {
    const { name } = setup();
    // Total burst time (13 × 30 ms ≈ 390 ms) exceeds IDLE; each gap (30) is < mean cap (35).
    type(name, EAN13, 30);
    expect(vi.getTimerCount()).toBe(1);
    const allowed = enter(name, 30);
    expect(allowed).toBe(false);
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith(EAN13);
  });

  it("only one idle timer exists no matter how many digits arrive", () => {
    const { name } = setup();
    for (let i = 1; i <= 10; i++) {
      type(name, "1", 5);
      expect(vi.getTimerCount()).toBe(1);
    }
  });

  // C
  it("a new burst after expiry is detected correctly", () => {
    const { name } = setup();
    type(name, "5000");
    idleFor(IDLE + 50);
    type(name, EAN13_B);
    enter(name);
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith(EAN13_B);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("race: an expiry of burst A cannot clear burst B that started after it", () => {
    const { name } = setup();
    type(name, "5000");
    idleFor(IDLE + 1); // A expires
    type(name, EAN13_B.slice(0, 6)); // B starts, re-arms
    idleFor(IDLE - 50); // less than a full window since B's last digit
    type(name, EAN13_B.slice(6), 0);
    enter(name, 0);
    expect(onScan).toHaveBeenCalledWith(EAN13_B);
  });
});

describe("cleanup events", () => {
  // D
  it("blur (focus leaving the field) clears the partial buffer", () => {
    const { name } = setup();
    type(name, EAN13.slice(0, 4));
    act(() => name.blur());
    // (No timer-count assertion: React's own scheduler may queue a timer on a blur
    // under fake timers. Behavioural check below proves the prefix is gone.)

    act(() => name.focus());
    type(name, EAN13.slice(4));
    enter(name);
    expect(onScan).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(EAN13.slice(4));
  });

  it("window blur (app/tab switch) clears the partial buffer and the timer", () => {
    const { name } = setup();
    type(name, EAN13.slice(0, 4));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(vi.getTimerCount()).toBe(0);
    type(name, EAN13.slice(4));
    enter(name);
    expect(onScan).not.toHaveBeenCalled();
  });

  // E
  it("unmount clears the idle timer and leaves nothing to fire", () => {
    const { name, unmount } = setup();
    type(name, EAN13.slice(0, 4));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersByTime(IDLE * 5)).not.toThrow();
  });

  it("disabling the detector (camera dialog opens) clears the buffer and timer", () => {
    const { name, rerender } = setup();
    type(name, EAN13.slice(0, 4));
    rerender(<Harness enabled={false} />);
    expect(vi.getTimerCount()).toBe(0);

    rerender(<Harness enabled />);
    const again = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    act(() => again.focus());
    type(again, EAN13.slice(4));
    enter(again);
    expect(onScan).not.toHaveBeenCalled(); // stale "5000" did not survive re-enable
  });

  // F
  it("a completed scan leaves no buffered keys and no timer", () => {
    const { name } = setup();
    type(name, EAN13);
    enter(name);
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // A second Enter finds an empty buffer: untouched, no duplicate scan.
    expect(enter(name)).toBe(true);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it("a rejected scan leaves no buffered keys and no timer", () => {
    const { name } = setup();
    type(name, "5000112637921"); // bad check digit
    enter(name);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(enter(name)).toBe(true);
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  // G
  it.each([
    ["a letter", { key: "x" }],
    ["Backspace", { key: "Backspace" }],
    ["Escape", { key: "Escape" }],
    ["a Ctrl shortcut", { key: "v", ctrlKey: true }],
    ["a Meta shortcut", { key: "v", metaKey: true }],
    ["an Alt combination", { key: "a", altKey: true }],
    ["IME composition", { key: "1", isComposing: true }],
    ["auto-repeat", { key: "1", repeat: true }],
  ])("%s clears the partial buffer and the timer", (_label, ev) => {
    const { name } = setup();
    type(name, EAN13.slice(0, 4));
    clock += 8;
    fireEvent.keyDown(name, ev);
    expect(vi.getTimerCount()).toBe(0);

    type(name, EAN13.slice(4));
    enter(name);
    expect(onScan).not.toHaveBeenCalled();
  });

  it("a blocked target (password) mid-burst clears the partial buffer and timer", () => {
    const { name, getByLabelText } = setup();
    type(name, EAN13.slice(0, 4));
    const pw = getByLabelText("Password");
    act(() => pw.focus());
    type(pw, "1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keys outside the form clear the partial buffer and timer", () => {
    const { name, getByLabelText } = setup();
    type(name, EAN13.slice(0, 4));
    type(getByLabelText("Outside"), "1");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("regressions", () => {
  it("human-speed typing still never scans", () => {
    const { name } = setup();
    type(name, EAN13, 120);
    enter(name, 120);
    expect(onScan).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("Enter with an empty buffer is not consumed", () => {
    const { name } = setup();
    expect(enter(name)).toBe(true);
  });
});
