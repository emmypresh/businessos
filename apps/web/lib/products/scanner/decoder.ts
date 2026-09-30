import { SUPPORTED_DETECTOR_FORMATS } from "./barcode";

// Phase 1Q-D — narrow decoder abstraction (phase instruction §42). The UI and
// hook only know `detect(video)`; today the sole implementation is the
// browser-native BarcodeDetector. No third-party decoder is bundled: see the
// build brief's decoder strategy for why, and what iOS Safari falls back to.

export type DecodedBarcode = { rawValue: string; format: string };

export interface BarcodeDecoder {
  detect(video: HTMLVideoElement): Promise<DecodedBarcode[]>;
}

type NativeDetector = { detect(source: CanvasImageSource): Promise<DecodedBarcode[]> };
type NativeDetectorCtor = {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

export async function createNativeBarcodeDecoder(
  win: object = window
): Promise<BarcodeDecoder | null> {
  const Ctor = (win as { BarcodeDetector?: unknown }).BarcodeDetector as NativeDetectorCtor | undefined;
  if (typeof Ctor !== "function") return null;

  let formats: string[] = [...SUPPORTED_DETECTOR_FORMATS];
  try {
    if (Ctor.getSupportedFormats) {
      const supported = await Ctor.getSupportedFormats();
      formats = formats.filter((f) => supported.includes(f));
    }
  } catch {
    return null;
  }
  if (formats.length === 0) return null;

  const detector = new Ctor({ formats });
  return { detect: (video) => detector.detect(video) };
}
