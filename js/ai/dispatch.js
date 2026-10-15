// js/ai/dispatch.js — selects the right context-builder for a feature so
// js/ai/client.js can stay one-line.

import { state, now } from '../app.js';
import {
  buildMonthlyBriefingCtx,
  buildAnomalyCtx,
  buildEnvelopeHealthCtx,
  buildSubscriptionCtx,
  buildWhatifCtx,
  buildOnboardingCtx,
  buildSearchCtx,
  buildPortfolioInsightCtx,
} from './context-builder.js';

export function buildContextFor(feature) {
  switch (feature) {
    case 'monthly_briefing':       return buildMonthlyBriefingCtx(state, undefined, now);
    case 'anomaly':                return buildAnomalyCtx(state, undefined, now);
    case 'envelope_health':        return buildEnvelopeHealthCtx(state, undefined, now);
    case 'subscription_detection': return buildSubscriptionCtx(state, now);
    case 'whatif':                 return buildWhatifCtx(state, undefined, now);
    case 'onboarding':             return buildOnboardingCtx(state, undefined, now);
    case 'search':                 return buildSearchCtx(state, now);
    case 'portfolio_insight':      return buildPortfolioInsightCtx(state, now);
    case 'reconcile':
      throw new Error('reconcile context requires an accountId — pass it via contextOverride');
    default:
      throw new Error(`unknown AI feature: ${feature}`);
  }
}
