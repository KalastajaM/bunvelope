// Authenticated HTTP transport; desktop uses the same bounded price service.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { lookupPrice } from '../price-service.js';
export * from '../price-service.js';

export function pricesRoutes() {
  const r = Router();
  r.use(requireAuth);
  r.use(rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true,
    legacyHeaders: false, keyGenerator: req => `price:${req.user?.id || req.ip}` }));
  for (const [path, kind] of [['/', 'url'], ['/quote', 'quote']]) {
    r.post(path, async (req, res) => {
      const result = await lookupPrice(kind, req.body);
      res.status(result.status).json(result.body);
    });
  }
  return r;
}
