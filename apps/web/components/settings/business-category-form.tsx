"use client";

import { useActionState, useId, useState } from "react";
import { updateBusinessCategory } from "@/lib/business/actions";
import type { BusinessCategory } from "@/lib/business/categories-dal";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function BusinessCategoryForm({
  businessId,
  currentCategoryCode,
  currentCustomLabel,
  categories,
  inactiveCurrentCategory = null,
}: {
  businessId: string;
  currentCategoryCode: string | null;
  currentCustomLabel: string | null;
  categories: BusinessCategory[];
  // The business's currently-assigned category, when it has since been
  // deactivated. Rendered as a disabled, clearly-labeled historical option
  // so its value stays visible without being reselectable — active-only
  // options in `categories` are the ones a user can actually choose.
  inactiveCurrentCategory?: BusinessCategory | null;
}) {
  const [state, action, pending] = useActionState(updateBusinessCategory, undefined);
  const [categoryCode, setCategoryCode] = useState(currentCategoryCode ?? "");
  const [customCategoryLabel, setCustomCategoryLabel] = useState(currentCustomLabel ?? "");
  const categoryFieldId = useId();
  const customLabelFieldId = useId();
  // Lookup set for label resolution (SelectValue) includes the inactive
  // historical category so its name still resolves; it is NOT part of
  // `categories`, the list actually rendered as choosable SelectItems.
  const allSelectableAndCurrent = inactiveCurrentCategory ? [...categories, inactiveCurrentCategory] : categories;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="categoryCode" value={categoryCode} />
      <div className="flex w-full flex-col gap-1.5 sm:w-80">
        <Label htmlFor={categoryFieldId}>Business category</Label>
        <Select value={categoryCode} onValueChange={(v) => setCategoryCode(v ?? "")}>
          <SelectTrigger
            id={categoryFieldId}
            className="w-full"
            aria-invalid={!!state?.fieldErrors?.categoryCode}
          >
            {/* See create-business-form.tsx's identical comment: Base UI's
                SelectValue only learns an item's label once the (closed-by-
                default, portal-rendered) popup has opened at least once, so
                a business's existing category would otherwise render as its
                raw code (e.g. "OTHER") on first page load. */}
            <SelectValue placeholder="Choose a category">
              {(value: string) => allSelectableAndCurrent.find((c) => c.code === value)?.name ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {inactiveCurrentCategory ? (
              // No custom aria-label: the visible text itself already
              // conveys the inactive state (checklist item 8's "visible
              // text, not color-only"), and `disabled` gives the native
              // aria-disabled semantics keyboard/screen-reader navigation
              // needs — a divergent aria-label would only make the
              // accessible name harder to predict from what's on screen.
              <SelectItem key={inactiveCurrentCategory.id} value={inactiveCurrentCategory.code} disabled>
                {inactiveCurrentCategory.name} (Inactive)
              </SelectItem>
            ) : null}
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.code}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {inactiveCurrentCategory ? (
          <p className="text-sm text-muted-foreground">
            The current category is no longer active. Choose a different category to replace it.
          </p>
        ) : null}
        {state?.fieldErrors?.categoryCode ? (
          <p role="alert" className="text-sm text-destructive">{state.fieldErrors.categoryCode[0]}</p>
        ) : null}
      </div>

      {categoryCode === "OTHER" ? (
        <div className="flex w-full flex-col gap-1.5 sm:w-80">
          <Label htmlFor={customLabelFieldId}>Describe your business</Label>
          <Input
            id={customLabelFieldId}
            name="customCategoryLabel"
            value={customCategoryLabel}
            onChange={(e) => setCustomCategoryLabel(e.target.value)}
            maxLength={100}
            aria-invalid={!!state?.fieldErrors?.customCategoryLabel}
          />
          {state?.fieldErrors?.customCategoryLabel ? (
            <p role="alert" className="text-sm text-destructive">{state.fieldErrors.customCategoryLabel[0]}</p>
          ) : null}
        </div>
      ) : null}

      <div>
        <Button
          type="submit"
          disabled={
            pending || !categoryCode || (categoryCode === "OTHER" && customCategoryLabel.trim().length < 2)
          }
        >
          Save category
        </Button>
      </div>
      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      {state?.success ? <p className="text-sm text-muted-foreground">Category updated.</p> : null}
    </form>
  );
}
