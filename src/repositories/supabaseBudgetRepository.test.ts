import { describe, expect, it } from "vitest";
import { splitRowsByUuidId } from "./supabaseBudgetRepository";

describe("supabase budget repository", () => {
  it("splits mixed local and cloud ids so Supabase never receives null ids", () => {
    const id = "07e01d95-3253-4cd2-903b-57c2f88fa438";
    const rows = splitRowsByUuidId([
      { clientId: id, row: { name: "existing" } },
      { clientId: "cat-food", row: { name: "new" } },
      { clientId: null, row: { name: "missing" } },
    ]);

    expect(rows.withUuidId).toEqual([{ name: "existing", id }]);
    expect(rows.withoutUuidId).toEqual([{ name: "new" }, { name: "missing" }]);
    rows.withoutUuidId.forEach((row) => expect(row).not.toHaveProperty("id"));
  });
});
