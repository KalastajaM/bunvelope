-- 0005_bypass_password.sql — opt-in DB-stored hash for the shared bypass user.
--
-- When set, /auth/password compares against this column instead of the
-- BYPASS_PASSWORD env var. Operators provision a bootstrap password via the
-- env var; users are forced to rotate it on first login if it falls short of
-- the policy floor (16+ chars). The hash format is "scrypt:N:r:p:saltB64:hashB64",
-- parsed in server/auth.js (verifyBypassPassword).
--
-- Factory reset: clear this column to re-enable env-var compare.
--   update users set bypass_password_hash = null where google_sub='bypass:local';

alter table users add column if not exists bypass_password_hash text;
