import { z } from "zod";
import { SUBSCRIPTION_STATUS_VALUES } from "@/lib/validation/platform-businesses";

/**
 * Client/route-side shaping for /internal/admin/subscriptions' URL query
 * params (?q=&status=&page=). Mirrors platform-businesses.ts's own
 * established convention; public.list_platform_subscriptions remains the
 * actual authority.
 */
export const PlatformSubscriptionQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(SUBSCRIPTION_STATUS_VALUES).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export type PlatformSubscriptionQuery = z.infer<typeof PlatformSubscriptionQuerySchema>;

export function parsePlatformSubscriptionQuery(
  raw: Record<string, string | string[] | undefined>
): PlatformSubscriptionQuery {
  const pick = (key: string) => {
    const value = raw[key];
    return typeof value === "string" ? value : undefined;
  };

  const parsed = PlatformSubscriptionQuerySchema.safeParse({
    q: pick("q"),
    status: pick("status"),
    page: pick("page"),
  });

  if (parsed.success) {
    return parsed.data;
  }

  return PlatformSubscriptionQuerySchema.parse({});
}
