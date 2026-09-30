// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBarcodeScanner, type BarcodeScanner, type ScannerDeps } from "./use-barcode-scanner";
import type { DecodedBarcode } from "./decoder";
import { ScannerError } from "./types";

const VALID = "5000112637922";
const OTHER_VALID = "4006381333931";
const INVALID = "5000112637921";

function fakeStream() {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "cam-1" }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

function makeDeps(overrides: Partial<ScannerDeps> = {}) {
  const { stream, track } = fakeStream();
  const detect = vi.fn<() => Promise<DecodedBarcode[]>>().mockResolvedValue([]);
  const deps: ScannerDeps = {
    getSupportError: () => null,
    createDecoder: async () => ({ detect }),
    startCamera: vi.fn().mockResolvedValue(stream),
    listVideoInputIds: async () => ["cam-1"],
    isHidden: () => false,
    decodeIntervalMs: 5,
    noDetectionNoticeMs: 60_000,
    ...overrides,
  };
  return { deps, detect, track, stream };
}

let latest: BarcodeScanner;
function Probe({ deps, onDetected }: { deps: ScannerDeps; onDetected: (v: string) => void }) {
  const scanner = useBarcodeScanner({ deps, onDetected });
  const { videoRef, start } = scanner;
  useEffect(() => {
    latest = scanner;
  });
  // Mirrors BarcodeScannerDialog: start once when the surface mounts.
  useEffect(() => {
    start();
  }, [start]);
  return <video ref={videoRef} data-testid="video" />;
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tick = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("useBarcodeScanner", () => {
  it("opens the stream, then reaches SCANNING", async () => {
    const { deps } = makeDeps();
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.state).toBe("SCANNING"));
    expect(deps.startCamera).toHaveBeenCalledTimes(1);
  });

  it("stops every track on unmount", async () => {
    const { deps, track } = makeDeps();
    const view = render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.state).toBe("SCANNING"));
    view.unmount();
    expect(track.stop).toHaveBeenCalled();
  });

  it("stops every track on explicit stop (close)", async () => {
    const { deps, track } = makeDeps();
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.state).toBe("SCANNING"));
    act(() => latest.stop());
    expect(track.stop).toHaveBeenCalled();
    expect(latest.state).toBe("IDLE");
  });

  it("stops tracks after a successful scan and reports exactly one identifier", async () => {
    const { deps, detect, track } = makeDeps();
    detect.mockResolvedValue([{ rawValue: VALID, format: "ean_13" }]);
    const onDetected = vi.fn();
    render(<Probe deps={deps} onDetected={onDetected} />);
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(VALID));
    await tick(80);
    expect(track.stop).toHaveBeenCalled();
    expect(latest.state).toBe("DETECTED");
    // Repeated identical detections never produce a second lookup.
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("needs two consecutive matching detections (single noisy frame ignored)", async () => {
    const { deps, detect } = makeDeps();
    detect
      .mockResolvedValueOnce([{ rawValue: VALID, format: "ean_13" }])
      .mockResolvedValueOnce([{ rawValue: OTHER_VALID, format: "ean_13" }])
      .mockResolvedValue([]);
    const onDetected = vi.fn();
    render(<Probe deps={deps} onDetected={onDetected} />);
    await tick(100);
    expect(onDetected).not.toHaveBeenCalled();
    expect(latest.state).toBe("SCANNING");
  });

  it("ignores an invalid check digit, shows a notice, and never calls onDetected", async () => {
    const { deps, detect } = makeDeps();
    detect.mockResolvedValue([{ rawValue: INVALID, format: "ean_13" }]);
    const onDetected = vi.fn();
    render(<Probe deps={deps} onDetected={onDetected} />);
    await waitFor(() => expect(latest.notice).toBe("INVALID_IDENTIFIER"));
    expect(onDetected).not.toHaveBeenCalled();
    expect(latest.state).toBe("SCANNING");
  });

  it("ignores unsupported formats such as QR codes", async () => {
    const { deps, detect } = makeDeps();
    detect.mockResolvedValue([{ rawValue: "https://example.com", format: "qr_code" }]);
    const onDetected = vi.fn();
    render(<Probe deps={deps} onDetected={onDetected} />);
    await tick(100);
    expect(onDetected).not.toHaveBeenCalled();
  });

  it("reports CAMERA_PERMISSION_DENIED without retrying on its own", async () => {
    const { deps } = makeDeps({
      startCamera: vi.fn().mockRejectedValue(new ScannerError("CAMERA_PERMISSION_DENIED")),
    });
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.state).toBe("ERROR"));
    expect(latest.errorCode).toBe("CAMERA_PERMISSION_DENIED");
    await tick(60);
    expect(deps.startCamera).toHaveBeenCalledTimes(1);
  });

  it("maps an unexpected getUserMedia rejection to CAMERA_START_FAILED", async () => {
    const { deps } = makeDeps({ startCamera: vi.fn().mockRejectedValue(new Error("boom")) });
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.errorCode).toBe("CAMERA_START_FAILED"));
  });

  it("reports unsupported API / insecure context without asking for the camera", async () => {
    const { deps } = makeDeps({ getSupportError: () => "CAMERA_INSECURE_CONTEXT" });
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.errorCode).toBe("CAMERA_INSECURE_CONTEXT"));
    expect(deps.startCamera).not.toHaveBeenCalled();
  });

  it("reports unsupported browser (no decoder) before prompting for the camera", async () => {
    const { deps } = makeDeps({ createDecoder: async () => null });
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.errorCode).toBe("CAMERA_NOT_SUPPORTED"));
    expect(deps.startCamera).not.toHaveBeenCalled();
  });

  it("stops a stream that resolves after the scanner was already closed", async () => {
    const { stream, track } = fakeStream();
    let resolveStream!: (s: MediaStream) => void;
    const { deps } = makeDeps({
      startCamera: vi.fn().mockReturnValue(new Promise<MediaStream>((r) => (resolveStream = r))),
    });
    const view = render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(deps.startCamera).toHaveBeenCalled());
    view.unmount(); // user closed while the permission prompt was pending
    await act(async () => resolveStream(stream));
    expect(track.stop).toHaveBeenCalled();
  });

  it("pauses and releases the camera when the tab becomes hidden", async () => {
    let hidden = false;
    const { deps, track } = makeDeps({ isHidden: () => hidden });
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.state).toBe("SCANNING"));
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(track.stop).toHaveBeenCalled();
    expect(latest.state).toBe("PAUSED");
  });

  it("switching cameras stops the old track before opening the next", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const order: string[] = [];
    first.track.stop.mockImplementation(() => order.push("stop-old"));
    const startCameraMock = vi
      .fn()
      .mockImplementationOnce(async () => (order.push("open-1"), first.stream))
      .mockImplementationOnce(async () => (order.push("open-2"), second.stream));
    const { deps } = makeDeps({ startCamera: startCameraMock, listVideoInputIds: async () => ["cam-1", "cam-2"] });
    render(<Probe deps={deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.canSwitchCamera).toBe(true));
    act(() => latest.switchCamera());
    await waitFor(() => expect(startCameraMock).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["open-1", "stop-old", "open-2"]);
    expect(startCameraMock).toHaveBeenLastCalledWith({ deviceId: "cam-2" });
  });

  it("allows only one scanner to own the camera at a time", async () => {
    const a = makeDeps();
    const b = makeDeps();
    render(
      <>
        <Probe deps={a.deps} onDetected={vi.fn()} />
      </>
    );
    await waitFor(() => expect(latest.state).toBe("SCANNING"));
    const first = latest;
    render(<Probe deps={b.deps} onDetected={vi.fn()} />);
    await waitFor(() => expect(latest.errorCode).toBe("CAMERA_IN_USE"));
    expect(b.deps.startCamera).not.toHaveBeenCalled();
    expect(first.state).toBe("SCANNING");
  });

  it("resets cleanly for a new scan after completion (retry/reopen)", async () => {
    const { deps, detect } = makeDeps();
    detect.mockResolvedValue([{ rawValue: VALID, format: "ean_13" }]);
    const onDetected = vi.fn();
    render(<Probe deps={deps} onDetected={onDetected} />);
    await waitFor(() => expect(onDetected).toHaveBeenCalledTimes(1));
    detect.mockResolvedValue([{ rawValue: OTHER_VALID, format: "ean_13" }]);
    act(() => latest.start());
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(OTHER_VALID));
    expect(onDetected).toHaveBeenCalledTimes(2);
  });
});
