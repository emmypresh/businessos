"use client";

import { useEffect, useRef } from "react";
import { HARDWARE_SCAN_TUNING, HardwareScanDetector } from "./hardware-detector";

// Phase 1Q-E — DOM side of keyboard-wedge scanner support.
//
// Keylogger-risk design (see build brief §Keylogger-risk):
//  * Mounted only by the product lookup surface, and only while `enabled`.
//    No permanent / app-wide listener exists.
//  * Events are considered only when their target is inside the product form
//    (`getScope`) or is <body>. Anything else (sidebar search, dialogs,
//    login, …) resets the buffer immediately.
//  * Password / one-time-code / payment / contenteditable / select / combobox
//    targets are blocked outright; nothing is buffered from them.
//  * The buffer (≤ 14 digits) lives in a detector instance in memory only,
//    is cleared by every non-matching key, every terminator, focus/window blur,
//    unmount, and an IDLE_CLEAR_MS inactivity timer, and is never persisted,
//    logged or transmitted. Only an accepted identifier leaves.
//
// Field protection: scanner digits arrive at whichever field has focus before
// we can know it is a scanner. We never block keys speculatively (that would
// eat human typing). Instead the value of a text field is snapshotted when a
// candidate burst starts, and restored the instant the burst is confirmed as
// a scan — so "Coca-Cola 50cl" never becomes "Coca-Cola 50cl5449000…".

type Snapshot = {
  el: HTMLInputElement | HTMLTextAreaElement;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

export type TargetKind = "text" | "passive" | "blocked";

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "number", "tel", "email", "url"]);
const PASSIVE_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "image"]);
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/i;
const BLOCKED_ROLES = new Set(["combobox", "listbox", "textbox", "searchbox", "spinbutton", "slider"]);

/**
 * Decide whether (and how) a key event target may take part in scanner
 * detection. Exported for unit tests.
 */
export function classifyTarget(target: EventTarget | null, scope: Element | null): TargetKind {
  if (!(target instanceof Element)) return "blocked";
  const doc = target.ownerDocument;
  const isPage = target === doc.body || target === doc.documentElement;
  if (!isPage && scope && !scope.contains(target)) return "blocked";
  if (isPage) return "passive";

  if (target.closest("[data-no-hardware-scan]")) return "blocked";
  if ((target as HTMLElement).isContentEditable) return "blocked";
  const role = target.getAttribute("role");
  if (role && BLOCKED_ROLES.has(role)) return "blocked";
  const autocomplete = target.getAttribute("autocomplete");
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return "blocked";

  if (target instanceof HTMLSelectElement) return "blocked"; // digits would type-ahead the selection
  if (target instanceof HTMLTextAreaElement) return target.readOnly ? "passive" : "text";
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    if (type === "password" || type === "hidden" || type === "file") return "blocked";
    if (TEXT_INPUT_TYPES.has(type)) return target.readOnly ? "passive" : "text";
    if (PASSIVE_INPUT_TYPES.has(type)) return "passive";
    return "blocked"; // date/time/color/range/… react to digits unpredictably
  }
  if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) return "passive";
  return "blocked";
}

function takeSnapshot(el: HTMLInputElement | HTMLTextAreaElement): Snapshot {
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  try {
    selectionStart = el.selectionStart;
    selectionEnd = el.selectionEnd;
  } catch {
    // type=number etc. throw / return null — value restore alone is enough.
  }
  return { el, value: el.value, selectionStart, selectionEnd };
}

function restoreSnapshot(s: Snapshot): void {
  const { el } = s;
  if (el.value === s.value) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // Native setter + input event so React-controlled fields see the revert.
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, s.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  try {
    if (s.selectionStart !== null && s.selectionEnd !== null) el.setSelectionRange(s.selectionStart, s.selectionEnd);
  } catch {
    // selection unsupported for this input type
  }
}

export type HardwareScanOptions = {
  /** Detector is attached only while true (e.g. false while the camera dialog is open). */
  enabled: boolean;
  /** The product form (or lookup root). Keys from outside it are ignored. */
  getScope: () => Element | null;
  /** A validated EAN-8 / UPC-A / EAN-13 arrived. */
  onScan: (identifier: string) => void;
  /** A scanner-shaped burst that is not a valid supported identifier. */
  onRejected: (raw: string) => void;
  /** Test seam for the clock (defaults to KeyboardEvent.timeStamp). No server authority. */
  timeSource?: (e: KeyboardEvent) => number;
};

export function useHardwareBarcodeScanner(options: HardwareScanOptions): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const { enabled } = options;
  useEffect(() => {
    if (!enabled) return;
    const detector = new HardwareScanDetector();
    let snapshot: Snapshot | null = null;
    let burstTarget: EventTarget | null = null;

    // Single idle timer (privacy): a partial buffer is dropped if no scanner-like
    // key arrives within IDLE_CLEAR_MS. At most one timer exists; it is always
    // cancelled before being re-armed, on every clear, and on cleanup, and the
    // callback re-checks its own identity so a stale callback can never wipe a
    // newer burst. The callback touches no React state.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const cancelIdle = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const clear = () => {
      cancelIdle();
      detector.reset();
      snapshot = null;
      burstTarget = null;
    };

    const armIdle = () => {
      cancelIdle();
      const timer = setTimeout(() => {
        if (disposed || idleTimer !== timer) return;
        idleTimer = null;
        clear();
      }, HARDWARE_SCAN_TUNING.IDLE_CLEAR_MS);
      idleTimer = timer;
    };

    function onKeyDown(e: KeyboardEvent) {
      const opts = latest.current;
      const kind = classifyTarget(e.target, opts.getScope());
      if (kind === "blocked") {
        clear();
        return;
      }
      // Focus moved mid-burst (e.g. a human Tab): not one scan.
      if (burstTarget && burstTarget !== e.target) clear();

      const outcome = detector.push({
        key: e.key,
        timeStamp: opts.timeSource ? opts.timeSource(e) : e.timeStamp,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        isComposing: e.isComposing,
        repeat: e.repeat,
        keyCode: e.keyCode,
      });

      switch (outcome.kind) {
        case "buffering":
          if (outcome.started) {
            burstTarget = e.target;
            snapshot = kind === "text" ? takeSnapshot(e.target as HTMLInputElement | HTMLTextAreaElement) : null;
          }
          armIdle();
          return;
        case "ignored":
          // A reset burst must not leave a stale snapshot or timer behind.
          // (A bare Shift inside a live burst leaves the buffer — and timer — alone.)
          if (detector.bufferedLength === 0) clear();
          return;
        case "scan":
        case "rejected": {
          if (snapshot && snapshot.el === e.target) restoreSnapshot(snapshot);
          clear();
          // Consume the terminator: no form submit, no button click, no focus
          // move, and the field's own Enter handler must not run a second lookup.
          e.preventDefault();
          e.stopPropagation();
          if (outcome.kind === "scan") opts.onScan(outcome.value);
          else opts.onRejected(outcome.raw);
          return;
        }
      }
    }

    // Focus leaving a field (or the window) ends any partial burst immediately.
    const onFocusLeave = () => clear();

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusout", onFocusLeave, true);
    document.addEventListener("blur", onFocusLeave, true); // capture: blur does not bubble
    window.addEventListener("blur", onFocusLeave);
    return () => {
      disposed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusout", onFocusLeave, true);
      document.removeEventListener("blur", onFocusLeave, true);
      window.removeEventListener("blur", onFocusLeave);
      clear();
    };
  }, [enabled]);
}
