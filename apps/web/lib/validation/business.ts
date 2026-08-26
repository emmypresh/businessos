import { z } from "zod";

export const CreateBusinessSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: "Business name must be at least 2 characters." })
    .max(150, { error: "Business name must be 150 characters or fewer." }),
  slug: z
    .string()
    .trim()
    // No .toLowerCase() here: it would silently normalize an uppercase slug
    // into a valid one before the regex below ever runs, defeating the
    // "reject uppercase" rule. The RPC's own private.normalize_slug (see
    // Existing Contract) still normalizes server-side regardless — this
    // schema's job is strict client-side feedback on what the user typed,
    // not silent coercion.
    .min(1, { error: "Slug is required." })
    .max(63, { error: "Slug must be 63 characters or fewer." })
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
      error:
        "Slug can only contain lowercase letters, numbers, and single hyphens between them.",
    }),
});

export type CreateBusinessInput = z.infer<typeof CreateBusinessSchema>;
