export const PAYMENT_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
} as const;

export type PaymentStatus = typeof PAYMENT_STATUS;
export type PaymentStatusValue = PaymentStatus[keyof PaymentStatus];
export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS) as PaymentStatusValue[];

export const PAYMENT_GATEWAY_TYPE = {
  MANUAL: 'manual',
  STRIPE: 'stripe',
  SSLCOMMERZ: 'sslcommerz',
} as const;

export type PaymentGatewayType = typeof PAYMENT_GATEWAY_TYPE;
export type PaymentGatewayTypeValue = PaymentGatewayType[keyof PaymentGatewayType];
export const PAYMENT_GATEWAY_TYPE_VALUES = Object.values(PAYMENT_GATEWAY_TYPE) as PaymentGatewayTypeValue[];

const paymentStatusSet = new Set<PaymentStatusValue>(PAYMENT_STATUS_VALUES);
const paymentGatewayTypeSet = new Set<PaymentGatewayTypeValue>(PAYMENT_GATEWAY_TYPE_VALUES);

export function isPaymentStatus(value: unknown): value is PaymentStatusValue {
  return typeof value === 'string' && paymentStatusSet.has(value as PaymentStatusValue);
}

export function isPaymentGatewayType(value: unknown): value is PaymentGatewayTypeValue {
  return typeof value === 'string' && paymentGatewayTypeSet.has(value as PaymentGatewayTypeValue);
}
