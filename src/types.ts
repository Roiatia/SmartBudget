export type MonthKey = `${number}-${string}`;

export type Category = {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  sortOrder: number;
};

export type Expense = {
  id: string;
  name: string;
  amount: number;
  categoryId: string;
  date: string;
  month: MonthKey;
};

export type FixedDeduction = {
  id: string;
  name: string;
  amount: number;
  day: number;
  categoryId: string;
  active: boolean;
  recurrence: "monthly" | "installments";
  startMonth: MonthKey;
  endMonth?: MonthKey;
  installmentCount?: number;
};

export type SavingsGoal = {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  monthlyTarget: number;
  deadlineMonth?: MonthKey;
  isActive: boolean;
};

export type MonthBudget = {
  income: number;
  savingsTarget: number;
  categoryBudgets: Record<string, number>;
  expenses: Expense[];
};

export type BudgetSnapshot = {
  activeMonth: MonthKey;
  categories: Category[];
  deductions: FixedDeduction[];
  months: Record<MonthKey, MonthBudget>;
  savingsGoals: SavingsGoal[];
  migratedToCloudAt?: string;
};

export type BudgetRepository = {
  mode: "local" | "cloud";
  load(): Promise<BudgetSnapshot>;
  save(snapshot: BudgetSnapshot): Promise<BudgetSnapshot>;
  importSnapshot(snapshot: BudgetSnapshot): Promise<BudgetSnapshot>;
};
