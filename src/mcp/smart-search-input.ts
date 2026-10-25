export function validateSmartSearchInput(args: Record<string, unknown>):
  | { query?: string; expandIds?: string[] }
  | { error: string } {
  if (args.query !== undefined && typeof args.query !== "string") {
    return { error: "query must be a string" };
  }

  let expandIds: string[] | undefined;
  if (args.expandIds !== undefined) {
    if (typeof args.expandIds !== "string") {
      return { error: "expandIds must be a comma-separated string of observation IDs" };
    }
    expandIds = args.expandIds.split(",").map((id) => id.trim()).filter(Boolean);
    if (!expandIds.length) {
      return { error: "expandIds must contain at least one observation ID" };
    }
  }

  const query = typeof args.query === "string" ? args.query.trim() || undefined : undefined;
  if (!query && !expandIds) {
    return { error: "query or expandIds is required for memory_smart_search" };
  }
  return { query, expandIds };
}
