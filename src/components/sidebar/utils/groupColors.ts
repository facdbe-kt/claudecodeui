/**
 * Preset accent colors for project groups. Stored as #rrggbb hex so they can be
 * applied via inline styles (Tailwind can't generate class names from runtime values).
 * Tones are the saturated ~500 shade so they read clearly on the sidebar.
 */
export const GROUP_COLORS = [
  '#64748b', // slate
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#10b981', // emerald
  '#14b8a6', // teal
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
] as const;

/** Fallback accent used when a group has no color set yet. */
export const DEFAULT_GROUP_COLOR = '#3b82f6'; // blue

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Returns a valid hex color for rendering, falling back to the default. */
export function getGroupColor(color?: string | null): string {
  return color && HEX_COLOR_PATTERN.test(color) ? color : DEFAULT_GROUP_COLOR;
}

/** Picks a default color for a new group, rotating through the palette so groups differ. */
export function nextGroupColor(existingCount: number): string {
  return GROUP_COLORS[existingCount % GROUP_COLORS.length];
}
