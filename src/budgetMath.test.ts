import { describe, expect, it } from "vitest";
import { addMonths, getActiveDeductionsForMonth, normalizeSnapshot } from "./budgetMath";
import type { FixedDeduction } from "./types";

describe("budget math", () => {
  it("adds months across year boundaries", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
  });

  it("activates installment deductions only for their payment window", () => {
    const deduction: FixedDeduction = {
      id: "installment",
      name: "תשלום",
      amount: 100,
      day: 31,
      categoryId: "cat-other",
      active: true,
      recurrence: "installments",
      startMonth: "2026-09",
      installmentCount: 3,
    };

    expect(getActiveDeductionsForMonth([deduction], "2026-08")).toHaveLength(0);
    expect(getActiveDeductionsForMonth([deduction], "2026-09")).toHaveLength(1);
    expect(getActiveDeductionsForMonth([deduction], "2026-11")).toHaveLength(1);
    expect(getActiveDeductionsForMonth([deduction], "2026-12")).toHaveLength(0);
  });

  it("migrates the old localStorage shape into categories and month data", () => {
    const snapshot = normalizeSnapshot({
      activeMonth: "2026-09",
      deductions: [{ id: "rent", name: "שכר דירה", amount: 4200, day: 1, category: "דיור", active: true }],
      months: {
        "2026-09": {
          income: 12000,
          expenses: [{ id: "grocery", name: "סופר", amount: 340, category: "מזון", createdAt: "2026-09-08T08:00:00.000Z" }],
        },
      },
    });

    expect(snapshot.months["2026-09"].income).toBe(12000);
    expect(snapshot.deductions[0].categoryId).toBe("cat-housing");
    expect(snapshot.months["2026-09"].expenses[0].categoryId).toBe("cat-food");
  });
});
