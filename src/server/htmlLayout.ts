import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Pico CSS ──────────────────────────────────────────────────────────

let _picoCss: string | null = null;

function loadPicoCss(): string {
  if (_picoCss !== null) return _picoCss;

  try {
    const cssPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../node_modules/@picocss/pico/css/pico.classless.min.css",
    );
    _picoCss = readFileSync(cssPath, "utf8");
  } catch {
    _picoCss = "/* Pico CSS not available */";
  }

  return _picoCss;
}

// ── Shared CSS (Pico + custom overrides) ──────────────────────────────

let _sharedCss: string | null = null;

export function getSharedCss(): string {
  if (_sharedCss !== null) return _sharedCss;
  _sharedCss = loadPicoCss() + "\n" + CUSTOM_CSS;
  return _sharedCss;
}

const CUSTOM_CSS = `
:root {
  --pico-font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

/* Override Pico CSS defaults */
body { min-height: 100vh; background: #f7f8fa; color: var(--pico-color); }
body > header { padding: 0; border-bottom: 1px solid var(--pico-muted-border-color); background: var(--pico-card-background-color); }
body > header .header-inner, body > main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; }
body > header .header-inner { padding: 22px 0 18px; }
body > header h1 { margin: 0; font-size: 28px; line-height: 1.15; font-weight: 720; color: var(--pico-color); }
body > header .status { margin-top: 10px; color: var(--pico-muted-color); font-size: 14px; }
body > header .status strong { color: var(--pico-primary); }
body > header .status strong.is-error { color: #b42318; }
body > main { padding: 22px 0 40px; }

.nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; justify-content: flex-start; }
.nav a { border: 1px solid var(--pico-muted-border-color); border-radius: 8px; color: var(--pico-muted-color); font-size: 13px; font-weight: 650; line-height: 1.2; padding: 7px 10px; text-decoration: none; }
.nav a[aria-current="page"] { background: #eef2f5; border-color: rgba(55, 60, 68, 0.35); color: var(--pico-color); }

.metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.metric { background: var(--pico-card-background-color); border: 1px solid var(--pico-muted-border-color); border-radius: 8px; padding: 14px; min-width: 0; }
.metric-label { color: var(--pico-muted-color); font-size: 12px; font-weight: 650; text-transform: uppercase; }
.metric-value { margin-top: 8px; font-size: 24px; line-height: 1.1; font-weight: 720; overflow-wrap: anywhere; }
.metric.is-positive .metric-value, .cell-trend.is-positive { color: #0f766e; }
.metric.is-negative .metric-value, .cell-trend.is-negative { color: #b42318; }
.metric.is-warning .metric-value { color: #a15c07; }

section { margin-top: 14px; background: var(--pico-card-background-color); border: 1px solid var(--pico-muted-border-color); border-radius: 8px; }
section > h2 { margin: 0; padding: 13px 14px; border-bottom: 1px solid var(--pico-muted-border-color); font-size: 16px; line-height: 1.25; color: var(--pico-color); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; border-bottom: 1px solid var(--pico-muted-border-color); }
.section-heading h2 { margin: 0; font-size: 16px; line-height: 1.25; }

.tab-bar { display: inline-flex; gap: 0; border-radius: 6px; overflow: hidden; border: 1px solid var(--pico-muted-border-color); }
.tab-bar button { appearance: none; border: 0; border-radius: 0; background: transparent; color: var(--pico-muted-color); cursor: pointer; font: inherit; font-size: 13px; font-weight: 650; line-height: 1.2; padding: 6px 12px; width: auto; margin: 0; border-right: 1px solid var(--pico-muted-border-color); }
.tab-bar button:last-child { border-right: 0; }
.tab-bar button[aria-current="true"] { background: #373c44; color: #fff; }
[hidden] { display: none; }

.table-note, .empty-state { margin: 0; padding: 12px 14px; color: var(--pico-muted-color); font-size: 13px; line-height: 1.4; }
.table-note { border-bottom: 1px solid var(--pico-muted-border-color); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.table-meta { border-bottom: 1px solid var(--pico-muted-border-color); }
.table-meta .table-note { border-bottom: 0; }

.pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 0 14px 12px; color: var(--pico-muted-color); font-size: 13px; line-height: 1.4; }
.pagination-links { display: flex; flex-wrap: wrap; gap: 12px; }
.pagination a { color: var(--pico-primary); text-decoration: none; }
.pagination a:hover { text-decoration: underline; }
.pagination [aria-disabled="true"] { color: #9aa7b2; }

.table-scroll { overflow: auto; }
.table-scroll.is-compact { display: inline-block; max-width: 100%; min-width: 0; vertical-align: top; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 0; }
.table-scroll.is-compact table { width: auto; }
th, td { padding: 9px 12px; border-bottom: 1px solid var(--pico-muted-border-color); text-align: left; vertical-align: top; white-space: nowrap; }
th { background: #f8fafb; color: var(--pico-muted-color); font-size: 12px; font-weight: 700; text-transform: uppercase; }
td { color: #24313d; font-variant-numeric: tabular-nums; }
tbody tr:last-child td { border-bottom: 0; }

.cli-output { margin: 0; padding: 14px; overflow: auto; color: #24313d; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 12px; line-height: 1.45; font-variant-numeric: tabular-nums; white-space: pre; }
.more-link { color: var(--pico-primary); font-size: 13px; font-weight: 650; text-decoration: none; white-space: nowrap; }
.more-link:hover { text-decoration: underline; }
.severity-badge, .cell-trend { font-weight: 700; }
.severity-badge { border: 1px solid currentColor; border-radius: 999px; padding: 2px 8px; }
.severity-badge.is-critical { color: #b42318; }
.severity-badge.is-major { color: #c2410c; }
.severity-badge.is-warning { color: #a15c07; }
.cell-trend { display: inline-flex; align-items: center; gap: 6px; }

/* Usage page */
.usage-hero { padding: 18px; margin-bottom: 18px; }
.usage-hero.is-alert { border-color: rgba(180, 35, 24, 0.24); box-shadow: inset 0 0 0 1px rgba(180, 35, 24, 0.08); }
.usage-hero-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.usage-hero-kicker { color: var(--pico-muted-color); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.usage-hero-value { margin-top: 8px; font-size: 34px; line-height: 1.05; font-weight: 760; font-variant-numeric: tabular-nums; }
.usage-hero-subtitle { margin-top: 8px; color: var(--pico-muted-color); font-size: 14px; line-height: 1.5; }
.usage-badge { padding: 8px 10px; border-radius: 999px; background: #f0f1f3; color: var(--pico-color); font-size: 12px; font-weight: 700; white-space: nowrap; }
.usage-alert-badge { margin-top: 12px; display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; background: #fff1f1; color: #b42318; font-size: 13px; font-weight: 700; }
.usage-progress { margin-top: 18px; }
.usage-progress-track { position: relative; height: 18px; border-radius: 999px; background: linear-gradient(90deg, #edf3f8 0%, #f5f7fa 100%); border: 1px solid #dbe4eb; overflow: visible; }
.usage-progress-fill { position: absolute; inset: 0 auto 0 0; max-width: 100%; border-radius: 999px; background: var(--pico-primary); }
.usage-progress-marker { position: absolute; top: -7px; bottom: -7px; width: 0; pointer-events: none; }
.usage-progress-marker::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; transform: translateX(-50%); border-radius: 999px; background: currentColor; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.92); }
.usage-progress-marker::after { content: ""; position: absolute; left: 50%; top: -2px; width: 10px; height: 10px; transform: translateX(-50%); border-radius: 999px; background: currentColor; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.96); }
.usage-progress-ref-line { position: absolute; top: -2px; bottom: -2px; width: 0; pointer-events: none; z-index: 1; }
.usage-progress-ref-line::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; transform: translateX(-50%); border-radius: 999px; background: #c8d6e0; }
.usage-progress-marker.is-baseline { color: #0f3d62; z-index: 2; }
.usage-progress-scale { display: flex; justify-content: space-between; margin-top: 8px; color: var(--pico-muted-color); font-size: 12px; font-variant-numeric: tabular-nums; }
.usage-legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.usage-legend-item, .usage-summary-item { min-width: 0; border-radius: 10px; }
.usage-legend-item { padding: 12px 13px; border: 1px solid var(--pico-muted-border-color); background: #fbfcfd; }
.usage-legend-item.is-alert, .usage-summary-item.is-alert { border-color: rgba(180, 35, 24, 0.28); background: #fff6f5; }
.usage-legend-head { display: flex; align-items: center; gap: 8px; color: var(--pico-muted-color); font-size: 12px; font-weight: 700; text-transform: uppercase; }
.usage-legend-dot { width: 10px; height: 10px; border-radius: 999px; flex: none; }
.usage-legend-dot.is-used { background: var(--pico-primary); }
.usage-legend-dot.is-baseline { background: #0f3d62; }
.usage-legend-dot.is-total { background: #8f9baa; }
.usage-legend-value { margin-top: 8px; font-size: 24px; line-height: 1.15; font-weight: 740; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.usage-legend-subtle, .usage-summary-subtle { margin-top: 6px; color: var(--pico-muted-color); font-size: 13px; line-height: 1.45; }
.usage-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.usage-summary-item { padding: 12px 13px; background: #f8fafb; }
.usage-summary-label { color: var(--pico-muted-color); font-size: 12px; font-weight: 700; text-transform: uppercase; }
.usage-summary-value { margin-top: 7px; font-size: 20px; line-height: 1.15; font-weight: 720; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.usage-controls, .usage-note { padding: 14px; color: #24313d; }
.usage-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px 16px; border-bottom: 1px solid var(--pico-muted-border-color); }
.usage-control { display: flex; flex-direction: column; gap: 6px; }
.usage-control label { color: var(--pico-muted-color); font-size: 12px; font-weight: 650; text-transform: uppercase; }
.usage-control select, .usage-controls button { height: 38px; border: 1px solid var(--pico-muted-border-color); border-radius: 8px; background: #fff; color: var(--pico-color); font: inherit; font-size: 14px; padding: 0 12px; }
.usage-controls button { background: var(--pico-primary); border-color: var(--pico-primary); color: var(--pico-primary-inverse); cursor: pointer; font-weight: 650; width: auto; }
.usage-note { color: var(--pico-muted-color); font-size: 13px; line-height: 1.55; }

.breadcrumb { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 14px; font-size: 14px; color: var(--pico-muted-color); justify-content: flex-start; }
.breadcrumb a { color: var(--pico-primary); text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
.breadcrumb-sep { margin: 0 6px; color: var(--pico-muted-border-color); }
.breadcrumb-current { color: var(--pico-color); font-weight: 650; }

@media (max-width: 980px) { .metrics, .usage-legend, .usage-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .section-heading { align-items: flex-start; flex-direction: column; } }
@media (max-width: 520px) { body > header .header-inner, body > main { width: min(100vw - 20px, 1180px); } .metrics, .usage-legend, .usage-summary-grid { grid-template-columns: 1fr; } .usage-hero { padding: 14px; } .usage-hero-head { flex-direction: column; } .usage-hero-value { font-size: 30px; } .usage-controls { align-items: stretch; } }
`;

