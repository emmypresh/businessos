// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

const { lookupProductByIdentifier } = vi.hoisted(() => ({ lookupProductByIdentifier: vi.fn() }));
vi.mock("@/lib/products/lookup/actions", () => ({ lookupProductByIdentifier }));

import { ProductLookupField } from "./product-lookup-field";

const EAN13 = "5000112637922";
const EAN13_B = "4006381333931";
const EAN8 = "96385074";
const UPCA = "036000291452";
const BAD = "5000112637921";

// Deterministic clock: event timing is whatever the test says it is.
let clock = 1000;
const timeSource = () => clock;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clock = 1000;
});

const submitted = vi.fn();

function Form({ withOutsideSearch = true }: { withOutsideSearch?: boolean }) {
  const [barcode, setBarcode] = useState("");
  const [name, setName] = useState("Coca-Cola 50cl");
  return (
    <div>
      {withOutsideSearch ? <input aria-label="Global search" defaultValue="" /> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted();
        }}
      >
        <input aria-label="Product Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Price" type="number" defaultValue="235000" />
        <input aria-label="Stock" type="number" defaultValue="5" />
        <textarea aria-label="Description" defaultValue="Customer requested black version" />
        <input aria-label="Password" type="password" defaultValue="" />
        <input aria-label="Card number" autoComplete="cc-number" defaultValue="" />
        <ProductLookupField
          businessId="biz-1"
          barcodeValue={barcode}
          onBarcodeChange={setBarcode}
          onApplyName={(v) => {
            if (!name.trim()) setName(v);
          }}
          onApplyCategory={() => {}}
          hardwareTimeSource={timeSource}
        />
        <button type="button">Other button</button>
      </form>
    </div>
  );
}

// Emulates the browser: dispatch keydown, and if nothing prevented it, insert
// the character the way the browser's default action would.
function press(el: HTMLElement, key: string, gapMs: number, init: KeyboardEventInit = {}) {
  clock += gapMs;
  const notPrevented = fireEvent.keyDown(el, { key, ...init });
  if (notPrevented && /^\d$/.test(key) && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, el.value + key);
    fireEvent.input(el);
  }
  return notPrevented;
}

/** Type a burst; returns whether the terminator's default action was allowed. */
function burst(el: HTMLElement, code: string, gapMs: number, terminator: "Enter" | "Tab" | null = "Enter") {
  for (const ch of code) press(el, ch, gapMs);
  return terminator ? press(el, terminator, gapMs) : true;
}

const barcodeInput = () => screen.getByLabelText("Barcode / GTIN") as HTMLInputElement;
const nameInput = () => screen.getByLabelText("Product Name") as HTMLInputElement;

function focusOn(el: HTMLElement) {
  act(() => el.focus());
  return el;
}

function expectFormIntact() {
  expect(nameInput()).toHaveValue("Coca-Cola 50cl");
  expect(screen.getByLabelText("Price")).toHaveValue(235000);
  expect(screen.getByLabelText("Stock")).toHaveValue(5);
  expect(screen.getByLabelText("Description")).toHaveValue("Customer requested black version");
}

const NOT_FOUND = (v: string) => ({ state: "NOT_FOUND", identifierType: "EAN_13", normalizedValue: v });

