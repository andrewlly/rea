import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Optional accounting capacity; the decoder owns the heap-derived default. */
export const managedDecodeBudgetSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, "must be a positive decimal integer")
  .transform(Number)
  .pipe(z.number().int().safe().min(1));

/** Managed-only workflows validate their setting without loading native configuration. */
export const parseManagedDecodeBudget = (
  value: string | undefined,
): Result<number | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = managedDecodeBudgetSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError("Invalid REA managed decode budget", {
          settings: [
            {
              setting: "REA_MANAGED_DECODE_BUDGET_BYTES",
              constraint: "must be a positive decimal safe integer in bytes",
            },
          ],
        }),
      );
};
