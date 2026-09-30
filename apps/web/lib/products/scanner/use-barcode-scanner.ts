"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { acceptDecodedBarcode } from "./barcode";
import { getCameraSupportError, startCamera, stopStream } from "./camera";
import { createNativeBarcodeDecoder, type BarcodeDecoder, type DecodedBarcode } from "./decoder";
import {
  SCANNER_ERROR,
  SCANNER_NOTICE,
  SCANNER_STATE,
  ScannerError,
  type ScannerErrorCode,
  type ScannerNotice,
  type ScannerState,
} from "./types";

// Phase 1Q-D — the camera lifecycle, kept out of any form component (phase
// instruction §41). Everything browser-specific is injected through
// `ScannerDeps`, so unit tests drive it with fake streams/decoders and never
// need camera hardware (§43). Camera frames stay inside the <video> element
// and the decoder: nothing here serializes, stores, logs or uploads them
// (§27/§28) — the only value that leaves this hook is a decoded digit string.

export type ScannerDeps = {
  getSupportError: () => ScannerErrorCode | null;
  createDecoder: () => Promise<BarcodeDecoder | null>;
  startCamera: (options: { deviceId?: string }) => Promise<MediaStream>;
  listVideoInputIds: () => Promise<string[]>;
  isHidden: () => boolean;
  decodeIntervalMs: number;
  noDetectionNoticeMs: number;
};

// ~8 decode attempts per second (phase instruction §32) instead of raw camera FPS.
export const DECODE_INTERVAL_MS = 125;
const NO_DETECTION_NOTICE_MS = 12_000;
// A value must be seen on two consecutive detections (§14); this many empty
// ticks in between (~375 ms) means the code left the frame, so start over.
const EMPTY_TICKS_BEFORE_RESET = 3;

export function createBrowserScannerDeps(): ScannerDeps {
  return {
    getSupportError: () =>
      getCameraSupportError({
        isSecureContext: window.isSecureContext,
        mediaDevices: navigator.mediaDevices,
      }),
    createDecoder: () => createNativeBarcodeDecoder(window),
    startCamera: (options) => startCamera(navigator.mediaDevices, options),
    listVideoInputIds: async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "videoinput").map((d) => d.deviceId);
    },
    isHidden: () => document.visibilityState === "hidden",
    decodeIntervalMs: DECODE_INTERVAL_MS,
    noDetectionNoticeMs: NO_DETECTION_NOTICE_MS,
  };
}

// One scanner may own the camera at a time (phase instruction §35).
let cameraOwner: object | null = null;

export type BarcodeScanner = {
  videoRef: RefObject<HTMLVideoElement | null>;
  state: ScannerState;
  errorCode: ScannerErrorCode | null;
  notice: ScannerNotice | null;
  canSwitchCamera: boolean;
  /** (Re)start the camera. Also the Retry / Resume action. */
  start: () => void;
  switchCamera: () => void;
  stop: () => void;
};

