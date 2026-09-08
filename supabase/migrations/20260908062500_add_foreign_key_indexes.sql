create index idx_budget_spaces_owner on public.budget_spaces(owner_id);
create index idx_category_budgets_category on public.category_budgets(category_id);
create index idx_expenses_category on public.expenses(category_id);
create index idx_fixed_deductions_category on public.fixed_deductions(category_id);
