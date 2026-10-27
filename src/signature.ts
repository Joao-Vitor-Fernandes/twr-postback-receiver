import { createHmac, timingSafeEqual } from 'node:crypto';

/** Assinatura esperada no header X-Signature: "sha256=<hex>" do corpo CRU. */
export function sign(rawBody: Buffer | string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;

  const expected = Buffer.from(sign(rawBody, secret));
  const received = Buffer.from(header.trim());

  // timingSafeEqual exige tamanhos iguais; comparar o tamanho antes não vaza nada útil.
  return expected.length === received.length && timingSafeEqual(expected, received);
}