describe("hardware scan → 1Q-C lookup", () => {
  it("scan while Product Name is focused: name untouched, barcode filled, lookup once, no form submit", async () => {
    lookupProductByIdentifier.mockResolvedValue({
      state: "LOCAL_MATCH",
      identifierType: "EAN_13",
      normalizedValue: EAN13,
      product: { productId: "p1", name: "Existing Widget", sku: "W-1", status: "active", sellingPrice: 10 },
    });
    render(<Form />);
    const name = focusOn(nameInput());
    const enterAllowed = burst(name, EAN13, 8);

    expect(enterAllowed).toBe(false); // Enter consumed → no implicit form submit
    expect(submitted).not.toHaveBeenCalled();
    expect(nameInput()).toHaveValue("Coca-Cola 50cl"); // hard requirement §17
    expect(barcodeInput()).toHaveValue(EAN13);
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1));
    expect(lookupProductByIdentifier).toHaveBeenCalledWith("biz-1", EAN13);
    expect(await screen.findByText(/already belongs to Existing Widget/)).toBeInTheDocument();
    expect(screen.getByText("Barcode scanned.")).toBeInTheDocument();
    expectFormIntact();
  });

  it("scan while Price / Description (textarea) are focused leaves them untouched", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(EAN13));
    render(<Form />);
    const price = focusOn(screen.getByLabelText("Price"));
    burst(price, EAN13, 8);
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1));
    expectFormIntact();

    const desc = focusOn(screen.getByLabelText("Description"));
    const enterAllowed = burst(desc, EAN8, 8);
    expect(enterAllowed).toBe(false); // no newline injected
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(2));
    expectFormIntact();
    expect(barcodeInput()).toHaveValue(EAN8);
  });

  it("scan with the barcode field focused fills it and looks up once (and Enter does not double-fire)", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(EAN13));
    render(<Form />);
    burst(focusOn(barcodeInput()), EAN13, 8);
    expect(barcodeInput()).toHaveValue(EAN13);
    await screen.findByText(/No product information found/);
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);
  });

  it("scan with a non-text control (button) focused works and the button is not clicked", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(UPCA));
    render(<Form />);
    const btn = focusOn(screen.getByRole("button", { name: "Other button" }));
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    expect(burst(btn, UPCA, 8)).toBe(false);
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledWith("biz-1", UPCA));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("scan with nothing focused (body) works", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(EAN8));
    render(<Form />);
    burst(document.body, EAN8, 10);
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledWith("biz-1", EAN8));
  });

  it("Tab terminator scans and focus is kept; Tab without a buffered scan is left alone", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(EAN13));
    render(<Form />);
    const name = focusOn(nameInput());
    expect(press(name, "Tab", 8)).toBe(true); // nothing buffered → normal Tab navigation
    expect(burst(name, EAN13, 8, "Tab")).toBe(false);
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1));
    expect(nameInput()).toHaveValue("Coca-Cola 50cl");
  });

  it("external suggestion still requires an explicit apply (no silent overwrite)", async () => {
    lookupProductByIdentifier.mockResolvedValue({
      state: "EXTERNAL_MATCH",
      identifierType: "EAN_13",
      normalizedValue: EAN13,
      candidate: { name: "Fanta Orange 50cl", brand: "Fanta", quantity: "50cl", categoryLabel: "Drinks" },
    });
    render(<Form />);
    burst(focusOn(nameInput()), EAN13, 8);
    expect(await screen.findByText("Fanta Orange 50cl")).toBeInTheDocument();
    expect(nameInput()).toHaveValue("Coca-Cola 50cl");
    expect(screen.getByRole("button", { name: "Use product details" })).toBeEnabled();
  });

  it("not found keeps the barcode visible and the whole form intact", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(EAN13));
    render(<Form />);
    burst(focusOn(nameInput()), EAN13, 8);
    expect(await screen.findByText(/No product information found/)).toBeInTheDocument();
    expect(barcodeInput()).toHaveValue(EAN13);
    expectFormIntact();
  });

  it.each([
    ["provider timeout", { state: "PROVIDER_ERROR", identifierType: "EAN_13", normalizedValue: EAN13, errorCode: "PRODUCT_LOOKUP_TIMEOUT" }],
    ["rate limit", { state: "PROVIDER_ERROR", identifierType: "EAN_13", normalizedValue: EAN13, errorCode: "PRODUCT_LOOKUP_RATE_LIMITED" }],
  ])("%s keeps the form intact", async (_n, result) => {
    lookupProductByIdentifier.mockResolvedValue(result);
    render(<Form />);
    burst(focusOn(nameInput()), EAN13, 8);
    expect(await screen.findByRole("alert")).toHaveTextContent(/You can continue entering the product manually/);
    expectFormIntact();
  });

  it("a thrown network failure keeps the form intact", async () => {
    lookupProductByIdentifier.mockRejectedValue(new Error("network down"));
    render(<Form />);
    burst(focusOn(nameInput()), EAN13, 8);
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/);
    expectFormIntact();
  });
});