export function useBarcodeScanner({
  onDetected,
  deps,
}: {
  onDetected: (identifier: string) => void;
  deps?: ScannerDeps;
}): BarcodeScanner {
  const [state, setState] = useState<ScannerState>(SCANNER_STATE.IDLE);
  const [errorCode, setErrorCode] = useState<ScannerErrorCode | null>(null);
  const [notice, setNotice] = useState<ScannerNotice | null>(null);
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every start/stop/pause/unmount. Any async continuation that
  // captured an older generation discards itself (and stops any stream it was
  // handed) — this is what stops a slow getUserMedia resolving AFTER the
  // dialog closed from leaving the camera on (§11/§15).
  const generationRef = useRef(0);
  const lockedRef = useRef(false);
  const ownerRef = useRef<object>({});
  const deviceIdsRef = useRef<string[]>([]);
  const currentDeviceRef = useRef<string | undefined>(undefined);
  const depsRef = useRef<ScannerDeps | null>(deps ?? null);
  const onDetectedRef = useRef(onDetected);

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  const release = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (cameraOwner === ownerRef.current) cameraOwner = null;
  }, []);

  const fail = useCallback((code: ScannerErrorCode) => {
    setErrorCode(code);
    setState(SCANNER_STATE.ERROR);
  }, []);

  const pause = useCallback(() => {
    generationRef.current++;
    release();
    setState(SCANNER_STATE.PAUSED);
  }, [release]);

  const start = useCallback(
    (deviceId?: string) => {
      const d = (depsRef.current ??= createBrowserScannerDeps());
      const generation = ++generationRef.current;
      const isCurrent = () => generation === generationRef.current;

      release();
      lockedRef.current = false;
      setNotice(null);
      setErrorCode(null);

      void (async () => {
        const supportError = d.getSupportError();
        if (supportError) return fail(supportError);
        if (cameraOwner && cameraOwner !== ownerRef.current) return fail(SCANNER_ERROR.CAMERA_IN_USE);
        cameraOwner = ownerRef.current;
        setState(SCANNER_STATE.REQUESTING_PERMISSION);

        // Decoder first: never trigger a permission prompt for a camera we
        // could not decode from anyway (§9).
        const decoder = await d.createDecoder().catch(() => null);
        if (!isCurrent()) return;
        if (!decoder) {
          release();
          return fail(SCANNER_ERROR.CAMERA_NOT_SUPPORTED);
        }

        let stream: MediaStream;
        try {
          stream = await d.startCamera({ deviceId });
        } catch (err) {
          if (!isCurrent()) return;
          release();
          return fail(err instanceof ScannerError ? err.code : SCANNER_ERROR.CAMERA_START_FAILED);
        }
        if (!isCurrent()) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        currentDeviceRef.current = stream.getVideoTracks()[0]?.getSettings?.().deviceId;

        const video = videoRef.current;
        if (!video) {
          release();
          return fail(SCANNER_ERROR.CAMERA_START_FAILED);
        }
        video.srcObject = stream;
        try {
          await video.play();
        } catch (err) {
          // AbortError = the element was torn down/reloaded mid-play; not a failure.
          if ((err as { name?: string } | null)?.name !== "AbortError" && isCurrent()) {
            release();
            return fail(SCANNER_ERROR.CAMERA_START_FAILED);
          }
        }
        if (!isCurrent()) return;

        // Device ids are only exposed after permission; labels are never read (§23).
        try {
          deviceIdsRef.current = await d.listVideoInputIds();
        } catch {
          deviceIdsRef.current = [];
        }
        if (!isCurrent()) return;
        setCanSwitchCamera(deviceIdsRef.current.length > 1);
        setState(SCANNER_STATE.SCANNING);

        const startedAt = Date.now();
        let candidate: string | null = null;
        let emptyTicks = 0;

        const handle = (codes: DecodedBarcode[]) => {
          let accepted: string | null = null;
          let sawInvalid = false;
          for (const code of codes) {
            const result = acceptDecodedBarcode(code.rawValue, code.format);
            if (result.ok) {
              accepted = result.value;
              break;
            }
            if (result.reason === "INVALID_IDENTIFIER") sawInvalid = true;
          }

          if (!accepted) {
            if (sawInvalid) {
              candidate = null;
              setNotice(SCANNER_NOTICE.INVALID_IDENTIFIER);
            } else if (++emptyTicks >= EMPTY_TICKS_BEFORE_RESET) {
              candidate = null;
            }
            return;
          }

          emptyTicks = 0;
          if (candidate !== accepted) {
            candidate = accepted; // first sighting — wait for a confirming frame
            return;
          }

          // Confirmed. Lock first so a repeat detection in the same frame
          // burst can never fire a second lookup (§13), then free the camera
          // before handing the identifier on (§11/§33).
          lockedRef.current = true;
          setState(SCANNER_STATE.DETECTED);
          setNotice(null);
          release();
          onDetectedRef.current(accepted);
        };

        const tick = async () => {
          if (!isCurrent() || lockedRef.current) return;
          if (d.isHidden()) return pause();
          try {
            const codes = await decoder.detect(video);
            if (!isCurrent() || lockedRef.current) return;
            handle(codes);
          } catch {
            // A failed frame decode is transient; the next tick retries.
          }
          if (!isCurrent() || lockedRef.current) return;
          if (Date.now() - startedAt > d.noDetectionNoticeMs) {
            setNotice((prev) => prev ?? SCANNER_NOTICE.BARCODE_NOT_DETECTED);
          }
          timerRef.current = setTimeout(() => void tick(), d.decodeIntervalMs);
        };
        void tick();
      })();
    },
    [release, fail, pause]
  );

  const stop = useCallback(() => {
    generationRef.current++;
    lockedRef.current = false;
    release();
    setState(SCANNER_STATE.IDLE);
  }, [release]);

  const switchCamera = useCallback(() => {
    const ids = deviceIdsRef.current;
    if (ids.length < 2) return;
    const index = ids.indexOf(currentDeviceRef.current ?? "");
    // `start` stops the old stream's tracks before opening the next (§23).
    start(ids[(index + 1) % ids.length]);
  }, [start]);

  // Hidden tab => release the camera instead of scanning invisibly (§34).
  useEffect(() => {
    const onVisibility = () => {
      const d = depsRef.current ?? createBrowserScannerDeps();
      if (d.isHidden() && streamRef.current) pause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [pause]);

  // Unmount / navigation away always frees the camera (§11).
  useEffect(() => {
    const generationAtMount = generationRef;
    return () => {
      generationAtMount.current++;
      release();
    };
  }, [release]);

  const restart = useCallback(() => start(), [start]);

  return {
    videoRef,
    state,
    errorCode,
    notice,
    canSwitchCamera,
    start: restart,
    switchCamera,
    stop,
  };
}
