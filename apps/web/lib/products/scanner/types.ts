// Phase 1Q-D — shared scanner vocabulary. Framework-agnostic and free of
// browser globals so both the hook and its tests can import it.

// Explicit lifecycle (phase instruction §16). Lookup-side states
// (LOOKING_UP / SUCCESS / NOT_FOUND) deliberately live in the existing 1Q-C
// lookup field: the scanner only produces an identifier string, so it has no
// lookup state of its own to get out of sync with the real pipeline.
export const SCANNER_STATE = {
  IDLE: "IDLE",
  REQUESTING_PERMISSION: "REQUESTING_PERMISSION",
  SCANNING: "SCANNING",
  DETECTED: "DETECTED",
  // Camera released because the tab was hidden; user resumes explicitly.
  PAUSED: "PAUSED",
  ERROR: "ERROR",
} as const;

export type ScannerState = (typeof SCANNER_STATE)[keyof typeof SCANNER_STATE];

// Normalized error taxonomy (phase instruction §51). Raw DOMException names
// and messages never reach the UI.
export const SCANNER_ERROR = {
  CAMERA_PERMISSION_DENIED: "CAMERA_PERMISSION_DENIED",
  CAMERA_NOT_FOUND: "CAMERA_NOT_FOUND",
  CAMERA_NOT_SUPPORTED: "CAMERA_NOT_SUPPORTED",
  CAMERA_INSECURE_CONTEXT: "CAMERA_INSECURE_CONTEXT",
  CAMERA_IN_USE: "CAMERA_IN_USE",
  CAMERA_START_FAILED: "CAMERA_START_FAILED",
} as const;

export type ScannerErrorCode = (typeof SCANNER_ERROR)[keyof typeof SCANNER_ERROR];

// Non-fatal, transient hints while the camera keeps running.
export const SCANNER_NOTICE = {
  INVALID_IDENTIFIER: "INVALID_IDENTIFIER",
  BARCODE_NOT_DETECTED: "BARCODE_NOT_DETECTED",
} as const;

export type ScannerNotice = (typeof SCANNER_NOTICE)[keyof typeof SCANNER_NOTICE];

export class ScannerError extends Error {
  readonly code: ScannerErrorCode;
  constructor(code: ScannerErrorCode) {
    super(code);
    this.name = "ScannerError";
    this.code = code;
  }
}

// Plain-language copy (phase instruction §7–§10, §51).
export function describeScannerError(code: ScannerErrorCode): string {
  switch (code) {
    case "CAMERA_PERMISSION_DENIED":
      return "Camera access was blocked. You can allow camera access in your browser settings or enter the barcode manually.";
    case "CAMERA_NOT_FOUND":
      return "No camera was found on this device. Enter the barcode manually.";
    case "CAMERA_NOT_SUPPORTED":
      return "Camera scanning is not supported on this browser. Enter the barcode manually.";
    case "CAMERA_INSECURE_CONTEXT":
      return "Camera scanning needs a secure (HTTPS) connection. Enter the barcode manually.";
    case "CAMERA_IN_USE":
      return "The camera is already in use. Close the other scanner or app using it, then try again.";
    case "CAMERA_START_FAILED":
    default:
      return "The camera could not be started. Try again or enter the barcode manually.";
  }
}

export function describeScannerNotice(notice: ScannerNotice): string {
  return notice === "INVALID_IDENTIFIER"
    ? "That doesn't look like a valid product barcode. Hold steady and try again."
    : "No barcode detected yet. Move closer and make sure the barcode is well lit.";
}
