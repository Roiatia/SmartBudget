create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.budget_spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.budget_space_members (
  budget_space_id uuid not null references public.budget_spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (budget_space_id, user_id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  budget_space_id uuid not null references public.budget_spaces(id) on delete cascade,
  name text not null,
  color text not null default '#34c98f',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (budget_space_id, name)
);

create table public.monthly_budgets (
  id uuid primary key default gen_random_uuid(),
  budget_space_id uuid not null references public.budget_spaces(id) on delete cascade,
  month date not null,
  income numeric(12,2) not null default 0 check (income >= 0),
  savings_target numeric(12,2) not null default 0 check (savings_target >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (budget_space_id, month)
);

create table public.category_budgets (
  id uuid primary key default gen_random_uuid(),
  budget_space_id uuid not null references public.budget_spaces(id) on delete cascade,
  month date not null,
  category_id uuid not null references public.categories(id) on delete restrict,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (budget_space_id, month, category_id)
);

create table public.fixed_deductions (
  id uuid primary key default gen_random_uuid(),
  budget_space_id uuid not null references public.budget_spaces(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  name text not null,
  amount numeric(12,2) not null check (amount >= 0),
  day_of_month integer not null default 1 check (day_of_month between 1 and 31),
  recurrence_type text not null default 'monthly' check (recurrence_type in ('monthly', 'installments')),
  start_month date not null,
  end_month date,
  installment_count integer check (installment_count is null or installment_count > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  budget_space_id uuid not null references public.budget_spaces(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  name text not null,
  amount numeric(12,2) not null check (amount >= 0),
  expense_date date not null,
  month date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  budget_space_id uuid not null references public.budget_spaces(id) on delete cascade,
  name text not null,
  target_amount numeric(12,2) not null default 0 check (target_amount >= 0),
  current_amount numeric(12,2) not null default 0 check (current_amount >= 0),
  monthly_target numeric(12,2) not null default 0 check (monthly_target >= 0),
  deadline_month date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_budget_space_members_user on public.budget_space_members(user_id);
create index idx_categories_space on public.categories(budget_space_id);
create index idx_monthly_budgets_space_month on public.monthly_budgets(budget_space_id, month);
create index idx_category_budgets_space_month on public.category_budgets(budget_space_id, month);
create index idx_deductions_space on public.fixed_deductions(budget_space_id);
create index idx_expenses_space_month on public.expenses(budget_space_id, month);
create index idx_savings_goals_space on public.savings_goals(budget_space_id);

alter table public.profiles enable row level security;
alter table public.budget_spaces enable row level security;
alter table public.budget_space_members enable row level security;
alter table public.categories enable row level security;
alter table public.monthly_budgets enable row level security;
alter table public.category_budgets enable row level security;
alter table public.fixed_deductions enable row level security;
alter table public.expenses enable row level security;
alter table public.savings_goals enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_insert_own" on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "budget_spaces_select_owner" on public.budget_spaces for select to authenticated
using (owner_id = (select auth.uid()));
create policy "budget_spaces_insert_owner" on public.budget_spaces for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "budget_spaces_update_owner" on public.budget_spaces for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "budget_spaces_delete_owner" on public.budget_spaces for delete to authenticated using (owner_id = (select auth.uid()));

create policy "members_select_own" on public.budget_space_members for select to authenticated using (user_id = (select auth.uid()));
create policy "members_insert_owner_space" on public.budget_space_members for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.budget_spaces b
    where b.id = budget_space_members.budget_space_id
      and b.owner_id = (select auth.uid())
  )
);
create policy "members_delete_self" on public.budget_space_members for delete to authenticated using (user_id = (select auth.uid()));

create policy "categories_all_member" on public.categories for all to authenticated
using (exists (select 1 from public.budget_space_members m where m.budget_space_id = categories.budget_space_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.budget_space_members m where m.budget_space_id = categories.budget_space_id and m.user_id = (select auth.uid())));

create policy "monthly_budgets_all_member" on public.monthly_budgets for all to authenticated
using (exists (select 1 from public.budget_space_members m where m.budget_space_id = monthly_budgets.budget_space_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.budget_space_members m where m.budget_space_id = monthly_budgets.budget_space_id and m.user_id = (select auth.uid())));

create policy "category_budgets_all_member" on public.category_budgets for all to authenticated
using (exists (select 1 from public.budget_space_members m where m.budget_space_id = category_budgets.budget_space_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.budget_space_members m where m.budget_space_id = category_budgets.budget_space_id and m.user_id = (select auth.uid())));

create policy "fixed_deductions_all_member" on public.fixed_deductions for all to authenticated
using (exists (select 1 from public.budget_space_members m where m.budget_space_id = fixed_deductions.budget_space_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.budget_space_members m where m.budget_space_id = fixed_deductions.budget_space_id and m.user_id = (select auth.uid())));

create policy "expenses_all_member" on public.expenses for all to authenticated
using (exists (select 1 from public.budget_space_members m where m.budget_space_id = expenses.budget_space_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.budget_space_members m where m.budget_space_id = expenses.budget_space_id and m.user_id = (select auth.uid())));

create policy "savings_goals_all_member" on public.savings_goals for all to authenticated
using (exists (select 1 from public.budget_space_members m where m.budget_space_id = savings_goals.budget_space_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.budget_space_members m where m.budget_space_id = savings_goals.budget_space_id and m.user_id = (select auth.uid())));

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.budget_spaces,
  public.budget_space_members,
  public.categories,
  public.monthly_budgets,
  public.category_budgets,
  public.fixed_deductions,
  public.expenses,
  public.savings_goals
to authenticated;
