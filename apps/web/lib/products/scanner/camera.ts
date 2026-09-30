import { SCANNER_ERROR, ScannerError, type ScannerErrorCode } from "./types";

// Phase 1Q-D — thin, injectable wrapper over getUserMedia (phase
// instruction §2, §43). Takes the MediaDevices object as a parameter so unit
// tests never touch a real camera.

export function getCameraSupportError(env: {
  isSecureContext?: boolean;
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | undefined;
}): ScannerErrorCode | null {
  // Checked first: on an insecure origin `mediaDevices` is undefined too, and
  // "use HTTPS" is the actionable message (phase instruction §10). There is no
  // insecure-context workaround by design.
  if (env.isSecureContext === false) return SCANNER_ERROR.CAMERA_INSECURE_CONTEXT;
  if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function") {
    return SCANNER_ERROR.CAMERA_NOT_SUPPORTED;
  }
  return null;
}

export function classifyCameraError(err: unknown): ScannerErrorCode {
  const name = typeof err === "object" && err !== null ? (err as { name?: string }).name : undefined;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return SCANNER_ERROR.CAMERA_PERMISSION_DENIED;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return SCANNER_ERROR.CAMERA_NOT_FOUND;
    case "NotReadableError":
    case "TrackStartError":
      return SCANNER_ERROR.CAMERA_IN_USE;
    case "TypeError":
      return SCANNER_ERROR.CAMERA_NOT_SUPPORTED;
    default:
      return SCANNER_ERROR.CAMERA_START_FAILED;
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

// Rear camera preferred but never required (phase instruction §2): `ideal`
// lets devices without one (laptops, front-only tablets) fall back to
// whatever exists; an OverconstrainedError retries unconstrained.
export async function startCamera(
  mediaDevices: Pick<MediaDevices, "getUserMedia">,
  options: { deviceId?: string } = {}
): Promise<MediaStream> {
  const video: MediaTrackConstraints = options.deviceId
    ? { deviceId: { exact: options.deviceId } }
    : { facingMode: { ideal: "environment" } };
  try {
    return await mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "OverconstrainedError") {
      try {
        return await mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (retryErr) {
        throw new ScannerError(classifyCameraError(retryErr));
      }
    }
    throw new ScannerError(classifyCameraError(err));
  }
}
