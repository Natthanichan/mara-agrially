import { runDeal } from '../app/service.js';
import { ctx } from './runtime.js';

/** เรียกแบบ async จาก API: { dealId } */
export const handler = async (e: { dealId?: string }) => {
  if (!e?.dealId) throw new Error('ต้องมี dealId');
  await runDeal(ctx, e.dealId);
  return { ok: true };
};
