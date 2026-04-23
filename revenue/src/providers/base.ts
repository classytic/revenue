export interface CreateIntentParams {
  amount: number;
  currency: string;
  metadata?: Record<string, unknown>;
  customerId?: string;
  returnUrl?: string;
  [key: string]: unknown;
}

export interface PaymentIntentData {
  id: string;
  sessionId?: string | null;
  paymentIntentId?: string | null;
  provider: string;
  status: string;
  amount: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  clientSecret?: string;
  paymentUrl?: string;
  instructions?: string;
  raw?: unknown;
}

export interface PaymentResultData {
  id: string;
  provider: string;
  status: 'succeeded' | 'failed' | 'processing' | 'requires_action';
  amount?: number;
  currency?: string;
  paidAt?: Date;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface RefundResultData {
  id: string;
  provider: string;
  status: 'succeeded' | 'failed' | 'processing';
  amount?: number;
  currency?: string;
  refundedAt?: Date;
  reason?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface WebhookEventData {
  id: string;
  provider: string;
  type: string;
  data: { sessionId?: string; paymentIntentId?: string; [key: string]: unknown };
  createdAt?: Date;
  raw?: unknown;
}

export interface ProviderCapabilities {
  supportsWebhooks: boolean;
  supportsRefunds: boolean;
  supportsPartialRefunds: boolean;
  requiresManualVerification: boolean;
}

export class PaymentIntent implements PaymentIntentData {
  public readonly id: string;
  public readonly sessionId: string | null;
  public readonly paymentIntentId: string | null;
  public readonly provider: string;
  public readonly status: string;
  public readonly amount: number;
  public readonly currency?: string;
  public readonly metadata: Record<string, unknown>;
  public readonly clientSecret?: string;
  public readonly paymentUrl?: string;
  public readonly instructions?: string;
  public readonly raw?: unknown;

  constructor(data: PaymentIntentData) {
    this.id = data.id;
    this.sessionId = data.sessionId ?? null;
    this.paymentIntentId = data.paymentIntentId ?? null;
    this.provider = data.provider;
    this.status = data.status;
    this.amount = data.amount;
    this.currency = data.currency;
    this.metadata = data.metadata ?? {};
    this.clientSecret = data.clientSecret;
    this.paymentUrl = data.paymentUrl;
    this.instructions = data.instructions;
    this.raw = data.raw;
  }
}

export class PaymentResult implements PaymentResultData {
  public readonly id: string;
  public readonly provider: string;
  public readonly status: 'succeeded' | 'failed' | 'processing' | 'requires_action';
  public readonly amount?: number;
  public readonly currency?: string;
  public readonly paidAt?: Date;
  public readonly metadata: Record<string, unknown>;
  public readonly raw?: unknown;

  constructor(data: PaymentResultData) {
    this.id = data.id;
    this.provider = data.provider;
    this.status = data.status;
    this.amount = data.amount;
    this.currency = data.currency;
    this.paidAt = data.paidAt;
    this.metadata = data.metadata ?? {};
    this.raw = data.raw;
  }
}

export class RefundResult implements RefundResultData {
  public readonly id: string;
  public readonly provider: string;
  public readonly status: 'succeeded' | 'failed' | 'processing';
  public readonly amount?: number;
  public readonly currency?: string;
  public readonly refundedAt?: Date;
  public readonly reason?: string;
  public readonly metadata: Record<string, unknown>;
  public readonly raw?: unknown;

  constructor(data: RefundResultData) {
    this.id = data.id;
    this.provider = data.provider;
    this.status = data.status;
    this.amount = data.amount;
    this.currency = data.currency;
    this.refundedAt = data.refundedAt;
    this.reason = data.reason;
    this.metadata = data.metadata ?? {};
    this.raw = data.raw;
  }
}

export class WebhookEvent implements WebhookEventData {
  public readonly id: string;
  public readonly provider: string;
  public readonly type: string;
  public readonly data: { sessionId?: string; paymentIntentId?: string; [key: string]: unknown };
  public readonly createdAt?: Date;
  public readonly raw?: unknown;

  constructor(data: WebhookEventData) {
    this.id = data.id;
    this.provider = data.provider;
    this.type = data.type;
    this.data = data.data;
    this.createdAt = data.createdAt;
    this.raw = data.raw;
  }
}

export abstract class PaymentProvider {
  public readonly config: Record<string, unknown>;
  public readonly name: string;
  private _defaultCurrency: string = 'USD';

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
    this.name = 'base';
    if (config.defaultCurrency && typeof config.defaultCurrency === 'string') {
      this._defaultCurrency = config.defaultCurrency;
    }
  }

  get defaultCurrency(): string { return this._defaultCurrency; }
  setDefaultCurrency(currency: string): void { this._defaultCurrency = currency; }

  abstract createIntent(params: CreateIntentParams): Promise<PaymentIntent>;
  abstract verifyPayment(intentId: string): Promise<PaymentResult>;
  abstract getStatus(intentId: string): Promise<PaymentResult>;
  abstract refund(paymentId: string, amount?: number | null, options?: { reason?: string }): Promise<RefundResult>;
  abstract handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<WebhookEvent>;

  verifyWebhookSignature(_payload: unknown, _signature: string): boolean { return true; }

  getCapabilities(): ProviderCapabilities {
    return { supportsWebhooks: false, supportsRefunds: false, supportsPartialRefunds: false, requiresManualVerification: true };
  }
}

export default PaymentProvider;
