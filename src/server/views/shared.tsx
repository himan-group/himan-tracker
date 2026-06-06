/** @jsx h */
/** @jsxFrag Fragment */

import { h, Fragment } from "preact";
import type { ComponentChildren, JSX } from "preact";

import { formatTable } from "../../reports/formatTable.js";

// ── HTML escaping ─────────────────────────────────────────────────────

const ESCAPE_MAP: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}

// ── Shared inline scripts ─────────────────────────────────────────────

export const TAB_SCRIPT = `
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
`;

// ── Inline CSS ────────────────────────────────────────────────────────

/** Read from the shared CSS module or pass as a string */
export { getSharedCss } from "../htmlLayout.js";

// ── Safe HTML injection ──────────────────────────────────────────────

/** Embed raw pre-escaped HTML. Use for gradual migration of existing string renderers. */
export function RawHtml(props: { html: string }): JSX.Element {
    return <span dangerouslySetInnerHTML={{ __html: props.html }} />;
}

// ── NavBar ────────────────────────────────────────────────────────────

export type NavPage = { href: string; label: string };

export function NavBar(props: { pages: NavPage[]; current: string }): JSX.Element {
    return (
        <nav class="nav" aria-label="Dashboard navigation">
            {props.pages.map((p) => (
                <a
                    href={p.href}
                    aria-current={p.href === props.current ? "page" : undefined}
                >
                    {p.label}
                </a>
            ))}
        </nav>
    );
}

// ── Breadcrumb ────────────────────────────────────────────────────────

export function Breadcrumb(props: { items: { href?: string; label: string }[] }): JSX.Element {
    return (
        <nav class="breadcrumb" aria-label="Breadcrumb">
            {props.items.map((item, i) => {
                const isLast = i === props.items.length - 1;
                return (
                    <>
                        {i > 0 && <span class="breadcrumb-sep">›</span>}
                        {isLast ? (
                            <span class="breadcrumb-current">{item.label}</span>
                        ) : (
                            <a href={item.href}>{item.label}</a>
                        )}
                    </>
                );
            })}
        </nav>
    );
}

// ── Metric ────────────────────────────────────────────────────────────

export type VisualTone = "positive" | "negative" | "neutral" | "warning";

export function Metric(props: {
    label: string;
    value: string;
    tone?: VisualTone;
    helperText?: string;
}): JSX.Element {
    const toneClass = props.tone ? ` is-${props.tone}` : "";
    return (
        <div class={`metric${toneClass}`}>
            <div class="metric-label">{props.label}</div>
            <div class="metric-value">{props.value}</div>
            {props.helperText && <div class="metric-subtle">{props.helperText}</div>}
        </div>
    );
}

export function MetricsGrid(props: { children: ComponentChildren }): JSX.Element {
    return <div class="metrics">{props.children}</div>;
}

// ── Dashboard Table ───────────────────────────────────────────────────

export type DashboardTable = {
    columns: string[];
    rows: string[][];
    emptyText: string;
    note?: string;
    width?: "full" | "compact";
    stickyColumns?: number;
    moreHref?: string;
    pagination?: DashboardPagination;
};

export type DashboardPagination = {
    page: number;
    pageSize: number;
    totalCount: number;
    previousHref?: string;
    nextHref?: string;
};

export function Pagination(props: { pagination: DashboardPagination }): JSX.Element {
    const p = props.pagination;
    return (
        <nav class="pagination" aria-label="Pagination">
            <span>Page {p.page}</span>
            <div class="pagination-links">
                {p.previousHref ? (
                    <a href={p.previousHref} rel="prev">← Previous</a>
                ) : (
                    <span aria-disabled="true">← Previous</span>
                )}
                {p.nextHref ? (
                    <a href={p.nextHref} rel="next">Next →</a>
                ) : (
                    <span aria-disabled="true">Next →</span>
                )}
            </div>
        </nav>
    );
}

export function DashboardTableMeta(props: {
    note?: string;
    moreHref?: string;
    pagination?: DashboardPagination;
}): JSX.Element {
    const { note, moreHref, pagination } = props;
    if (!note && !moreHref && !pagination) {
        return <></>;
    }

    return (
        <div class="table-meta">
            <p class="table-note">
                {note}
                {moreHref && (
                    <a href={moreHref} class="more-link">More →</a>
                )}
            </p>
            {pagination && <Pagination pagination={pagination} />}
        </div>
    );
}

