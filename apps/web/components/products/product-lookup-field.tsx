"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { lookupProductByIdentifier } from "@/lib/products/lookup/actions";
import { describeLookupResult } from "@/lib/products/lookup/messages";
import type { LookupResult } from "@/lib/products/lookup/types";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Barcode, Loader2, PackageSearch, Search } from "@/components/ui/icon";
import { BarcodeScannerDialog } from "@/components/products/barcode-scanner-dialog";
import type { ScannerDeps } from "@/lib/products/scanner/use-barcode-scanner";

// Phase 1Q-C — the "Barcode / GTIN [____] [Look up]" surface (phase
// instruction §23). Deliberately scoped to product CREATION only (see
// product-form.tsx's own call site) — this IS the existing barcode field,
// not a second, parallel input: the value typed here is exactly what
// gets submitted as the product's `barcode` on save, matching phase
// instruction §6's "no auto-create" (a lookup never writes anything by
// itself; only the eventual form submit does).
export function ProductLookupField({
  businessId,
  barcodeValue,
  onBarcodeChange,
  fieldError,
  onApplyName,
  onApplyCategory,
  scannerDeps,
}: {
  businessId: string;
  barcodeValue: string;
  onBarcodeChange: (value: string) => void;
  fieldError?: string;
  // Only ever called when the target field is currently empty (phase
  // instruction §7/§25) — enforced by the caller (product-form.tsx), not
  // re-checked here, since this component has no visibility into the
  // rest of the form's current values.
  onApplyName: (value: string) => void;
  onApplyCategory: (value: string) => void;
  /** Test seam for the camera scanner; production callers never pass this. */
  scannerDeps?: ScannerDeps;
}) {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [pending, setPending] = useState(false);
  const [applied, setApplied] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Stale-response protection (phase instruction §55/§56): only the
  // MOST RECENT lookup's response is ever applied to `result` — a slower
  // earlier request that resolves after a newer one started is silently
  // dropped instead of overwriting the newer result.
  const requestId = useRef(0);
  // Synchronous in-flight guard. `pending` state only updates after a
  // re-render, so a fast double-click or Enter-then-click could otherwise
  // slip a second submission through before the disabled attribute lands.
  // The UI itself blocks duplicate submits of the SAME active lookup; the
  // server-side in-flight dedupe is defense in depth, not the mechanism.
  const inFlight = useRef(false);

  // Phase 1Q-D: a scan is just another way to supply the identifier — it
  // goes through the exact same runLookup (and therefore the same server
  // action, requestId stale-guard and in-flight guard) as a typed value.
  async function runLookup(valueOverride?: string) {
    const trimmed = (valueOverride ?? barcodeValue).trim();
    if (!trimmed || inFlight.current) return;

    const id = ++requestId.current;
    inFlight.current = true;
    setPending(true);
    setApplied(false);
    try {
      const next = await lookupProductByIdentifier(businessId, trimmed);
      if (requestId.current === id) {
        setResult(next);
      }
    } catch {
      if (requestId.current === id) {
        setResult({ state: "PROVIDER_ERROR", identifierType: "OTHER", normalizedValue: "", errorCode: "PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE" });
      }
    } finally {
      if (requestId.current === id) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  function resetForNewValue() {
    setResult(null);
    requestId.current++;
    inFlight.current = false;
    setPending(false);
  }

  function handleScanned(identifier: string) {
    setScannerOpen(false);
    // Only the barcode field changes; every other form field is untouched.
    // A newer scan supersedes any lookup still in flight for an older value.
    onBarcodeChange(identifier);
    resetForNewValue();
    void runLookup(identifier);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="barcode">Barcode / GTIN</Label>
      <div className="flex flex-wrap gap-2 sm:flex-nowrap">
        <Input
          ref={inputRef}
          id="barcode"
          name="barcode"
          value={barcodeValue}
          className="h-11 basis-full sm:h-8 sm:basis-auto"
          onChange={(e) => {
            // A changed identifier invalidates any prior result — never
            // shown stale against a different code the caller is now
            // typing (phase instruction §56). Editing also abandons any
            // in-flight lookup for the OLD value (its response is dropped by
            // the requestId guard) so a lookup for the NEW value can start.
            onBarcodeChange(e.target.value);
            resetForNewValue();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void runLookup();
            }
          }}
          aria-invalid={!!fieldError}
          aria-describedby={fieldError ? "barcode-error" : undefined}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void runLookup()}
          disabled={pending || !barcodeValue.trim()}
          aria-busy={pending}
          className="h-11 flex-1 sm:h-8 sm:flex-none"
        >
          {pending ? <Loader2 size={16} className="mr-1.5" /> : <Search size={16} className="mr-1.5" />}
          Look up
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setScannerOpen(true)}
          aria-label="Scan barcode with camera"
          className="h-11 flex-1 sm:h-8 sm:flex-none"
        >
          <Barcode size={16} className="mr-1.5" />
          Scan
        </Button>
      </div>
      <BarcodeScannerDialog
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onDetected={handleScanned}
        onManualEntry={() => {
          setScannerOpen(false);
          // After the dialog's own focus-return, put the cursor in the field.
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        deps={scannerDeps}
      />
      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Looking up barcode…
        </p>
      ) : null}
      {fieldError ? (
        <p id="barcode-error" role="alert" className="text-sm text-destructive">
          {fieldError}
        </p>
      ) : null}

      {result ? <LookupResultCard
        businessId={businessId}
        result={result}
        applied={applied}
        onApply={() => {
          if (result.state !== "EXTERNAL_MATCH") return;
          onApplyName(result.candidate.name);
          if (result.candidate.categoryLabel) onApplyCategory(result.candidate.categoryLabel);
          setApplied(true);
        }}
      /> : null}
    </div>
  );
}

function LookupResultCard({
  businessId,
  result,
  applied,
  onApply,
}: {
  businessId: string;
  result: LookupResult;
  applied: boolean;
  onApply: () => void;
}) {
  if (result.state === "LOCAL_MATCH") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <span className="flex flex-col">
          <span className="font-medium">This barcode already belongs to {result.product.name}.</span>
          <span className="text-xs text-muted-foreground">
            {result.product.sku ? `SKU ${result.product.sku} · ` : ""}
            {result.product.status}
          </span>
        </span>
        <Link
          href={`/${businessId}/products/${result.product.productId}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          View product
        </Link>
      </div>
    );
  }

  if (result.state === "EXTERNAL_MATCH") {
    return (
      <div className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm" role="status">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          External suggestion — Open Food Facts
        </span>
        <div className="flex items-start gap-3">
          <PackageSearch size={20} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex flex-col">
            <span className="font-medium">{result.candidate.name}</span>
            <span className="text-xs text-muted-foreground">
              {[result.candidate.brand, result.candidate.quantity, result.candidate.categoryLabel]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onApply} disabled={applied}>
            {applied ? "Applied" : "Use product details"}
          </Button>
        </div>
      </div>
    );
  }

  if (result.state === "INVALID") {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{describeLookupResult(result)}</AlertDescription>
      </Alert>
    );
  }

  // NOT_FOUND and PROVIDER_ERROR share the same non-destructive framing —
  // both are recoverable, non-blocking states (phase instruction §16/§26).
  return (
    <p role={result.state === "PROVIDER_ERROR" ? "alert" : "status"} className="text-sm text-muted-foreground">
      {describeLookupResult(result)}
    </p>
  );
}
