// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

const { lookupProductByIdentifier } = vi.hoisted(() => ({ lookupProductByIdentifier: vi.fn() }));
vi.mock("@/lib/products/lookup/actions", () => ({ lookupProductByIdentifier }));

import { ProductLookupField } from "./product-lookup-field";

const BUSINESS_ID = "biz-1";

function Harness() {
  return <ProductLookupFieldWrapper />;
}

// A tiny stateful wrapper — product-lookup-field.tsx's onApply* props are
// callbacks, not internal state; a real caller (product-form.tsx) decides
// whether to apply based on whether ITS OWN field is currently empty
// (phase instruction §7). This mirrors that exact contract in the test.
function ProductLookupFieldWrapper() {
  const [barcode, setBarcode] = useState("");
  const [name, setName] = useState("");
  return (
    <div>
      <span data-testid="name-value">{name}</span>
      <ProductLookupField
        businessId={BUSINESS_ID}
        barcodeValue={barcode}
        onBarcodeChange={setBarcode}
        onApplyName={(value: string) => {
          if (!name.trim()) setName(value);
        }}
        onApplyCategory={() => {}}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProductLookupField", () => {
  it("shows a local match card with a link to the existing product", async () => {
    lookupProductByIdentifier.mockResolvedValue({
      state: "LOCAL_MATCH",
      identifierType: "EAN_13",
      normalizedValue: "5000112637922",
      product: { productId: "prod-1", name: "Existing Widget", sku: "WID-1", status: "active", sellingPrice: 10 },
    });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Barcode / GTIN"), { target: { value: "5000112637922" } });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByText(/This barcode already belongs to Existing Widget/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "View product" })).toHaveAttribute("href", "/biz-1/products/prod-1");
  });

  it("shows a not-found message without clearing the barcode field", async () => {
    lookupProductByIdentifier.mockResolvedValue({ state: "NOT_FOUND", identifierType: "OTHER", normalizedValue: "ACME-1" });
    render(<Harness />);
    const input = screen.getByLabelText("Barcode / GTIN");
    fireEvent.change(input, { target: { value: "ACME-1" } });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByText(/No product information found/)).toBeInTheDocument());
    expect(input).toHaveValue("ACME-1");
  });

  it("shows an inline invalid-identifier error without clearing the field", async () => {
    lookupProductByIdentifier.mockResolvedValue({ state: "INVALID", identifierType: "EAN_13", normalizedValue: "5000112637921" });
    render(<Harness />);
    const input = screen.getByLabelText("Barcode / GTIN");
    fireEvent.change(input, { target: { value: "5000112637921" } });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/valid barcode/i));
    expect(input).toHaveValue("5000112637921");
  });

  it("shows a provider-error message as a non-blocking, recoverable alert", async () => {
    lookupProductByIdentifier.mockResolvedValue({
      state: "PROVIDER_ERROR",
      identifierType: "GTIN",
      normalizedValue: "12345678901234",
      errorCode: "PRODUCT_LOOKUP_TIMEOUT",
    });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Barcode / GTIN"), { target: { value: "12345678901234" } });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/timed out/i));
  });

  it("applies an external candidate's name only on explicit confirmation, never automatically", async () => {
    lookupProductByIdentifier.mockResolvedValue({
      state: "EXTERNAL_MATCH",
      identifierType: "GTIN",
      normalizedValue: "3017620422003",
      candidate: {
        identifier: "3017620422003",
        identifierType: "GTIN",
        name: "Nutella",
        brand: "Ferrero",
        description: null,
        imageUrl: null,
        categoryLabel: "Spreads",
        quantity: "400g",
        manufacturer: null,
        sourceProvider: "open_food_facts",
        sourceReference: "3017620422003",
      },
    });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Barcode / GTIN"), { target: { value: "3017620422003" } });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByText("Nutella")).toBeInTheDocument());
    // Not applied yet — the caller's own name field is still empty.
    expect(screen.getByTestId("name-value")).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: "Use product details" }));
    await waitFor(() => expect(screen.getByTestId("name-value")).toHaveTextContent("Nutella"));
  });

  it("ignores a stale response from an earlier lookup once a newer one has resolved", async () => {
    let resolveFirst!: (value: unknown) => void;
    lookupProductByIdentifier
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ state: "NOT_FOUND", identifierType: "OTHER", normalizedValue: "SECOND" });

    render(<Harness />);
    const input = screen.getByLabelText("Barcode / GTIN");
    const button = screen.getByRole("button", { name: /look up/i });

    fireEvent.change(input, { target: { value: "FIRST" } });
    fireEvent.click(button);
    fireEvent.change(input, { target: { value: "SECOND" } });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText(/No product information found/)).toBeInTheDocument());

    // The first (stale) request now resolves — it must NOT overwrite the
    // already-rendered, newer NOT_FOUND result.
    resolveFirst({
      state: "LOCAL_MATCH",
      identifierType: "OTHER",
      normalizedValue: "FIRST",
      product: { productId: "stale", name: "Stale Product", sku: null, status: "active", sellingPrice: null },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/Stale Product/)).not.toBeInTheDocument();
    expect(screen.getByText(/No product information found/)).toBeInTheDocument();
  });

  it("disables the button and shows an accessible loading state while pending, then re-enables", async () => {
    let resolveLookup!: (value: unknown) => void;
    lookupProductByIdentifier.mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve; }));
    render(<Harness />);
    const input = screen.getByLabelText("Barcode / GTIN");
    const button = screen.getByRole("button", { name: /look up/i });

    fireEvent.change(input, { target: { value: "ACME-1" } });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Looking up barcode…");
    expect(input).toHaveValue("ACME-1");

    resolveLookup({ state: "NOT_FOUND", identifierType: "OTHER", normalizedValue: "ACME-1" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(input).toHaveValue("ACME-1");
  });

  it("blocks duplicate submission from repeated clicks and Enter while pending, and allows a new lookup after", async () => {
    let resolveLookup!: (value: unknown) => void;
    lookupProductByIdentifier.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    render(<Harness />);
    const input = screen.getByLabelText("Barcode / GTIN");
    const button = screen.getByRole("button", { name: /look up/i });

    fireEvent.change(input, { target: { value: "ACME-1" } });
    // Synchronous burst, before any re-render could apply `disabled`.
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);

    resolveLookup({ state: "NOT_FOUND", identifierType: "OTHER", normalizedValue: "ACME-1" });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(2);
    resolveLookup({ state: "NOT_FOUND", identifierType: "OTHER", normalizedValue: "ACME-1" });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("lets a lookup for an edited value start while an earlier one is pending, and A never overwrites B", async () => {
    let resolveA!: (value: unknown) => void;
    lookupProductByIdentifier
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce({ state: "NOT_FOUND", identifierType: "OTHER", normalizedValue: "B" });
    render(<Harness />);
    const input = screen.getByLabelText("Barcode / GTIN");
    const button = screen.getByRole("button", { name: /look up/i });

    fireEvent.change(input, { target: { value: "A" } });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());

    fireEvent.change(input, { target: { value: "B" } }); // abandons A
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/No product information found/)).toBeInTheDocument());
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(2);

    resolveA({
      state: "LOCAL_MATCH",
      identifierType: "OTHER",
      normalizedValue: "A",
      product: { productId: "stale", name: "Stale A", sku: null, status: "active", sellingPrice: null },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/Stale A/)).not.toBeInTheDocument();
    expect(screen.getByText(/No product information found/)).toBeInTheDocument();
    expect(button).toBeEnabled();
  });
});
