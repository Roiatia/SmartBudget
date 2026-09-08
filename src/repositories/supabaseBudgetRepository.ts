import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  createEmptyMonth,
  defaultCategories,
  monthToDate,
  normalizeSnapshot,
  dateToMonth,
} from "../budgetMath";
import type { BudgetRepository, BudgetSnapshot, Category, Expense, FixedDeduction, MonthBudget, MonthKey, SavingsGoal } from "../types";

type Row = Record<string, unknown>;

export class SupabaseBudgetRepository implements BudgetRepository {
  mode = "cloud" as const;
  private budgetSpaceId?: string;

  constructor(
    private readonly client: SupabaseClient,
    private readonly user: User,
  ) {}

  async load(): Promise<BudgetSnapshot> {
    const budgetSpaceId = await this.ensureBudgetSpace();
    const [categories, monthlyBudgets, categoryBudgets, deductions, expenses, savingsGoals] = await Promise.all([
      this.select("categories", budgetSpaceId),
      this.select("monthly_budgets", budgetSpaceId),
      this.select("category_budgets", budgetSpaceId),
      this.select("fixed_deductions", budgetSpaceId),
      this.select("expenses", budgetSpaceId),
      this.select("savings_goals", budgetSpaceId),
    ]);

    const months: BudgetSnapshot["months"] = {};
    (monthlyBudgets as Row[]).forEach((row) => {
      const month = dateToMonth(String(row.month));
      months[month] = {
        income: Number(row.income || 0),
        savingsTarget: Number(row.savings_target || 0),
        categoryBudgets: {},
        expenses: [],
      };
    });

    (categoryBudgets as Row[]).forEach((row) => {
      const month = dateToMonth(String(row.month));
      months[month] = months[month] || createEmptyMonth();
      months[month].categoryBudgets[String(row.category_id)] = Number(row.amount || 0);
    });

    (expenses as Row[]).forEach((row) => {
      const month = dateToMonth(String(row.month));
      months[month] = months[month] || createEmptyMonth();
      months[month].expenses.push({
        id: String(row.id),
        name: String(row.name),
        amount: Number(row.amount || 0),
        categoryId: String(row.category_id),
        date: String(row.expense_date),
        month,
      });
    });

    return normalizeSnapshot({
      activeMonth: dateToMonth(String(new Date().toISOString().slice(0, 10))),
      categories: (categories as Row[]).map(toCategory),
      deductions: (deductions as Row[]).map(toDeduction),
      months,
      savingsGoals: (savingsGoals as Row[]).map(toSavingsGoal),
    });
  }

  async save(snapshot: BudgetSnapshot): Promise<BudgetSnapshot> {
    const normalized = normalizeSnapshot(snapshot);
    const budgetSpaceId = await this.ensureBudgetSpace();

    const categoryIdMap = await this.upsertCategories(budgetSpaceId, normalized.categories);
    await this.replaceMonthlyData(budgetSpaceId, normalized, categoryIdMap);
    await this.replaceDeductions(budgetSpaceId, normalized.deductions, categoryIdMap);
    await this.replaceSavingsGoals(budgetSpaceId, normalized.savingsGoals);

    return this.load();
  }

  async importSnapshot(snapshot: BudgetSnapshot): Promise<BudgetSnapshot> {
    return this.save({ ...normalizeSnapshot(snapshot), migratedToCloudAt: new Date().toISOString() });
  }

  private async ensureBudgetSpace(): Promise<string> {
    if (this.budgetSpaceId) return this.budgetSpaceId;

    await this.client.from("profiles").upsert({
      id: this.user.id,
      display_name: this.user.user_metadata?.full_name || this.user.email || "SmartBudget",
    });

    const membership = await this.client
      .from("budget_space_members")
      .select("budget_space_id")
      .eq("user_id", this.user.id)
      .limit(1)
      .maybeSingle();
    if (membership.error) throw membership.error;
    if (membership.data?.budget_space_id) {
      this.budgetSpaceId = String(membership.data.budget_space_id);
      return this.budgetSpaceId;
    }

    const ownedSpace = await this.client
      .from("budget_spaces")
      .select("id")
      .eq("owner_id", this.user.id)
      .limit(1)
      .maybeSingle();
    if (ownedSpace.error) throw ownedSpace.error;
    if (ownedSpace.data?.id) {
      const budgetSpaceId = String(ownedSpace.data.id);
      await this.ensureMembership(budgetSpaceId);
      this.budgetSpaceId = budgetSpaceId;
      return budgetSpaceId;
    }

    const space = await this.client
      .from("budget_spaces")
      .insert({ name: "התקציב שלי", owner_id: this.user.id })
      .select("id")
      .single();
    if (space.error) throw space.error;

    const budgetSpaceId = String(space.data.id);
    await this.ensureMembership(budgetSpaceId);

    this.budgetSpaceId = budgetSpaceId;
    return budgetSpaceId;
  }

  private async ensureMembership(budgetSpaceId: string): Promise<void> {
    const member = await this.client.from("budget_space_members").insert({
      budget_space_id: budgetSpaceId,
      user_id: this.user.id,
      role: "owner",
    });
    if (member.error) throw member.error;
  }

  private async select(table: string, budgetSpaceId: string): Promise<unknown[]> {
    const result = await this.client.from(table).select("*").eq("budget_space_id", budgetSpaceId);
    if (result.error) throw result.error;
    return result.data || [];
  }

