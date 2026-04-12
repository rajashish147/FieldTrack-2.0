-- API keys hardening: move to per-key random salt (scrypt) verification.
-- Existing keys were hashed without per-key salt and cannot be re-derived safely.
-- We revoke legacy active keys so operators can rotate them.

alter table public.api_keys
  add column if not exists key_salt text;

update public.api_keys
set active = false,
    revoked_at = coalesce(revoked_at, now())
where key_salt is null
  and active = true;

-- Keep column non-null for all future keys while preserving deterministic behavior.
update public.api_keys
set key_salt = coalesce(key_salt, 'legacy_revoked')
where key_salt is null;

alter table public.api_keys
  alter column key_salt set not null;

create index if not exists idx_api_keys_prefix_active
  on public.api_keys(key_prefix, active)
  where revoked_at is null;
