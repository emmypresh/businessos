"use client";

import { useActionState, useState } from "react";
import { addProductIdentifier, removeProductIdentifier } from "@/lib/products/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProductIdentifierRow } from "@/lib/products/identifiers-dal";
import { IDENTIFIER_TYPE, IDENTIFIER_TYPE_LABEL, type IdentifierType } from "@/lib/products/identifiers";

// Phase 1Q-B, phase instruction §29: foundational display/input for
// external product identifiers (GTIN/UPC/EAN/OTHER) — no scanner button,
// no lookup call. The list itself renders for anyone with products.view
// (listProductIdentifiers, server-side, is gated on that permission via
// RLS); the add/remove controls render only for a caller holding
// products.manage — re-checked independently by each Server Action
// itself, this prop only controls whether the controls are shown at all.
export function ProductIdentifiers({
  businessId,
  productId,
  identifiers,
  canManage,
}: {
  businessId: string;
  productId: string;
  identifiers: ProductIdentifierRow[];
  canManage: boolean;
}) {
  const [addState, addAction] = useActionState(addProductIdentifier, undefined);
  const [identifierType, setIdentifierType] = useState<IdentifierType>(IDENTIFIER_TYPE.EAN_13);
  // A Server Action failure re-renders this component. Retain the attempted
  // identifier locally so validation and duplicate errors are recoverable
  // without making the operator retype the code or reselect its type.
  const [submittedIdentifier, setSubmittedIdentifier] = useState("");
  const [submittedIsPrimary, setSubmittedIsPrimary] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>External identifiers</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {identifiers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No barcodes or external codes added yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {identifiers.map((identifier) => (
              <li
                key={identifier.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="flex flex-col">
                  <span className="font-medium">{identifier.identifier_value}</span>
                  <span className="text-xs text-muted-foreground">
                    {IDENTIFIER_TYPE_LABEL[identifier.identifier_type]}
                    {identifier.is_primary ? " · Primary" : ""}
                  </span>
                </span>
                {canManage ? (
                  <RemoveIdentifierButton
                    businessId={businessId}
                    productId={productId}
                    identifierId={identifier.id}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
        <form
          action={addAction}
          className="flex flex-col gap-3 border-t pt-4"
          onSubmit={(event) => {
            const formData = new FormData(event.currentTarget);
            setSubmittedIdentifier(String(formData.get("identifierValue") ?? ""));
            setSubmittedIsPrimary(formData.get("isPrimary") === "on");
            const type = formData.get("identifierType");
            if (typeof type === "string") setIdentifierType(type as IdentifierType);
          }}
        >
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="productId" value={productId} />
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <div className="flex flex-col gap-2">
              <Label htmlFor="identifierType">Type</Label>
              <input type="hidden" name="identifierType" value={identifierType} />
              <Select value={identifierType} onValueChange={(v) => setIdentifierType(v as IdentifierType)}>
                <SelectTrigger id="identifierType" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(IDENTIFIER_TYPE).map((type) => (
                    <SelectItem key={type} value={type}>
                      {IDENTIFIER_TYPE_LABEL[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="identifierValue">Code</Label>
              <Input
                id="identifierValue"
                name="identifierValue"
                defaultValue={submittedIdentifier}
                aria-invalid={!!addState?.fieldErrors?.identifierValue}
                aria-describedby={addState?.fieldErrors?.identifierValue ? "identifier-value-error" : undefined}
              />
              {addState?.fieldErrors?.identifierValue ? (
                <p id="identifier-value-error" role="alert" className="text-sm text-destructive">
                  {addState.fieldErrors.identifierValue[0]}
                </p>
              ) : null}
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-sm font-normal">
            <input type="checkbox" name="isPrimary" defaultChecked={submittedIsPrimary} className="size-4" />
            Set as primary
          </label>
          {addState?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{addState.error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" variant="outline">
            Add identifier
          </Button>
        </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RemoveIdentifierButton({
  businessId,
  productId,
  identifierId,
}: {
  businessId: string;
  productId: string;
  identifierId: string;
}) {
  const [state, action] = useActionState(removeProductIdentifier, undefined);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="identifierId" value={identifierId} />
      {state?.error ? (
        <span role="alert" className="text-xs text-destructive">
          {state.error}
        </span>
      ) : null}
      <Button type="submit" variant="ghost" size="sm" aria-label="Remove identifier">
        Remove
      </Button>
    </form>
  );
}
