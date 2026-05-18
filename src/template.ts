const variablePattern = /{{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*}}/g;

export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(variablePattern)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

export function renderTemplate(body: string, variables: Record<string, unknown>): string {
  return body.replace(variablePattern, (_full, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      throw new Error(`Variavel obrigatoria ausente: ${key}`);
    }
    return String(value);
  });
}

