/** MIME type used to carry a dragged project's id between sidebar drag sources and drop targets. */
export const PROJECT_DND_MIME = 'application/x-cloudcli-project';

/** True when a drag event carries a sidebar project payload (so a drop target should accept it). */
export function isProjectDrag(types: readonly string[] | DOMStringList): boolean {
  return Array.from(types).includes(PROJECT_DND_MIME);
}
