/** Collision-resistant id with a readable prefix, e.g. `ses_1f0c…`. */
export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}
