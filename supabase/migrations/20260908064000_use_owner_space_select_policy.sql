drop policy if exists "budget_spaces_select_member" on public.budget_spaces;

create policy "budget_spaces_select_owner" on public.budget_spaces for select to authenticated
using (owner_id = (select auth.uid()));