describe("invalid scans", () => {
  it("bad check digit: no lookup, clear notice, digits kept in the barcode field, form intact", async () => {
    render(<Form />);
    const enterAllowed = burst(focusOn(nameInput()), BAD, 8);
    expect(enterAllowed).toBe(false);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn.t a valid product barcode/);
    expect(barcodeInput()).toHaveValue(BAD);
    expectFormIntact();
  });

  it("too short (fast, 7 digits) is not a scan: nothing consumed, nothing looked up", () => {
    render(<Form />);
    const name = focusOn(nameInput());
    expect(burst(name, "1234567", 8)).toBe(true); // Enter is left to the browser
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
    expect(nameInput()).toHaveValue("Coca-Cola 50cl1234567"); // ordinary typing, untouched
  });

  it("letters in the burst never trigger a lookup", () => {
    render(<Form />);
    const name = focusOn(nameInput());
    for (const ch of "ABCD12345678") press(name, ch, 8);
    press(name, "Enter", 8);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });
});

describe("human typing and normal keyboard behavior", () => {
  it("slow typing of a valid barcode into the barcode field is ordinary input: no auto-lookup", async () => {
    render(<Form />);
    const input = focusOn(barcodeInput());
    burst(input, EAN13, 150); // Enter reaches the field's own handler (which prevents default itself)
    // The field's own manual-Enter handler runs the lookup exactly as before 1Q-E.
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Barcode scanned.")).not.toBeInTheDocument();
  });

  it("slow typing into Product Name is untouched, Enter is not intercepted", () => {
    render(<Form />);
    const name = focusOn(nameInput());
    expect(burst(name, EAN13, 120)).toBe(true);
    expect(nameInput()).toHaveValue(`Coca-Cola 50cl${EAN13}`);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("the manual Look up button still works", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(EAN13));
    render(<Form />);
    fireEvent.change(barcodeInput(), { target: { value: EAN13 } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText(/No product information found/);
    expect(lookupProductByIdentifier).toHaveBeenCalledWith("biz-1", EAN13);
  });

  it("Ctrl / Meta / Alt keyboard activity is not scanner input and is not prevented", () => {
    render(<Form />);
    const name = focusOn(nameInput());
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      for (const ch of EAN13) press(name, ch, 8, mod);
      expect(press(name, "Enter", 8, mod)).toBe(true);
    }
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("IME composition is never scanner input", () => {
    render(<Form />);
    const name = focusOn(nameInput());
    for (const ch of EAN13) press(name, ch, 8, { isComposing: true });
    expect(press(name, "Enter", 8, { isComposing: true })).toBe(true);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("a held key (auto-repeat) is never a scan", () => {
    render(<Form />);
    const name = focusOn(nameInput());
    for (let i = 0; i < 8; i++) press(name, "0", 30, { repeat: true });
    expect(press(name, "Enter", 30)).toBe(true);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("pasting a barcode is manual input, not a scan (no key burst, no lookup)", () => {
    render(<Form />);
    fireEvent.change(barcodeInput(), { target: { value: EAN13 } });
    expect(barcodeInput()).toHaveValue(EAN13);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
    expect(screen.queryByText("Barcode scanned.")).not.toBeInTheDocument();
  });
});

describe("scope: sensitive and unrelated fields", () => {
  it("a password field is never captured or restored and never triggers lookup", () => {
    render(<Form />);
    const pw = focusOn(screen.getByLabelText("Password"));
    expect(burst(pw, EAN13, 8)).toBe(true);
    expect(pw).toHaveValue(EAN13); // untouched ordinary typing
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("a payment-card-style field (autocomplete cc-*) is never captured", () => {
    render(<Form />);
    const card = focusOn(screen.getByLabelText("Card number"));
    expect(burst(card, EAN13, 8)).toBe(true);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("an element opted out via data-no-hardware-scan is never captured", () => {
    render(
      <form>
        <div data-no-hardware-scan>
          <input aria-label="Secret" />
        </div>
        <ProductLookupField
          businessId="biz-1"
          barcodeValue=""
          onBarcodeChange={() => {}}
          onApplyName={() => {}}
          onApplyCategory={() => {}}
          hardwareTimeSource={timeSource}
        />
      </form>
    );
    const secret = focusOn(screen.getByLabelText("Secret"));
    expect(burst(secret, EAN13, 8)).toBe(true);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("keys typed outside the product form (global search) are ignored", () => {
    render(<Form />);
    const search = focusOn(screen.getByLabelText("Global search"));
    expect(burst(search, EAN13, 8)).toBe(true);
    expect(search).toHaveValue(EAN13);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });

  it("the listener is removed on unmount", () => {
    const { unmount } = render(<Form />);
    unmount();
    expect(burst(document.body, EAN13, 8)).toBe(true);
    expect(lookupProductByIdentifier).not.toHaveBeenCalled();
  });
});

describe("duplicate and replacement scans", () => {
  it("the same scan fired repeatedly while pending produces exactly one lookup (name focused)", async () => {
    let resolve!: (v: unknown) => void;
    lookupProductByIdentifier.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<Form />);
    const name = focusOn(nameInput());
    burst(name, EAN13, 8);
    burst(name, EAN13, 8);
    burst(name, EAN13, 8);
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);
    await act(async () => resolve(NOT_FOUND(EAN13)));
    expect(await screen.findByText(/No product information found/)).toBeInTheDocument();
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);
    expectFormIntact();
  });

  it("the same scan repeated with the barcode field focused still yields one request and a visible result", async () => {
    let resolve!: (v: unknown) => void;
    lookupProductByIdentifier.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<Form />);
    const input = focusOn(barcodeInput());
    burst(input, EAN13, 8);
    burst(input, EAN13, 8); // the scanner's own keystrokes edit this field
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);
    await act(async () => resolve(NOT_FOUND(EAN13)));
    expect(await screen.findByText(/No product information found/)).toBeInTheDocument();
    expect(barcodeInput()).toHaveValue(EAN13);
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);
  });

  it("a legitimate later rescan (after the duplicate window) runs a fresh lookup", async () => {
    lookupProductByIdentifier.mockResolvedValue(NOT_FOUND(EAN13));
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    render(<Form />);
    const name = focusOn(nameInput());
    burst(name, EAN13, 8);
    await screen.findByText(/No product information found/);
    now.mockReturnValue(1000 + 5000);
    burst(name, EAN13, 8);
    await waitFor(() => expect(lookupProductByIdentifier).toHaveBeenCalledTimes(2));
  });

  it("scan B while A is pending: B wins, A's late response cannot overwrite it", async () => {
    let resolveA!: (v: unknown) => void;
    lookupProductByIdentifier
      .mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
      .mockResolvedValueOnce(NOT_FOUND(EAN13_B));
    render(<Form />);
    const name = focusOn(nameInput());
    burst(name, EAN13, 8);
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(1);
    burst(name, EAN13_B, 8);
    await screen.findByText(/No product information found/);
    expect(barcodeInput()).toHaveValue(EAN13_B);

    await act(async () =>
      resolveA({
        state: "LOCAL_MATCH",
        identifierType: "EAN_13",
        normalizedValue: EAN13,
        product: { productId: "stale", name: "Stale A", sku: null, status: "active", sellingPrice: null },
      })
    );
    expect(screen.queryByText(/Stale A/)).not.toBeInTheDocument();
    expect(barcodeInput()).toHaveValue(EAN13_B);
    expect(lookupProductByIdentifier).toHaveBeenCalledTimes(2);
  });
});
