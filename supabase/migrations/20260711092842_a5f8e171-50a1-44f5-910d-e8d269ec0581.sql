create table if not exists public.webauthn_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device_label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists webauthn_credentials_user_id_idx
  on public.webauthn_credentials (user_id);

grant select, insert, update, delete on public.webauthn_credentials to authenticated;
grant all on public.webauthn_credentials to service_role;

alter table public.webauthn_credentials enable row level security;

create policy "Users manage their own passkeys - select"
  on public.webauthn_credentials for select to authenticated
  using (auth.uid() = user_id);

create policy "Users manage their own passkeys - insert"
  on public.webauthn_credentials for insert to authenticated
  with check (auth.uid() = user_id);

create policy "Users manage their own passkeys - update"
  on public.webauthn_credentials for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users manage their own passkeys - delete"
  on public.webauthn_credentials for delete to authenticated
  using (auth.uid() = user_id);

create table if not exists public.webauthn_challenges (
  user_id uuid primary key references auth.users(id) on delete cascade,
  challenge text not null,
  purpose text not null,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.webauthn_challenges to authenticated;
grant all on public.webauthn_challenges to service_role;

alter table public.webauthn_challenges enable row level security;

create policy "Users manage their own challenges - all"
  on public.webauthn_challenges for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);