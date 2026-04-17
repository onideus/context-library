export class PayloadTooLargeError extends Error {
  field: string;
  actual: number;
  max: number;

  constructor(field: string, actual: number, max: number) {
    super(`${field} exceeds maximum size: ${actual} > ${max}`);
    this.name = "PayloadTooLargeError";
    this.field = field;
    this.actual = actual;
    this.max = max;
  }
}

export function validatePayloadSize(
  payload: unknown,
  maxBytes: number,
  label = "payload"
): void {
  const size = JSON.stringify(payload).length;
  if (size > maxBytes) {
    throw new PayloadTooLargeError(label, size, maxBytes);
  }
}

export function validateStringLength(
  value: string | undefined | null,
  maxChars: number,
  label: string
): void {
  if (value && value.length > maxChars) {
    throw new PayloadTooLargeError(label, value.length, maxChars);
  }
}

export const LIMITS = {
  STORE_HANDOFF_BYTES: 100_000,
  PATCH_HANDOFF_BYTES: 100_000,
  TASK_TITLE_CHARS: 500,
  TASK_CONTEXT_CHARS: 20_000,
  TASK_BLOCKED_REASON_CHARS: 1000,
} as const;