// ── Shared script ─────────────────────────────────────────────────────

export const TAB_SCRIPT = `
<script>
  document.querySelectorAll("[data-tabs]").forEach((root) => {
    const buttons = [...root.querySelectorAll("[role='tab']")];
    const panels = [...root.querySelectorAll("[role='tabpanel']")];
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const selectedPanel = btn.getAttribute("aria-controls");
        buttons.forEach((b) => {
          const active = b === btn;
          b.setAttribute("aria-current", active ? "true" : "false");

          b.setAttribute("tabindex", active ? "0" : "-1");
        });
        panels.forEach((p) => { p.hidden = p.id !== selectedPanel; });
      });
    });
  });
</script>`;

// ── HTML escaping ─────────────────────────────────────────────────────

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}

// ── Date formatting ───────────────────────────────────────────────────

import { formatLocalDateTime } from "../reports/periodFormatter.js";
export { formatLocalDateTime };

// ── Ingest status ─────────────────────────────────────────────────────

export function renderIngestStatusHTML(snapshot: { ok: boolean; at: string; error?: string; events_inserted?: number; events_skipped?: number } | null): string {
  if (!snapshot) return "<strong>Ingest pending</strong>";
  if (!snapshot.ok) return `<strong class="is-error">Ingest failed</strong> at ${escapeHtml(formatLocalDateTime(snapshot.at))}: ${escapeHtml(snapshot.error ?? "unknown error")}`;
  return `<strong>Ingested</strong> at ${escapeHtml(formatLocalDateTime(snapshot.at))}: ${snapshot.events_inserted ?? 0} inserted, ${snapshot.events_skipped ?? 0} skipped`;
}