  private async upsertCategories(budgetSpaceId: string, categories: Category[]): Promise<Map<string, string>> {
    const result = await this.client
      .from("categories")
      .upsert(
        categories.map((category) => ({
          budget_space_id: budgetSpaceId,
          name: category.name,
          color: category.color,
          is_active: category.isActive,
          sort_order: category.sortOrder,
          ...withUuidId(category.id),
        })),
        { onConflict: "budget_space_id,name" },
      )
      .select("id,name");
    if (result.error) throw result.error;

    const map = new Map<string, string>();
    categories.forEach((category) => {
      const saved = result.data?.find((row) => row.name === category.name);
      if (saved?.id) map.set(category.id, String(saved.id));
    });
    return map;
  }

  private async replaceMonthlyData(budgetSpaceId: string, snapshot: BudgetSnapshot, categoryIdMap: Map<string, string>): Promise<void> {
    await this.deleteBySpace("expenses", budgetSpaceId);
    await this.deleteBySpace("category_budgets", budgetSpaceId);
    await this.deleteBySpace("monthly_budgets", budgetSpaceId);

    const monthlyRows = Object.entries(snapshot.months).map(([month, budget]) => ({
      budget_space_id: budgetSpaceId,
      month: monthToDate(month as MonthKey),
      income: budget.income,
      savings_target: budget.savingsTarget,
    }));
    if (monthlyRows.length) await this.insert("monthly_budgets", monthlyRows);

    const categoryBudgetRows = Object.entries(snapshot.months).flatMap(([month, budget]) =>
      Object.entries(budget.categoryBudgets).map(([categoryId, amount]) => ({
        budget_space_id: budgetSpaceId,
        month: monthToDate(month as MonthKey),
        category_id: categoryIdMap.get(categoryId) || categoryId,
        amount,
      })),
    );
    if (categoryBudgetRows.length) await this.insert("category_budgets", categoryBudgetRows);

    const expenseRows = Object.values(snapshot.months).flatMap((budget: MonthBudget) =>
      budget.expenses.map((expense: Expense) => ({
        budget_space_id: budgetSpaceId,
        name: expense.name,
        amount: expense.amount,
        category_id: categoryIdMap.get(expense.categoryId) || expense.categoryId,
        expense_date: expense.date.slice(0, 10),
        month: monthToDate(expense.month),
        ...withUuidId(expense.id),
      })),
    );
    if (expenseRows.length) await this.insert("expenses", expenseRows);
  }

  private async replaceDeductions(budgetSpaceId: string, deductions: FixedDeduction[], categoryIdMap: Map<string, string>): Promise<void> {
    await this.deleteBySpace("fixed_deductions", budgetSpaceId);
    if (!deductions.length) return;

    await this.insert(
      "fixed_deductions",
      deductions.map((deduction) => ({
        budget_space_id: budgetSpaceId,
        name: deduction.name,
        amount: deduction.amount,
        day_of_month: deduction.day,
        category_id: categoryIdMap.get(deduction.categoryId) || deduction.categoryId,
        is_active: deduction.active,
        recurrence_type: deduction.recurrence,
        start_month: monthToDate(deduction.startMonth),
        end_month: deduction.endMonth ? monthToDate(deduction.endMonth) : null,
        installment_count: deduction.installmentCount || null,
        ...withUuidId(deduction.id),
      })),
    );
  }

  private async replaceSavingsGoals(budgetSpaceId: string, goals: SavingsGoal[]): Promise<void> {
    await this.deleteBySpace("savings_goals", budgetSpaceId);
    if (!goals.length) return;

    await this.insert(
      "savings_goals",
      goals.map((goal) => ({
        budget_space_id: budgetSpaceId,
        name: goal.name,
        target_amount: goal.targetAmount,
        current_amount: goal.currentAmount,
        monthly_target: goal.monthlyTarget,
        deadline_month: goal.deadlineMonth ? monthToDate(goal.deadlineMonth) : null,
        is_active: goal.isActive,
        ...withUuidId(goal.id),
      })),
    );
  }

  private async insert(table: string, rows: unknown[]): Promise<void> {
    const result = await this.client.from(table).insert(rows);
    if (result.error) throw result.error;
  }

  private async deleteBySpace(table: string, budgetSpaceId: string): Promise<void> {
    const result = await this.client.from(table).delete().eq("budget_space_id", budgetSpaceId);
    if (result.error) throw result.error;
  }
}

function toCategory(row: Row): Category {
  return {
    id: String(row.id),
    name: String(row.name),
    color: String(row.color || defaultCategories[0].color),
    isActive: row.is_active !== false,
    sortOrder: Number(row.sort_order || 0),
  };
}

function toDeduction(row: Row): FixedDeduction {
  return {
    id: String(row.id),
    name: String(row.name),
    amount: Number(row.amount || 0),
    day: Number(row.day_of_month || 1),
    categoryId: String(row.category_id),
    active: row.is_active !== false,
    recurrence: row.recurrence_type === "installments" ? "installments" : "monthly",
    startMonth: dateToMonth(String(row.start_month)),
    endMonth: row.end_month ? dateToMonth(String(row.end_month)) : undefined,
    installmentCount: row.installment_count ? Number(row.installment_count) : undefined,
  };
}

function toSavingsGoal(row: Row): SavingsGoal {
  return {
    id: String(row.id),
    name: String(row.name),
    targetAmount: Number(row.target_amount || 0),
    currentAmount: Number(row.current_amount || 0),
    monthlyTarget: Number(row.monthly_target || 0),
    deadlineMonth: row.deadline_month ? dateToMonth(String(row.deadline_month)) : undefined,
    isActive: row.is_active !== false,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function withUuidId(value: string): { id: string } | Record<string, never> {
  return isUuid(value) ? { id: value } : {};
}
