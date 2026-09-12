-- Checklist template changes must go through the approval queue for anyone who
-- is not a unit/trust administrator. Enforce that in the database, not only in
-- the server functions.
drop policy if exists "Clinical staff can edit checklist templates" on public.checklist_templates;
drop policy if exists "Clinical staff can add checklist templates" on public.checklist_templates;
drop policy if exists "Clinical staff can remove custom checklist templates" on public.checklist_templates;

create policy "Administrators can add checklist templates"
on public.checklist_templates for insert to authenticated
with check (private.is_config_admin(auth.uid()));

create policy "Administrators can edit checklist templates"
on public.checklist_templates for update to authenticated
using (private.is_config_admin(auth.uid()))
with check (private.is_config_admin(auth.uid()));

create policy "Administrators can remove custom checklist templates"
on public.checklist_templates for delete to authenticated
using (private.is_config_admin(auth.uid()) and is_builtin = false);
