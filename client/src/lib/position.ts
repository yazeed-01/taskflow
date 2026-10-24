const GAP = 1024;

/**
 * Where to put a card dropped between two neighbours in a kanban column. Positions are floats, so a
 * move touches one row (no renumbering of the column) — the server just stores what it's given.
 * `before`/`after` are the positions of the cards above/below the drop slot (undefined at the ends).
 */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return GAP;
  if (before === undefined) return after! - GAP;
  if (after === undefined) return before + GAP;
  return (before + after) / 2;
}

/** After ~50 repeated bisections in the same spot a float runs out of precision; callers can detect it. */
export const hasRoom = (before: number, after: number) => {
  const mid = (before + after) / 2;
  return mid > before && mid < after;
};
