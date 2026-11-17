/** Fill `{name}` placeholders. */
export function format(template: string, params: Record<string, string | number | undefined> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined ? m : String(params[k])));
}
