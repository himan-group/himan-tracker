import { render } from "preact-render-to-string";
import type { JSX } from "preact";

/**
 * Render a Preact JSX tree to a complete HTML5 document string.
 * Prepends `<!doctype html>` and renders the JSX tree.
 */
export function renderHtml(tree: JSX.Element): string {
    return `<!doctype html>\n${render(tree)}`;
}