// ── Cell rendering helpers ────────────────────────────────────────────

export type IconName = "alert" | "arrow-down" | "arrow-up" | "check" | "minus" | "warning";

export function Icon(props: { name: IconName; size: number }): JSX.Element {
    const { name, size } = props;
    const common = {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2.4,
        "stroke-linecap": "round" as const,
        "stroke-linejoin": "round" as const,
        "aria-hidden": "true" as const,
        // Preact doesn't use `focusable`, but it's safe to pass
    };

    switch (name) {
        case "alert":
            return (
                <svg {...common}>
                    <path d="M10.3 3.5 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0Z" />
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                </svg>
            );
        case "warning":
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 7v6" />
                    <path d="M12 17h.01" />
                </svg>
            );
        case "arrow-up":
            return (
                <svg {...common}>
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                </svg>
            );
        case "arrow-down":
            return (
                <svg {...common}>
                    <path d="M12 5v14" />
                    <path d="m19 12-7 7-7-7" />
                </svg>
            );
        case "check":
            return (
                <svg {...common}>
                    <path d="M20 6 9 17l-5-5" />
                </svg>
            );
        default:
            return (
                <svg {...common}>
                    <path d="M5 12h14" />
                </svg>
            );
    }
}

function isTrendColumn(columnName: string): boolean {
    return (
        columnName === "change" ||
        columnName.includes("growth") ||
        columnName.includes("delta")
    );
}

function parseTrendIcon(text: string): IconName {
    if (text.startsWith("+")) return "arrow-up";
    if (text.startsWith("-")) return "arrow-down";
    if (text === "–" || text === "n/a" || text === "0%") return "minus";
    return "arrow-up";
}

function parseTrendTone(text: string): VisualTone {
    if (text.startsWith("+")) return "negative";
    if (text.startsWith("-")) return "positive";
    return "neutral";
}

function parseSeverity(value: string): string | null {
    const lower = value.toLowerCase();
    if (lower === "critical" || lower === "major" || lower === "warning") return lower;
    return null;
}

export function DashboardCell(props: { column: string; value: string }): JSX.Element {
    const { column, value } = props;
    const columnName = column.toLowerCase();
    const classes: string[] = [];

    if (columnName === "severity") {
        classes.push("cell-severity");
    }
    if (isTrendColumn(columnName) && value !== "n/a") {
        classes.push("cell-trend-cell");
    }

    const className = classes.length > 0 ? classes.join(" ") : undefined;

    // Content
    let content: ComponentChildren = value;

    if (columnName === "severity") {
        const severity = parseSeverity(value);
        if (severity) {
            content = <span class={`severity-badge is-${severity}`}>{value}</span>;
        }
    } else if (isTrendColumn(columnName) && value !== "n/a") {
        const tone = parseTrendTone(value);
        content = (
            <span class={`cell-trend is-${tone}`}>
                <span class="cell-icon">
                    <Icon name={parseTrendIcon(value)} size={13} />
                </span>
                {value}
            </span>
        );
    }

    return <td class={className}>{content}</td>;
}

// ── Dashboard Content (table or text mode) ────────────────────────────

export type DashboardDisplayMode = "table" | "text";

