// Phase 1Q-D — decoded-value acceptance. The scanner only ever forwards a
// digit string that is a check-digit-valid EAN-13 / EAN-8 / UPC-A (phase
// instruction §4); everything else (QR codes, Code 128, misreads) is dropped
// here, so the 1Q-C lookup pipeline is never fed camera noise. The server
// still re-validates — this is a UX/stability filter, not the trust boundary.

export const SUPPORTED_DETECTOR_FORMATS = ["ean_13", "ean_8", "upc_a"] as const;

const EXPECTED_LENGTH: Record<string, number> = { ean_13: 13, ean_8: 8, upc_a: 12 };

export function hasValidGs1CheckDigit(digits: string): boolean {
  if (!/^\d{8,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  let sum = 0;
  // Weights alternate 3,1 starting from the digit adjacent to the check digit.
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - i;
    sum += Number(body[i]) * (fromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

export type AcceptedBarcode =
  | { ok: true; value: string }
  | { ok: false; reason: "UNSUPPORTED_FORMAT" | "INVALID_IDENTIFIER" };

export function acceptDecodedBarcode(rawValue: string, format: string): AcceptedBarcode {
  const expected = EXPECTED_LENGTH[format];
  if (!expected) return { ok: false, reason: "UNSUPPORTED_FORMAT" };
  const value = rawValue.trim();
  if (value.length !== expected || !hasValidGs1CheckDigit(value)) {
    return { ok: false, reason: "INVALID_IDENTIFIER" };
  }
  return { ok: true, value };
}