// ── Page shell ────────────────────────────────────────────────────────

export type PageShellOptions = {
  title: string;
  heading: string;
  iconUrl: string;
  ingestStatusHtml: string;
  navLinks: string;
  body: string;
  scripts?: string;
};

export function renderPageShell(options: PageShellOptions): string {
  const scripts = options.scripts ?? "";
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} – himan-tracker</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(options.iconUrl)}">
  <meta name="theme-color" content="#f7f8fa">
  <style>${getSharedCss()}</style>
</head>
<body>
  <header>
    <div class="header-inner">
      <h1>${escapeHtml(options.heading)}</h1>
      <div class="status">${options.ingestStatusHtml}</div>
      ${options.navLinks}
    </div>
  </header>
  <main>
    ${options.body}
  </main>
  ${scripts}
</body>
</html>`;
}

// ── Nav link builder ──────────────────────────────────────────────────

export function buildNavLinks(current: string): string {
  const pages = [
    { href: "/", label: "Overview" },
    { href: "/metrics", label: "Metrics" },
    { href: "/usage", label: "Usage" },
  ];
  return `<nav class="nav" aria-label="Dashboard navigation">${pages
    .map((p) => {
      const isCurrent = p.href === current;
      return `<a href="${escapeHtml(p.href)}"${isCurrent ? ' aria-current="page"' : ""}>${escapeHtml(p.label)}</a>`;
    })
    .join("")}</nav>`;
}
