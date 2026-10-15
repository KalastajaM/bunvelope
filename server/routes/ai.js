// server/routes/ai.js — /api/ai/* endpoints. The server is a thin auth'd
// relay: it never reads the user's budget from the database for AI; it
// simply forwards a client-supplied context blob to Anthropic. This keeps
// the relay compatible with E2E-encrypted users (server can't read their
// data anyway).
//
// BYOK: every call (other than /key/*) reads the caller's stored
// Anthropic API key from the users table and forwards it to the SDK.
// 412 no_user_api_key surfaces when the user hasn't configured one yet.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { runInsight, runMessages, runMessagesStream, AiError } from '../ai/client.js';
import { clearCachedForUser } from '../ai/cache.js';
import { FEATURES } from '../ai/prompts.js';
import { VALID_INTENTS } from '../ai/agent-prompts.js';
import { secretsAlg } from '../ai/secrets.js';
import {
  loadUserApiKey, getUserApiKeyStatus, saveUserApiKey,
  deleteUserApiKey, testApiKeyAgainstAnthropic,
} from '../ai/user-keys.js';

const VALID_FEATURES = new Set(Object.keys(FEATURES));
const VALID_LOCALES = new Set(['en', 'fi', 'nl']);
// Cap the free-text `input` forwarded to the model: bounds token burn on the
// caller's own API key and shrinks the prompt-injection surface. Generous
// enough for any real question; the 256 KB body limit is the outer bound.
const MAX_INPUT_LEN = 2000;

function fail(res, err) {
  if (err instanceof AiError) {
    const body = { error: err.code };
    if (err.message && err.message !== err.code) body.message = err.message;
    if (err.extra) Object.assign(body, err.extra);
    return res.status(err.status).json(body);
  }
  return res.status(500).json({ error: 'ai_internal' });
}

function clientModelOverride(body) {
  // Server will clamp to one of the allowed models in client.js; we just
  // accept the string here.
  return typeof body?.model === 'string' ? body.model : null;
}

export function aiRoutes() {
  const r = Router();

  r.use(requireAuth);

  // Cross-cut limiter: 60 calls / user / minute across all AI endpoints.
  // Per-feature soft caps are enforced inside server/ai/cache.js.
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `ai:${req.user?.id || req.ip}`,
  });
  r.use(limiter);

  r.post('/insights', async (req, res) => {
    try {
      const feature = String(req.body?.feature || '');
      if (!VALID_FEATURES.has(feature)) {
        return res.status(400).json({ error: 'bad_feature' });
      }
      const locale = VALID_LOCALES.has(req.body?.locale) ? req.body.locale : 'en';
      const context = req.body?.context;
      if (!context || typeof context !== 'object') {
        return res.status(400).json({ error: 'bad_context' });
      }
      let input = typeof req.body?.input === 'string' ? req.body.input : undefined;
      if (input && input.length > MAX_INPUT_LEN) input = input.slice(0, MAX_INPUT_LEN);
      const noCache = !!req.body?.noCache;
      const apiKey = await loadUserApiKey(req.user.id);
      if (!apiKey) {
        return res.status(412).json({ error: 'no_user_api_key' });
      }
      const out = await runInsight({
        feature,
        context,
        locale,
        input,
        noCache,
        userId: req.user.id,
        modelOverride: clientModelOverride(req.body),
        apiKey,
        logger: req.log,
      });
      res.json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  // Raw Messages relay for the agent surfaces (import categorization, document
  // parse, prompt dialog, and the transactions filter). The browser owns the
  // agent loop because it is the only place the budget is decrypted; this
  // endpoint attaches the caller's key, injects the intent's system prompt,
  // and enforces its tool allowlist.
  r.post('/messages', async (req, res) => {
    try {
      const intent = String(req.body?.intent || '');
      if (!VALID_INTENTS.has(intent)) {
        return res.status(400).json({ error: 'bad_intent' });
      }
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'bad_messages' });
      }
      const apiKey = await loadUserApiKey(req.user.id);
      if (!apiKey) {
        return res.status(412).json({ error: 'no_user_api_key' });
      }
      const call = {
        intent,
        messages,
        tools: Array.isArray(req.body?.tools) ? req.body.tools : undefined,
        modelOverride: clientModelOverride(req.body),
        maxTokens: req.body?.max_tokens,
        apiKey,
        userId: req.user.id,
        logger: req.log,
      };

      if (req.body?.stream === true) {
        await runMessagesStream({ ...call, res });
        return;
      }
      res.json(await runMessages(call));
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete('/cache', (req, res) => {
    const cleared = clearCachedForUser(req.user.id);
    res.json({ ok: true, cleared });
  });

  // ── BYOK: per-user API key management ─────────────────────────────────
  // GET returns non-secret status only; PUT stores; DELETE clears; the
  // /key/test endpoint validates a candidate key against Anthropic
  // before save. The plaintext key is never returned by any endpoint.

  r.get('/key', async (req, res) => {
    try {
      const status = await getUserApiKeyStatus(req.user.id);
      res.json({ ...status, serverEncryption: secretsAlg() });
    } catch (err) {
      fail(res, err);
    }
  });

  r.put('/key', async (req, res) => {
    try {
      const key = req.body?.apiKey;
      if (typeof key !== 'string' || !key.trim()) {
        return res.status(400).json({ error: 'bad_api_key' });
      }
      const status = await saveUserApiKey(req.user.id, key);
      // Saving a new key invalidates any cached responses generated under
      // the old key (different rate-limit accounting on Anthropic's side
      // anyway, and keeps the UI consistent).
      clearCachedForUser(req.user.id);
      res.json({ ...status, serverEncryption: secretsAlg() });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete('/key', async (req, res) => {
    try {
      await deleteUserApiKey(req.user.id);
      clearCachedForUser(req.user.id);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post('/key/test', async (req, res) => {
    try {
      const key = req.body?.apiKey;
      if (typeof key !== 'string' || !key.trim()) {
        return res.status(400).json({ error: 'bad_api_key' });
      }
      const result = await testApiKeyAgainstAnthropic(key);
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  return r;
}
