import { describe, expect, it, vi } from "vitest";
import { acceptDecodedBarcode, hasValidGs1CheckDigit } from "./barcode";
import { classifyCameraError, getCameraSupportError, startCamera, stopStream } from "./camera";
import { createNativeBarcodeDecoder } from "./decoder";
import { ScannerError } from "./types";

describe("barcode acceptance", () => {
  it("validates GS1 check digits", () => {
    expect(hasValidGs1CheckDigit("5000112637922")).toBe(true);
    expect(hasValidGs1CheckDigit("5000112637921")).toBe(false);
    expect(hasValidGs1CheckDigit("96385074")).toBe(true); // EAN-8
    expect(hasValidGs1CheckDigit("036000291452")).toBe(true); // UPC-A
    expect(hasValidGs1CheckDigit("abc")).toBe(false);
  });

  it("accepts only supported formats with matching length and valid check digit", () => {
    expect(acceptDecodedBarcode("5000112637922", "ean_13")).toEqual({ ok: true, value: "5000112637922" });
    expect(acceptDecodedBarcode("96385074", "ean_8")).toEqual({ ok: true, value: "96385074" });
    expect(acceptDecodedBarcode("036000291452", "upc_a")).toEqual({ ok: true, value: "036000291452" });
    expect(acceptDecodedBarcode("5000112637921", "ean_13")).toEqual({ ok: false, reason: "INVALID_IDENTIFIER" });
    expect(acceptDecodedBarcode("5000112637922", "upc_a")).toEqual({ ok: false, reason: "INVALID_IDENTIFIER" });
    // QR codes are not product barcodes.
    expect(acceptDecodedBarcode("https://example.com", "qr_code")).toEqual({ ok: false, reason: "UNSUPPORTED_FORMAT" });
  });
});

describe("camera support + errors", () => {
  it("reports insecure context before missing API", () => {
    expect(getCameraSupportError({ isSecureContext: false, mediaDevices: undefined })).toBe("CAMERA_INSECURE_CONTEXT");
    expect(getCameraSupportError({ isSecureContext: true, mediaDevices: undefined })).toBe("CAMERA_NOT_SUPPORTED");
    expect(getCameraSupportError({ isSecureContext: true, mediaDevices: { getUserMedia: vi.fn() } })).toBeNull();
  });

  it("normalizes DOMException names without leaking them", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("CAMERA_PERMISSION_DENIED");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("CAMERA_NOT_FOUND");
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("CAMERA_IN_USE");
    expect(classifyCameraError({ name: "WeirdError", message: "secret detail" })).toBe("CAMERA_START_FAILED");
  });

  it("requests the rear camera as an ideal (not required) constraint", async () => {
    const getUserMedia = vi.fn().mockResolvedValue({} as MediaStream);
    await startCamera({ getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: "environment" } }, audio: false });
  });

  it("retries unconstrained on OverconstrainedError", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce({ name: "OverconstrainedError" })
      .mockResolvedValueOnce({} as MediaStream);
    await startCamera({ getUserMedia });
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: true, audio: false });
  });

  it("throws a normalized ScannerError on permission denial", async () => {
    const getUserMedia = vi.fn().mockRejectedValue({ name: "NotAllowedError", message: "Permission denied by user" });
    await expect(startCamera({ getUserMedia })).rejects.toMatchObject({
      code: "CAMERA_PERMISSION_DENIED",
    });
    await expect(startCamera({ getUserMedia })).rejects.toBeInstanceOf(ScannerError);
  });

  it("stopStream stops every track", () => {
    const a = { stop: vi.fn() };
    const b = { stop: vi.fn() };
    stopStream({ getTracks: () => [a, b] } as unknown as MediaStream);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });
});

describe("native decoder", () => {
  it("returns null when BarcodeDetector is absent", async () => {
    expect(await createNativeBarcodeDecoder({})).toBeNull();
  });

  it("restricts to supported symbologies the browser actually offers", async () => {
    const ctor = vi.fn().mockImplementation(function () {
      return { detect: vi.fn().mockResolvedValue([]) };
    }) as unknown as { getSupportedFormats: () => Promise<string[]> };
    ctor.getSupportedFormats = async () => ["qr_code", "ean_13", "code_128"];
    const decoder = await createNativeBarcodeDecoder({ BarcodeDetector: ctor });
    expect(decoder).not.toBeNull();
    expect(ctor).toHaveBeenCalledWith({ formats: ["ean_13"] });
  });

  it("returns null when none of our formats are supported", async () => {
    const ctor = vi.fn() as unknown as { getSupportedFormats: () => Promise<string[]> };
    ctor.getSupportedFormats = async () => ["qr_code"];
    expect(await createNativeBarcodeDecoder({ BarcodeDetector: ctor })).toBeNull();
  });
});
