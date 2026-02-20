// Shared slash-filter input parsing for search overlays.

export function parseSlashFilterQuery<T extends string>(
  rawInput: string,
  validFilters: Record<string, T>,
): { filters: T[]; query: string } {
  const tokens = rawInput.trimStart().split(/\s+/);
  const filters: T[] = [];
  let queryStartIndex = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const filter = validFilters[token];
    if (!filter) break;
    if (!filters.includes(filter)) filters.push(filter);
    queryStartIndex = i + 1;
  }

  const query = tokens.slice(queryStartIndex).join(" ").trim();
  return { filters, query };
}
