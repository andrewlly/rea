import { describe, expect, it } from "vitest";
import { getHeapStatistics } from "node:v8";

import {
  admitManagedProjection,
  ManagedDecodeBudget,
} from "./ManagedDecodeBudget.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

const representationCapacity = 64 * 1024 * 1024;
const budget = () => new ManagedDecodeBudget(representationCapacity);

describe("managed projection admission", () => {
  it("charges decoded strings by their JSON bytes", () => {
    const name = "a".repeat(12 * 1024 * 1024);

    expect(admitManagedProjection({ name }, budget())).toEqual({ name });
  });

  it("charges escaped and multibyte characters at their encoded size", () => {
    expect(() =>
      admitManagedProjection(
        { name: "\u0001".repeat(12 * 1024 * 1024) },
        budget(),
      ),
    ).toThrow(ManagedReaderFailure);
    expect(() =>
      admitManagedProjection({ name: "€".repeat(23 * 1024 * 1024) }, budget()),
    ).toThrow(ManagedReaderFailure);
  });

  it("counts escaped JSON bytes exactly at the budget boundary", () => {
    // Control escapes, quotes, three-byte text, surrogate pairs and lone
    // surrogates each have a distinct JSON size; fill the rest with ASCII.
    const mixed = "\u0001".repeat(4096) + '"\\' + "€😀\ud800\udc00\ud800";
    const used = Buffer.byteLength(JSON.stringify(mixed));
    const filled = (extra: number) =>
      mixed + "a".repeat(64 * 1024 * 1024 - used + extra);

    expect(() => admitManagedProjection(filled(0), budget())).not.toThrow();
    expect(() => admitManagedProjection(filled(1), budget())).toThrow(
      ManagedReaderFailure,
    );
  });
});

describe("managed decoding bounds", () => {
  it("defaults to this process's V8 heap limit and reports its actual capacity", () => {
    const current = new ManagedDecodeBudget();
    expect(current.capacityBytes).toBe(getHeapStatistics().heap_size_limit);
    current.reserve(current.capacityBytes, null);
    expect(() => current.reserve(1, 42)).toThrow(
      `${String(current.capacityBytes)} byte representation budget`,
    );
  });

  it("rejects invalid injected capacities", () => {
    for (const capacity of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() => new ManagedDecodeBudget(capacity)).toThrow(RangeError);
  });

  it("preserves the configured capacity and originating offset in resource failures", () => {
    const current = new ManagedDecodeBudget(17);
    current.reserve(17, null);
    try {
      current.reserve(1, 42);
      throw new Error("Expected capacity failure");
    } catch (cause: unknown) {
      expect(cause).toMatchObject({
        issue: {
          code: "resource-limit",
          scope: "metadata.representation",
          detail: "Managed metadata exceeds the 17 byte representation budget",
          offset: 42,
        },
      });
    }
  });

  it("bounds new row identities without charging lookup replay or merging tables", () => {
    const budget = new ManagedDecodeBudget(representationCapacity);
    budget.reserve(64 * 1024 * 1024 - 512, null);
    budget.reserveRow(2, 1, 100);
    budget.reserveRow(12, 1, 200);

    expect(() => budget.reserveRow(2, 1, 100)).not.toThrow();
    expect(() => budget.reserveRow(2, 2, 300)).toThrow(ManagedReaderFailure);
    // A rejected row has no retained reservation; replay cannot bypass capacity.
    expect(() => budget.reserveRow(2, 2, 300)).toThrow(ManagedReaderFailure);
  });

  it("keeps concurrent decoding bounds within one budget until released", () => {
    const budget = new ManagedDecodeBudget(representationCapacity);
    const bound = 40 * 1024 * 1024;

    budget.admitTransient(bound, null);
    expect(() => budget.admitTransient(bound, null)).toThrow(
      ManagedReaderFailure,
    );
    expect(() => budget.reserve(bound, null)).toThrow(ManagedReaderFailure);
    budget.releaseTransient();
    expect(() => budget.admitTransient(bound, null)).not.toThrow();
  });
});
