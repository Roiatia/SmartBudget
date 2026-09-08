import { describe, expect, it } from "vitest";
import { withUuidId } from "./supabaseBudgetRepository";

describe("supabase budget repository", () => {
  it("omits local ids so Supabase can generate uuid primary keys", () => {
    expect(withUuidId("cat-food")).not.toHaveProperty("id");
    expect(withUuidId("m2ish5-test")).not.toHaveProperty("id");
  });

  it("keeps existing uuid ids for rows already loaded from Supabase", () => {
    const id = "07e01d95-3253-4cd2-903b-57c2f88fa438";
    expect(withUuidId(id)).toEqual({ id });
  });
});
