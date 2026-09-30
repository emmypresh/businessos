// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ScannerDeps } from "@/lib/products/scanner/use-barcode-scanner";
import { ScannerError } from "@/lib/products/scanner/types";

const { lookupProductByIdentifier } = vi.hoisted(() => ({ lookupProductByIdentifier: vi.fn() }));
vi.mock("@/lib/products/lookup/actions", () => ({ lookupProductByIdentifier }));

import { ProductLookupField } from "./product-lookup-field";

const VALID = "5000112637922";
const INVALID = "5000112637921";

function makeDeps(overrides: Partial<ScannerDeps> & { codes?: { rawValue: string; format: string }[] } = {}) {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "cam" }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const detect = vi.fn().mockResolvedValue(overrides.codes ?? []);
  const deps: ScannerDeps = {
    getSupportError: () => null,
    createDecoder: async () => ({ detect }),
    startCamera: vi.fn().mockResolvedValue(stream),
    listVideoInputIds: async () => ["cam"],
    isHidden: () => false,
    decodeIntervalMs: 5,
    noDetectionNoticeMs: 60_000,
    ...overrides,
  };
  return { deps, track, detect };
}

function Form({ deps }: { deps: ScannerDeps }) {
  const [barcode, setBarcode] = useState("");
  const [name, setName] = useState("Typed name");
  const [price, setPrice] = useState("75");
  return (
    <form>
      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="Price" value={price} onChange={(e) => setPrice(e.target.value)} />
      <ProductLookupField
        businessId="biz-1"
        barcodeValue={barcode}
        onBarcodeChange={setBarcode}
        onApplyName={(v) => {
          if (!name.trim()) setName(v);
        }}
        onApplyCategory={() => {}}
        scannerDeps={deps}
      />
    </form>
  );
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function openScanner() {
  fireEvent.click(screen.getByRole("button", { name: "Scan barcode with camera" }));
}

describe("camera scan → 1Q-C lookup", () => {
  it("a valid scan fills the barcode, closes the scanner, stops the camera and runs the lookup exactly once", async () => {
    lookupProductByIdentifier.mockResolvedValue({
      state: "LOCAL_MATCH",
      identifierType: "EAN_13",
      normalizedValue: VALID,
      product: { productId: "p1", name: "Existing Widget", sku: "W-1", status: "active", sellingPrice: 10 },
    });
    const { deps, track } = makeDeps({ codes: [{ rawValue: VALID, format: "ean_13" }] });
    render(<Form deps={deps} />);
    openScanner();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledWith("biz-1", VALID));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Barcode / GTIN")).toHaveValue(VALID);
    expect(await screen.findByText(/already belongs to Existing Widget/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View product" })).toHaveAttribute("href", "/biz-1/products/p1");
    expect(track.stop).toHaveBeenCalled();
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);
    // Other form fields untouched.
    expect(screen.getByLabelText("Name")).toHaveValue("Typed name");
    expect(screen.getByLabelText("Price")).toHaveValue("75");
  });

  it("an invalid check digit never reaches the lookup; scanner stays open with a notice", async () => {
    const { deps } = makeDeps({ codes: [{ rawValue: INVALID, format: "ean_13" }] });
    render(<Form deps={deps} />);
    openScanner();
    expect(await screen.findByText(/doesn't look like a valid product barcode/)).toBeInTheDocument();
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("permission denied shows the plain-language message, offers manual entry, and keeps the form", async () => {
    const { deps } = makeDeps({ startCamera: vi.fn().mockRejectedValue(new ScannerError("CAMERA_PERMISSION_DENIED")) });
    render(<Form deps={deps} />);
    openScanner();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Camera access was blocked. You can allow camera access in your browser settings or enter the barcode manually."
    );
    expect(deps.startCamera).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enter barcode manually" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const input = screen.getByLabelText("Barcode / GTIN");
    fireEvent.change(input, { target: { value: "MANUAL-1" } });
    expect(input).toHaveValue("MANUAL-1");
    expect(screen.getByLabelText("Name")).toHaveValue("Typed name");
    expect(screen.getByLabelText("Price")).toHaveValue("75");
  });

  it("unsupported browser shows the manual-entry message and never prompts for the camera", async () => {
    const { deps } = makeDeps({ createDecoder: async () => null });
    render(<Form deps={deps} />);
    openScanner();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Camera scanning is not supported on this browser. Enter the barcode manually."
    );
    expect(deps.startCamera).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveValue("Typed name");
  });

  it("closing the scanner stops the camera and lookup is not run", async () => {
    const { deps, track } = makeDeps();
    render(<Form deps={deps} />);
    openScanner();
    await screen.findByText("Point the camera at the barcode.");
    fireEvent.click(screen.getByRole("button", { name: "Close scanner" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(track.stop).toHaveBeenCalled();
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("a slow lookup for scan A never overwrites the result for scan B", async () => {
    let resolveA!: (v: unknown) => void;
    lookupProductByIdentifier
      .mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
      .mockResolvedValueOnce({ state: "NOT_FOUND", identifierType: "EAN_13", normalizedValue: "4006381333931" });
    const first = makeDeps({ codes: [{ rawValue: VALID, format: "ean_13" }] });
    const view = render(<Form deps={first.deps} />);
    openScanner();
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1));

    // Second scan while A is still in flight.
    first.detect.mockResolvedValue([{ rawValue: "4006381333931", format: "ean_13" }]);
    openScanner();
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(2));
    await screen.findByText(/No product information found/);

    resolveA({
      state: "LOCAL_MATCH",
      identifierType: "EAN_13",
      normalizedValue: VALID,
      product: { productId: "stale", name: "Stale A", sku: null, status: "active", sellingPrice: null },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Stale A/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Barcode / GTIN")).toHaveValue("4006381333931");
    view.unmount();
  });
});
