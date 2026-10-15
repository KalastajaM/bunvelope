-- 0007_user_ai_keys.sql — per-user Anthropic API key (BYOK).
--
-- Stores each user's own Anthropic API key so the server forwards AI
-- requests using that key instead of a shared one. The key is encrypted
-- at rest with AES-256-GCM when BUNVELOPE_SECRETS_KEY is configured;
-- falls back to plaintext storage otherwise (the UI surfaces a warning
-- in that case so users can decide).
--
-- Columns:
--   ai_api_key_alg     — 'aes-256-gcm' or 'plaintext'. NULL = no key set.
--   ai_api_key_iv      — 12-byte AES-GCM nonce (NULL when plaintext).
--   ai_api_key_tag     — 16-byte AES-GCM auth tag (NULL when plaintext).
--   ai_api_key_ct      — ciphertext (or plaintext bytes) of the key.
--   ai_api_key_preview — last 4 chars of the key, shown in UI to confirm
--                        which key is active (e.g. "…AB12").
--   ai_api_key_set_at  — when the key was last saved.

alter table users add column if not exists ai_api_key_alg     text;
alter table users add column if not exists ai_api_key_iv      bytea;
alter table users add column if not exists ai_api_key_tag     bytea;
alter table users add column if not exists ai_api_key_ct      bytea;
alter table users add column if not exists ai_api_key_preview text;
alter table users add column if not exists ai_api_key_set_at  timestamptz;