export function DashboardContent(props: {
    table: DashboardTable;
    display: DashboardDisplayMode;
}): JSX.Element {
    const { table, display } = props;

    if (table.rows.length === 0) {
        return (
            <>
                <DashboardTableMeta
                    note={table.note}
                    moreHref={table.moreHref}
                    pagination={table.pagination}
                />
                <p class="empty-state">{table.emptyText}</p>
            </>
        );
    }

    if (display === "text") {
        return (
            <>
                <DashboardTableMeta
                    note={table.note}
                    moreHref={table.moreHref}
                    pagination={table.pagination}
                />
                <pre class="cli-output">{formatTable(table.columns, table.rows).join("\n")}</pre>
            </>
        );
    }

    const stickyCols = table.stickyColumns ?? 2;
    const scrollClass = table.width === "compact" ? "table-scroll is-compact" : "table-scroll";
    const stickyAttr = stickyCols > 0 ? { "data-sticky-cols": String(stickyCols) } : {};

    return (
        <>
            <DashboardTableMeta
                note={table.note}
                moreHref={table.moreHref}
                pagination={table.pagination}
            />
            <div class={scrollClass} {...stickyAttr}>
                <table>
                    <thead>
                        <tr>
                            {table.columns.map((col) => (
                                <th scope="col">{col}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {table.rows.map((row) => (
                            <tr>
                                {row.map((cell, i) => (
                                    <DashboardCell column={table.columns[i] ?? ""} value={cell} />
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

// ── Section ───────────────────────────────────────────────────────────

export type DashboardSection = {
    title: string;
    table: DashboardTable;
    cliLines?: string[];
    cliBlocks?: DashboardCliBlock[];
    tableBlocks?: DashboardTableBlock[];
};

export type DashboardCliBlock = {
    title: string;
    lines: string[];
};

export type DashboardTableBlock = {
    title: string;
    table: DashboardTable;
};

export function Section(props: {
    section: DashboardSection;
    display: DashboardDisplayMode;
}): JSX.Element {
    const { section, display } = props;

    if (display === "text" && section.cliBlocks) {
        return (
            <section>
                <h2>{section.title}</h2>
                {section.cliBlocks.map((block) => (
                    <>
                        <p class="table-note">{block.title}</p>
                        {block.lines.length > 0 && (
                            <pre class="cli-output">{block.lines.join("\n")}</pre>
                        )}
                    </>
                ))}
            </section>
        );
    }

    if (section.tableBlocks) {
        return (
            <section>
                <h2>{section.title}</h2>
                {section.tableBlocks.map((block) => (
                    <>
                        <p class="table-note">{block.title}</p>
                        <DashboardContent table={block.table} display={display} />
                    </>
                ))}
            </section>
        );
    }

    return (
        <section>
            <h2>{section.title}</h2>
            <DashboardContent table={section.table} display={display} />
        </section>
    );
}

// ── Tabbed Section ────────────────────────────────────────────────────

export type DashboardTab = {
    id: string;
    label: string;
    table: DashboardTable;
};

export function TabbedSection(props: {
    title: string;
    idPrefix: string;
    tabs: DashboardTab[];
    display: DashboardDisplayMode;
    defaultActiveTab?: string;
}): JSX.Element {
    const { title, idPrefix, tabs, display, defaultActiveTab } = props;
    const activeIndex = defaultActiveTab
        ? Math.max(0, tabs.findIndex((t) => t.id === defaultActiveTab))
        : 0;

    return (
        <section data-tabs>
            <div class="section-heading">
                <h2>{title}</h2>
                <div class="tab-bar" aria-label={title}>
                    {tabs.map((tab, index) => {
                        const active = index === activeIndex;
                        return (
                            <button
                                aria-current={active ? "true" : undefined}
                                id={`${idPrefix}-tab-${tab.id}`}
                                role="tab"
                                type="button"
                                aria-controls={`${idPrefix}-panel-${tab.id}`}
                                tabindex={active ? 0 : -1}
                            >
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
            </div>
            {tabs.map((tab, index) => {
                const hidden = index !== activeIndex;
                return (
                    <div
                        id={`${idPrefix}-panel-${tab.id}`}
                        role="tabpanel"
                        aria-labelledby={`${idPrefix}-tab-${tab.id}`}
                        hidden={hidden || undefined}
                    >
                        <DashboardContent table={tab.table} display={display} />
                    </div>
                );
            })}
        </section>
    );
}

// ── Page Shell ────────────────────────────────────────────────────────

export type PageShellProps = {
    title: string;
    heading: string;
    iconUrl: string;
    css: string;
    navBar?: JSX.Element;
    breadcrumb?: JSX.Element;
    statusHtml: JSX.Element;
    children: ComponentChildren;
    scripts?: string;
};

export function PageShell(props: PageShellProps): JSX.Element {
    return (
        <html lang="en" data-theme="light">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>{props.title} – himan-tracker</title>
                <link rel="icon" type="image/svg+xml" href={props.iconUrl} />
                <meta name="theme-color" content="#f7f8fa" />
                <style dangerouslySetInnerHTML={{ __html: props.css }} />
            </head>
            <body>
                <header>
                    <div class="header-inner">
                        <h1>{props.heading}</h1>
                        <div class="status">{props.statusHtml}</div>
                        {props.navBar}
                        {props.breadcrumb}
                    </div>
                </header>
                <main>{props.children}</main>
                {props.scripts && <script dangerouslySetInnerHTML={{ __html: props.scripts }} />}
            </body>
        </html>
    );
}
