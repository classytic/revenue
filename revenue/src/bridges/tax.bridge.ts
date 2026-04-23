import type { RevenueContext } from '../core/context.js';

export interface TaxBridge {
  computeTax?(amount: number, taxClass: string, ctx: RevenueContext): Promise<{ rate: number; amount: number; inclusive: boolean }>;
}
