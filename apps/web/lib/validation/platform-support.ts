import { z } from "zod";

/**
 * Client/route-side shaping for /internal/admin/support's URL query params
 * (?severity=&q=&page=). public.list_platform_business_diagnostics remains
 * the actual authority.
 */
export const PlatformDiagnosticSeveritySchema = z.enum(["WARNING", "INFO"]);

export const PlatformSupportQuerySchema = z.object({
  severity: PlatformDiagnosticSeveritySchema.optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export type PlatformSupportQuery = z.infer<typeof PlatformSupportQuerySchema>;

export function parsePlatformSupportQuery(
  raw: Record<string, string | string[] | undefined>
): PlatformSupportQuery {
  const pick = (key: string) => {
    const value = raw[key];
    return typeof value === "string" ? value : undefined;
  };

  const parsed = PlatformSupportQuerySchema.safeParse({
    severity: pick("severity"),
    q: pick("q"),
    page: pick("page"),
  });

  if (parsed.success) {
    return parsed.data;
  }

  return PlatformSupportQuerySchema.parse({});
}
