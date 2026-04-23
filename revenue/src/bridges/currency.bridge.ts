export interface CurrencyBridge {
  convert?(amount: number, from: string, to: string, date?: Date): Promise<{ amount: number; rate: number }>;
}
