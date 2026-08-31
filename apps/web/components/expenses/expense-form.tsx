"use client";

import { useActionState, useState } from "react";
import { createExpense } from "@/lib/expenses/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { PAYMENT_METHOD, PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/expenses/constants";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";

function toLocalDatetimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Radix Select cannot represent an empty-string item value, so the
// "Company-wide / no branch" choice needs its own sentinel — translated
// back to "" (and therefore omitted from the form payload entirely) at the
// one point it's read, never leaked any further.
const COMPANY_WIDE = "company-wide";

export function ExpenseForm({
  businessId,
  categories,
  branches,
  primaryBranchId,
}: {
  businessId: string;
  categories: { id: string; name: string }[];
  // Phase 1G: deliberately EVERY active branch of the business, not just
  // the caller's own assignment — create_expense's own authorization is
  // expenses.manage ALONE, with no has_branch_access requirement (see
  // that migration's own header comment: expense attribution is a
  // back-office/accounting concern, not an operational-presence one), so
  // narrowing this picker to "my own branches" would be a UI-invented
  // restriction the database itself doesn't apply.
  branches: { id: string; name: string }[];
  primaryBranchId: string | null;
}) {
  const [state, formAction] = useActionState(createExpense, undefined);

  // Generated ONCE, at mount — never regenerated on re-render or a
  // corrected resubmission. Stable across a failed submission (this
  // component stays mounted, so the retry reuses the same key); fresh
  // only when a brand-new instance of this form mounts (a fresh page
  // load). Matches the approved Phase 1C/1D mounted-intent pattern
  // exactly (components/products/product-form.tsx,
  // components/sales/sale-form.tsx). Never rendered anywhere in the UI.
  const [creationKey] = useState(() => crypto.randomUUID());

  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  // Phase 1G: defaults to the caller's own active primary branch when one
  // exists (an operational, branch-based default — matching every other
  // Phase 1G create workflow) while always keeping an explicit,
  // one-click "Company-wide" option available — never silently forced
  // into a branch merely because the database permits NULL.
  const [branchId, setBranchId] = useState(primaryBranchId ?? COMPANY_WIDE);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(PAYMENT_METHOD.CASH);
  const [incurredAtLocal, setIncurredAtLocal] = useState(() => toLocalDatetimeInputValue(new Date()));

  // The browser's OWN local-to-UTC conversion, computed here client-side
  // from the visible datetime-local value. Deliberately never deferred to
  // the server: `new Date(rawString)` running on the server would resolve
  // against the SERVER's timezone, not the submitting user's, which could
  // silently shift the recorded instant. The resulting ISO string
  // (carrying an explicit `Z`) is what's actually submitted as
  // `incurredAt`, and parses identically regardless of which timezone the
  // server process runs in.
  const incurredAtIso = incurredAtLocal && !Number.isNaN(new Date(incurredAtLocal).getTime())
    ? new Date(incurredAtLocal).toISOString()
    : "";

  if (categories.length === 0) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          No active expense categories are available. Create a category before recording an expense.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form action={formAction} data-testid="expense-form" className="flex flex-col gap-6 max-w-2xl">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="creationKey" value={creationKey} />
      <input type="hidden" name="categoryId" value={categoryId} />
      <input type="hidden" name="paymentMethod" value={paymentMethod} />
      <input type="hidden" name="incurredAt" value={incurredAtIso} />
      <input type="hidden" name="branchId" value={branchId === COMPANY_WIDE ? "" : branchId} />

      <div className="grid gap-4 sm:grid-cols-2">
        {/* min-w-0: lets this grid item shrink below a 100-character
            branch name's intrinsic width instead of forcing the form
            wider than the viewport. Codex adversarial review,
            application-layer round 2, Blocker 6. */}
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="branch-select">Branch</Label>
          <Select value={branchId} onValueChange={(value) => setBranchId(value ?? COMPANY_WIDE)}>
            <SelectTrigger
              id="branch-select"
              className="w-full min-w-0"
              aria-invalid={!!state?.fieldErrors?.branchId}
              aria-describedby={state?.fieldErrors?.branchId ? "branch-select-error" : undefined}
            >
              <SelectValue placeholder="Choose a branch">
                {(value: string) =>
                  resolveBranchSelectLabel(value, branches, {
                    sentinels: { [COMPANY_WIDE]: "Company-wide" },
                    placeholder: "Choose a branch",
                  })
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={COMPANY_WIDE}>Company-wide</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id} className="max-w-full">
                  <span className="truncate">
                    {branch.name}
                    {branch.id === primaryBranchId ? " (Your primary)" : ""}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {state?.fieldErrors?.branchId ? (
            <p id="branch-select-error" role="alert" className="text-sm text-destructive">
              {state.fieldErrors.branchId[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="category-select">Category</Label>
          <Select value={categoryId} onValueChange={(value) => setCategoryId(value ?? "")}>
            <SelectTrigger id="category-select" aria-invalid={!!state?.fieldErrors?.categoryId}>
              <SelectValue placeholder="Choose a category" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {state?.fieldErrors?.categoryId ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.categoryId[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="amount">Amount (NGN)</Label>
          <Input
            id="amount"
            name="amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            // Client-side pattern only — a courtesy that mirrors
            // create_expense's own exact-precision rule (at most 2
            // decimal places, greater than zero, no negative, no leading
            // +/scientific notation); the RPC's own INVALID_EXPENSE_AMOUNT
            // check remains the actual authority. The leading negative
            // lookahead specifically excludes "0", "0.0", and "0.00" (all
            // of which the base \d+(\.\d{1,2})? shape would otherwise
            // accept syntactically) so a zero amount is rejected by the
            // browser's own constraint validation, not just by the Zod
            // schema after submission.
            pattern="^(?!0(\.0{1,2})?$)\d+(\.\d{1,2})?$"
            aria-invalid={!!state?.fieldErrors?.amount}
            required
          />
          {state?.fieldErrors?.amount ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.amount[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="payment-method-select">Payment method</Label>
          <Select
            value={paymentMethod}
            onValueChange={(value) => setPaymentMethod((value as PaymentMethod) ?? PAYMENT_METHOD.CASH)}
          >
            <SelectTrigger id="payment-method-select" aria-invalid={!!state?.fieldErrors?.paymentMethod}>
              <SelectValue placeholder="Choose a payment method" />
            </SelectTrigger>
            <SelectContent>
              {Object.values(PAYMENT_METHOD).map((method) => (
                <SelectItem key={method} value={method}>
                  {PAYMENT_METHOD_LABEL[method]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {state?.fieldErrors?.paymentMethod ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.paymentMethod[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="incurred-at">Date incurred</Label>
          <Input
            id="incurred-at"
            type="datetime-local"
            value={incurredAtLocal}
            onChange={(e) => setIncurredAtLocal(e.target.value)}
            max={toLocalDatetimeInputValue(new Date())}
            aria-invalid={!!state?.fieldErrors?.incurredAt}
            required
          />
          {state?.fieldErrors?.incurredAt ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.incurredAt[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="payee">Payee</Label>
          <Input id="payee" name="payee" aria-invalid={!!state?.fieldErrors?.payee} />
          {state?.fieldErrors?.payee ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.payee[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="reference">Reference</Label>
          <Input id="reference" name="reference" aria-invalid={!!state?.fieldErrors?.reference} />
          {state?.fieldErrors?.reference ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.reference[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" rows={3} aria-invalid={!!state?.fieldErrors?.notes} />
          {state?.fieldErrors?.notes ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.notes[0]}
            </p>
          ) : null}
        </div>
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton>Record expense</SubmitButton>
    </form>
  );
}
