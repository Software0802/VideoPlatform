/** `"共 {n} 条"` + `{ n: 3 }` → `"共 3 条"`。缺参数时原样保留占位，便于肉眼发现漏传。 */
export type MessageParams = Record<string, string | number>;

export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined ? whole : String(value);
  });
}
