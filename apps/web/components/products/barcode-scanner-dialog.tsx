"use client";

import { useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, CameraRotate, Loader2 } from "@/components/ui/icon";
import { useBarcodeScanner, type ScannerDeps } from "@/lib/products/scanner/use-barcode-scanner";
import {
  SCANNER_ERROR,
  SCANNER_STATE,
  describeScannerError,
  describeScannerNotice,
  type ScannerErrorCode,
} from "@/lib/products/scanner/types";

// Phase 1Q-D — the scanner surface. A modal Dialog (existing accessible
// primitive: focus trap, Escape, focus return to the trigger — phase
// instruction §37). The camera only exists while this content is mounted,
// so closing the dialog unmounts <ScannerSurface> and the hook releases
// every MediaStream track (§11). Camera frames never leave the <video>
// element; only the decoded identifier is passed to `onDetected` (§27).

// Errors where a user-triggered retry can plausibly succeed (§52/§53). Never
// auto-retried, so a blocked permission is not re-prompted in a loop.
const RETRYABLE: ReadonlySet<ScannerErrorCode> = new Set([
  SCANNER_ERROR.CAMERA_PERMISSION_DENIED,
  SCANNER_ERROR.CAMERA_IN_USE,
  SCANNER_ERROR.CAMERA_START_FAILED,
]);

export function BarcodeScannerDialog({
  open,
  onOpenChange,
  onDetected,
  onManualEntry,
  deps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetected: (identifier: string) => void;
  onManualEntry: () => void;
  /** Test seam only — production callers never pass this. */
  deps?: ScannerDeps;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-1.5rem)] gap-3 overflow-y-auto sm:max-w-md"
      >
        <ScannerSurface
          onClose={() => onOpenChange(false)}
          onDetected={onDetected}
          onManualEntry={onManualEntry}
          deps={deps}
        />
      </DialogContent>
    </Dialog>
  );
}

function ScannerSurface({
  onClose,
  onDetected,
  onManualEntry,
  deps,
}: {
  onClose: () => void;
  onDetected: (identifier: string) => void;
  onManualEntry: () => void;
  deps?: ScannerDeps;
}) {
  const { videoRef, state, errorCode, notice, canSwitchCamera, start, switchCamera } = useBarcodeScanner({
    onDetected,
    deps,
  });

  useEffect(() => {
    start();
    // Mount-only: opening the dialog starts the camera once. Retry/Resume are
    // explicit user actions.
  }, [start]);

  const isScanning = state === SCANNER_STATE.SCANNING;
  const isStarting = state === SCANNER_STATE.REQUESTING_PERMISSION;
  const isError = state === SCANNER_STATE.ERROR;
  const isPaused = state === SCANNER_STATE.PAUSED;
  const canRetry = isPaused || (isError && errorCode !== null && RETRYABLE.has(errorCode));

  let statusText = "";
  if (isStarting) statusText = "Starting camera. If your browser asks, allow camera access.";
  else if (isScanning) statusText = notice ? describeScannerNotice(notice) : "Point the camera at the barcode.";
  else if (isPaused) statusText = "Scanner paused while this page was hidden. Resume to keep scanning.";
  else if (state === SCANNER_STATE.DETECTED) statusText = "Barcode detected.";
  else if (isError && errorCode) statusText = describeScannerError(errorCode);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Scan barcode</DialogTitle>
        <DialogDescription>
          Use your camera to read a product barcode. Camera images stay on this device; only the barcode number is used.
        </DialogDescription>
      </DialogHeader>

      <div
        data-testid="scanner-preview"
        className="relative aspect-[4/3] w-full shrink-0 overflow-hidden rounded-lg bg-black [@media(max-height:500px)]:aspect-auto [@media(max-height:500px)]:h-[38dvh]"
      >
        {/* Decorative: the status text below carries the meaning. */}
        <video
          ref={videoRef}
          muted
          playsInline
          aria-hidden="true"
          className={`absolute inset-0 size-full object-cover ${isScanning ? "" : "invisible"}`}
        />
        {isScanning ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-1/2 h-[45%] w-[80%] -translate-x-1/2 -translate-y-1/2 rounded-lg border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/80" aria-hidden="true">
            {isStarting ? <Loader2 size={28} /> : <Camera size={28} />}
          </div>
        )}
      </div>

      <p
        role={isError ? "alert" : "status"}
        aria-live={isError ? "assertive" : "polite"}
        className={`min-h-10 shrink-0 text-sm ${isError ? "text-destructive" : "text-muted-foreground"}`}
      >
        {statusText}
      </p>

      <div className="flex shrink-0 flex-col gap-2">
        {canRetry ? (
          <Button type="button" className="h-11" onClick={start}>
            {isPaused ? "Resume scanning" : "Try again"}
          </Button>
        ) : null}
        {isScanning && canSwitchCamera ? (
          <Button type="button" variant="outline" className="h-11" onClick={switchCamera}>
            <CameraRotate size={16} className="mr-1.5" />
            Switch camera
          </Button>
        ) : null}
        <Button type="button" variant="outline" className="h-11" onClick={onManualEntry}>
          Enter barcode manually
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={onClose}>
          Close scanner
        </Button>
      </div>
    </>
  );
}
