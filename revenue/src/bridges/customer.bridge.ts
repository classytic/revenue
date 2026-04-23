export interface CustomerBridge {
  getCustomer?(customerId: string): Promise<{ id: string; name?: string; email?: string; metadata?: Record<string, unknown> } | null>;
}
