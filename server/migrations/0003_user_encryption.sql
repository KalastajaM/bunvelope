-- 0003_user_encryption.sql — opt-in client-side encryption of budget blobs.
--
-- The server never sees the passphrase or derived key. It only stores the
-- salt (for PBKDF2 key derivation on the client) and a verifier blob (a
-- known plaintext encrypted with the derived key, so the client can
-- detect a wrong passphrase before trying to decrypt real data).

alter table users add column if not exists encryption_enabled  boolean not null default false;
alter table users add column if not exists encryption_salt     bytea;
alter table users add column if not exists encryption_verifier jsonb;
