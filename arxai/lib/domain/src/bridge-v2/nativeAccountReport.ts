// Native MT5 AccountInfo reporting. Wire facts only, never current/live proof.
import { z } from 'zod/v4';
export const NATIVE_ACCOUNT_STREAM = 'ACCOUNT_NATIVE_V1' as const;
// Existing receipt gap_size is int4. This bound is not continuity proof.
export const NATIVE_ACCOUNT_MAX_SEQUENCE = 2147483647;
export const NATIVE_ACCOUNT_AMOUNT_FIELDS = ['balance', 'equity', 'profit', 'credit', 'margin', 'freeMargin'] as const;
const amount = z.string().min(1).max(48);
export const nativeAccountReportPayloadSchema = z.object({
    reportVersion: z.literal(1),
    source: z.literal('NATIVE_ACCOUNT_INFO'),
    accountBinding: z.string().regex(/^[a-f0-9]{64}$/),
    producerInstanceId: z.string().regex(/^[a-f0-9]{16,64}$/),
    observedAtEpochMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    clockBasis: z.literal('TERMINAL_UTC_UNVERIFIED'),
    captureDurationMs: z.number().int().nonnegative().max(5000),
    terminalConnected: z.boolean(),
    currency: z.string().min(1).max(8).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'Currency must be nonblank without ASCII controls'),
    currencyDigits: z.number().int().min(0).max(16),
    balance: amount, equity: amount, profit: amount, credit: amount, margin: amount, freeMargin: amount,
}).strict().superRefine((value, context) => {
    const pattern = new RegExp('^-?(?:0|[1-9]\\d*)' + (value.currencyDigits === 0 ? '' : '\\.\\d{' + value.currencyDigits + '}') + '$');
    for (const field of NATIVE_ACCOUNT_AMOUNT_FIELDS) {
        const text = value[field];
        if (!pattern.test(text) || /^-0+(?:\.0+)?$/.test(text) || (field === 'margin' && text.startsWith('-'))) {
            context.addIssue({ code: 'custom', path: [field], message: 'Amount must use exact fixed currency precision; no exponent, sign prefix, negative zero, or negative margin' });
        }
    }
});
export type NativeAccountReportPayload = z.infer<typeof nativeAccountReportPayloadSchema>;
