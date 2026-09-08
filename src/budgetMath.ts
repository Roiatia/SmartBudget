import type { BudgetSnapshot, Category, FixedDeduction, MonthBudget, MonthKey } from "./types";

export const storageKeyV1 = "smartbudget:v1";
export const storageKeyV2 = "smartbudget:v2";

export const defaultCategories: Category[] = [
  { id: "cat-housing", name: "דיור", color: "#34c98f", isActive: true, sortOrder: 10 },
  { id: "cat-bills", name: "חשבונות", color: "#4ea7f5", isActive: true, sortOrder: 20 },
  { id: "cat-food", name: "מזון", color: "#f5b84e", isActive: true, sortOrder: 30 },
  { id: "cat-transport", name: "תחבורה", color: "#8f7df2", isActive: true, sortOrder: 40 },
  { id: "cat-health", name: "בריאות", color: "#e36b60", isActive: true, sortOrder: 50 },
  { id: "cat-fun", name: "בילויים", color: "#d56db3", isActive: true, sortOrder: 60 },
  { id: "cat-savings", name: "חיסכון", color: "#2c7d6c", isActive: true, sortOrder: 70 },
  { id: "cat-other", name: "אחר", color: "#7b8191", isActive: true, sortOrder: 80 },
];

export const shekel = new Intl.NumberFormat("he-IL", {
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 0,
});

export function createEmptySnapshot(activeMonth = getCurrentMonth()): BudgetSnapshot {
  return {
    activeMonth,
    categories: defaultCategories,
    deductions: [],
    months: { [activeMonth]: createEmptyMonth() },
    savingsGoals: [],
  };
}

export function createEmptyMonth(): MonthBudget {
  return { income: 0, savingsTarget: 0, categoryBudgets: {}, expenses: [] };
}

export function ensureMonth(snapshot: BudgetSnapshot, month: MonthKey): BudgetSnapshot {
  if (snapshot.months[month]) return snapshot;
  return {
    ...snapshot,
    months: {
      ...snapshot.months,
      [month]: createEmptyMonth(),
    },
  };
}

export function sum(items: { amount: number }[]): number {
  return items.reduce((total, item) => total + Number(item.amount || 0), 0);
}

export function money(value: number): string {
  return shekel.format(Math.round(Number(value || 0)));
}

export function getCurrentMonth(): MonthKey {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}` as MonthKey;
}

export function getRecentMonthKeys(activeMonth: MonthKey, count: number): MonthKey[] {
  return Array.from({ length: count }, (_, index) => addMonths(activeMonth, index - count + 1));
}

export function addMonths(monthKey: MonthKey, offset: number): MonthKey {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` as MonthKey;
}

export function diffMonths(from: MonthKey, to: MonthKey): number {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

export function formatMonthName(monthKey: MonthKey): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("he-IL", { month: "short", year: "2-digit" }).format(new Date(year, month - 1, 1));
}

export function getSpendRatio(value: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

export function getCategoryName(categories: Category[], categoryId: string): string {
  return categories.find((category) => category.id === categoryId)?.name || "אחר";
}

export function getActiveDeductionsForMonth(deductions: FixedDeduction[], month: MonthKey): FixedDeduction[] {
  return deductions.filter((deduction) => isDeductionActiveForMonth(deduction, month));
}

export function isDeductionActiveForMonth(deduction: FixedDeduction, month: MonthKey): boolean {
  if (!deduction.active || diffMonths(deduction.startMonth, month) < 0) return false;
  if (deduction.endMonth && diffMonths(month, deduction.endMonth) < 0) return false;
  if (deduction.recurrence === "installments" && deduction.installmentCount) {
    return diffMonths(deduction.startMonth, month) < deduction.installmentCount;
  }
  return true;
}

export function monthToDate(month: MonthKey): string {
  return `${month}-01`;
}

export function dateToMonth(date: string): MonthKey {
  return date.slice(0, 7) as MonthKey;
}

export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeSnapshot(value: unknown): BudgetSnapshot {
  const fallback = createEmptySnapshot();
  if (!value || typeof value !== "object") return fallback;

  const maybe = value as Partial<BudgetSnapshot> & {
    deductions?: unknown[];
    months?: Record<string, unknown>;
  };
  const activeMonth = typeof maybe.activeMonth === "string" ? (maybe.activeMonth as MonthKey) : getCurrentMonth();
  const categories = mergeCategories(Array.isArray(maybe.categories) ? (maybe.categories as Category[]) : defaultCategories);
  const categoryByName = new Map(categories.map((category) => [category.name, category.id]));

  const months: BudgetSnapshot["months"] = {};
  Object.entries(maybe.months || {}).forEach(([monthKey, rawMonth]) => {
    const raw = rawMonth as Partial<MonthBudget> & { expenses?: Array<Record<string, unknown>> };
    months[monthKey as MonthKey] = {
      income: Number(raw.income || 0),
      savingsTarget: Number(raw.savingsTarget || 0),
      categoryBudgets: raw.categoryBudgets || {},
      expenses: Array.isArray(raw.expenses)
        ? (raw.expenses as Array<Record<string, unknown>>).map((expense) => ({
            id: String(expense.id || createId()),
            name: String(expense.name || ""),
            amount: Number(expense.amount || 0),
            categoryId: categoryByName.get(String(expense.category || "")) || String(expense.categoryId || "cat-other"),
            date: String(expense.date || expense.createdAt || `${monthKey}-01`),
            month: (String(expense.month || monthKey).slice(0, 7) || activeMonth) as MonthKey,
          }))
        : [],
    };
  });

  const deductions = Array.isArray(maybe.deductions)
    ? (maybe.deductions as Array<Record<string, unknown>>).map((deduction) => ({
        id: String(deduction.id || createId()),
        name: String(deduction.name || ""),
        amount: Number(deduction.amount || 0),
        day: Math.min(31, Math.max(1, Number(deduction.day || 1))),
        categoryId: categoryByName.get(String(deduction.category || "")) || String(deduction.categoryId || "cat-other"),
        active: deduction.active !== false,
        recurrence: (deduction.recurrence === "installments" ? "installments" : "monthly") as FixedDeduction["recurrence"],
        startMonth: String(deduction.startMonth || activeMonth).slice(0, 7) as MonthKey,
        endMonth: deduction.endMonth ? (String(deduction.endMonth).slice(0, 7) as MonthKey) : undefined,
        installmentCount: deduction.installmentCount ? Number(deduction.installmentCount) : undefined,
      }))
    : [];

  const snapshot: BudgetSnapshot = {
    activeMonth,
    categories,
    deductions,
    months: Object.keys(months).length ? months : { [activeMonth]: createEmptyMonth() },
    savingsGoals: Array.isArray(maybe.savingsGoals) ? maybe.savingsGoals : [],
    migratedToCloudAt: maybe.migratedToCloudAt,
  };

  return ensureMonth(snapshot, activeMonth);
}

function mergeCategories(categories: Category[]): Category[] {
  const byName = new Map<string, Category>();
  defaultCategories.forEach((category) => byName.set(category.name, category));
  categories.forEach((category, index) => {
    if (!category?.name) return;
    byName.set(category.name, {
      id: category.id || createId(),
      name: category.name,
      color: category.color || defaultCategories[index % defaultCategories.length].color,
      isActive: category.isActive !== false,
      sortOrder: Number(category.sortOrder ?? index * 10),
    });
  });
  return [...byName.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}
