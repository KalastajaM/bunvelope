-- 0008_user_prefs.sql — per-user display preferences.
--
-- Language, navigation layout, density, accent, the Balance View and its
-- horizon, whether the tour has been seen, and per-page view choices used to
-- live only in each browser's localStorage, so a new device reset them and a
-- returning user got the first-run tour. They now follow the user: the
-- client reads them after sign-in and PATCHes each change
-- (server/routes/budgets.js, /api/user/prefs). localStorage stays as the
-- cache, and as the only store in local and guest mode.
--
-- Additive: an empty object means "nothing stored yet", and the client then
-- seeds it from the browser it is running in.

alter table users add column if not exists prefs jsonb not null default '{}'::jsonb;
