import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listAssets, revealInFinder, searchAssets } from "../api";
import type {
  Asset,
  AssetFilter,
  DateTree as DateTreeData,
  Kind,
} from "../types";
import { AssetThumb } from "./AssetThumb";
import { ContextMenu } from "./ContextMenu";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const KIND_META: Record<Kind, { label: string; icon: string }> = {
  image: { label: "Photos", icon: "🖼️" },
  video: { label: "Videos", icon: "🎬" },
  audio: { label: "Audio", icon: "🎵" },
  pdf: { label: "PDFs", icon: "📄" },
  other: { label: "Files", icon: "📎" },
};

const ROW_H = 30;

function ExpandIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 8l4-4 4 4" />
      <path d="M8 16l4 4 4-4" />
    </svg>
  );
}

function CollapseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h3" opacity="0.55" />
      <path d="M11 12h2" opacity="0.55" />
      <path d="M16 12h3" opacity="0.55" />
      <path d="M12 8V3" />
      <path d="M9.5 5.5l2.5 2.5 2.5-2.5" />
      <path d="M12 16v5" />
      <path d="M9.5 18.5l2.5-2.5 2.5 2.5" />
    </svg>
  );
}

type Row =
  | { kind: "year"; key: string; depth: number; label: string; count: number; nodeKey: string }
  | { kind: "month"; key: string; depth: number; label: string; count: number; nodeKey: string }
  | { kind: "day"; key: string; depth: number; label: string; count: number; nodeKey: string }
  | { kind: "kindGroup"; key: string; depth: number; label: string; icon: string; count: number; nodeKey: string }
  | { kind: "asset"; key: string; depth: number; asset: Asset }
  | { kind: "loading"; key: string; depth: number };

interface Props {
  tree: DateTreeData | null;
  loading: boolean;
  filter: AssetFilter;
  selected: Asset | null;
  onSelect: (a: Asset) => void;
  onVisibleAssetsChange?: (assets: Asset[]) => void;
  onRename?: (asset: Asset, newName: string) => void;
  refreshToken?: number;
}

export function DateTree({
  tree,
  loading,
  filter,
  selected,
  onSelect,
  onVisibleAssetsChange,
  onRename,
  refreshToken,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [assetsByKey, setAssetsByKey] = useState<Map<string, Asset[]>>(new Map());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Asset[] | null>(null);
  // Key of the keyboard-focused row (stable across expand/collapse re-flattening).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Inline rename state: which asset id is being edited and its draft value.
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  // Right-click context menu anchored on an asset row.
  const [menu, setMenu] = useState<{ x: number; y: number; asset: Asset } | null>(null);
  const skipBlurRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Global shortcuts: Cmd/Ctrl+F or "/" focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = useCallback((nodeKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(nodeKey) ? next.delete(nodeKey) : next.add(nodeKey);
      return next;
    });
  }, []);

  // All year/month/day node keys. "Expand all" opens the calendar down to the
  // day level (revealing every kind group) without eagerly loading the
  // individual asset lists under each kind — that stays lazy on click.
  const allExpandableKeys = useMemo(() => {
    if (!tree) return [];
    const keys: string[] = [];
    for (const yn of tree.years) {
      const yKey = `y:${yn.year}`;
      keys.push(yKey);
      for (const mn of yn.months) {
        const mKey = `${yKey}:m:${mn.month}`;
        keys.push(mKey);
        for (const dn of mn.days) {
          keys.push(`${mKey}:d:${dn.day}`);
        }
      }
    }
    return keys;
  }, [tree]);

  const expandAll = useCallback(
    () => setExpanded(new Set(allExpandableKeys)),
    [allExpandableKeys]
  );
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // The node's own key plus every date node beneath it (down to the day level).
  const subtreeKeysFor = useCallback(
    (nodeKey: string) =>
      allExpandableKeys.filter((k) => k === nodeKey || k.startsWith(nodeKey + ":")),
    [allExpandableKeys]
  );

  // Reset cached asset lists when the tree identity changes or after an edit.
  useEffect(() => {
    setAssetsByKey(new Map());
    setLoadingKeys(new Set());
  }, [filter, tree?.total, refreshToken]);

  // Debounced name search across the whole index.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await searchAssets(q, filter);
        if (!cancelled) setSearchResults(res);
      } catch (e) {
        console.error("search failed", e);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, filter]);

  const loadAssets = useCallback(
    async (nodeKey: string, y: number, m: number, d: number, k: Kind) => {
      setLoadingKeys((s) => new Set(s).add(nodeKey));
      try {
        const rows = await listAssets({ year: y, month: m, day: d, kind: k, filter });
        setAssetsByKey((prev) => new Map(prev).set(nodeKey, rows));
      } catch (e) {
        console.error("list_assets failed", e);
      } finally {
        setLoadingKeys((s) => {
          const n = new Set(s);
          n.delete(nodeKey);
          return n;
        });
      }
    },
    [filter]
  );

  // The kind-group node keys under a given day (e.g. its Photos/Videos rows),
  // with the info needed to lazily load each group's assets.
  const dayKindKeys = useCallback(
    (dayKey: string) => {
      const parts = dayKey.split(":"); // y:Y:m:M:d:D
      const y = Number(parts[1]);
      const m = Number(parts[3]);
      const d = Number(parts[5]);
      const dn = tree?.years
        .find((n) => n.year === y)
        ?.months.find((n) => n.month === m)
        ?.days.find((n) => n.day === d);
      return (dn?.kinds ?? []).map((kc) => ({
        kindKey: `${dayKey}:k:${kc.kind}`,
        y,
        m,
        d,
        k: kc.kind,
      }));
    },
    [tree]
  );

  // The full set of node keys an "expand all" on this row toggles: date nodes
  // for a year/month (down to the day level), or the day plus its kind groups.
  const subtreeToggleKeys = useCallback(
    (row: Row): string[] => {
      if (row.kind === "day") {
        return [row.nodeKey, ...dayKindKeys(row.nodeKey).map((x) => x.kindKey)];
      }
      if (row.kind === "year" || row.kind === "month") {
        return subtreeKeysFor(row.nodeKey);
      }
      return [];
    },
    [dayKindKeys, subtreeKeysFor]
  );

  // Expand or collapse an entire branch (a whole year, month, or day). Expanding
  // a day also loads its kind groups' assets so nothing is left "loading".
  const toggleSubtree = useCallback(
    (row: Row) => {
      const keys = subtreeToggleKeys(row);
      if (keys.length === 0) return;
      const fully = keys.every((k) => expanded.has(k));
      if (!fully && row.kind === "day") {
        for (const { kindKey, y, m, d, k } of dayKindKeys(row.nodeKey)) {
          if (!assetsByKey.has(kindKey) && !loadingKeys.has(kindKey)) {
            loadAssets(kindKey, y, m, d, k);
          }
        }
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        keys.forEach((k) => (fully ? next.delete(k) : next.add(k)));
        return next;
      });
    },
    [subtreeToggleKeys, dayKindKeys, expanded, assetsByKey, loadingKeys, loadAssets]
  );

  // Flatten the expanded tree into a linear list of rows for virtualization.
  const rows = useMemo<Row[]>(() => {
    if (searchResults) {
      return searchResults.map((a) => ({
        kind: "asset" as const,
        key: `s:${a.id}`,
        depth: 0,
        asset: a,
      }));
    }
    if (!tree) return [];
    const out: Row[] = [];
    for (const yn of tree.years) {
      const yKey = `y:${yn.year}`;
      out.push({
        kind: "year",
        key: yKey,
        nodeKey: yKey,
        depth: 0,
        label: String(yn.year),
        count: yn.count,
      });
      if (!expanded.has(yKey)) continue;
      for (const mn of yn.months) {
        const mKey = `${yKey}:m:${mn.month}`;
        out.push({
          kind: "month",
          key: mKey,
          nodeKey: mKey,
          depth: 1,
          label: MONTHS[mn.month - 1],
          count: mn.count,
        });
        if (!expanded.has(mKey)) continue;
        for (const dn of mn.days) {
          const dKey = `${mKey}:d:${dn.day}`;
          out.push({
            kind: "day",
            key: dKey,
            nodeKey: dKey,
            depth: 2,
            label: `${MONTHS[mn.month - 1].slice(0, 3)} ${dn.day}`,
            count: dn.count,
          });
          if (!expanded.has(dKey)) continue;
          for (const kn of dn.kinds) {
            const kKey = `${dKey}:k:${kn.kind}`;
            const meta = KIND_META[kn.kind];
            out.push({
              kind: "kindGroup",
              key: kKey,
              nodeKey: kKey,
              depth: 3,
              label: meta.label,
              icon: meta.icon,
              count: kn.count,
            });
            if (!expanded.has(kKey)) continue;
            const assets = assetsByKey.get(kKey);
            if (assets) {
              for (const a of assets) {
                out.push({ kind: "asset", key: `a:${a.id}`, depth: 4, asset: a });
              }
            } else {
              out.push({ kind: "loading", key: `l:${kKey}`, depth: 4 });
            }
          }
        }
      }
    }
    return out;
  }, [tree, expanded, assetsByKey, searchResults]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const onRowClick = useCallback(
    (row: Row) => {
      setActiveKey(row.key);
      if (row.kind === "asset") {
        onSelect(row.asset);
        return;
      }
      if (row.kind === "loading") return;
      // Expand/collapse and lazily load assets for kind groups.
      if (row.kind === "kindGroup") {
        const willOpen = !expanded.has(row.nodeKey);
        toggle(row.nodeKey);
        if (willOpen && !assetsByKey.has(row.nodeKey) && !loadingKeys.has(row.nodeKey)) {
          // parse y/m/d/k out of the node key: y:2024:m:5:d:12:k:image
          const parts = row.nodeKey.split(":");
          const y = Number(parts[1]);
          const m = Number(parts[3]);
          const d = Number(parts[5]);
          const k = parts[7] as Kind;
          loadAssets(row.nodeKey, y, m, d, k);
        }
        return;
      }
      toggle(row.nodeKey);
    },
    [expanded, toggle, assetsByKey, loadingKeys, loadAssets, onSelect]
  );

  const items = virtualizer.getVirtualItems();
  const treeInteractive = !searchResults && !!tree && tree.total > 0;
  const anyExpanded = expanded.size > 0;

  // Move keyboard focus to a row, scroll it into view, and (for assets) preview
  // it live — like arrowing through Photos.
  const focusRow = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, idx));
      const r = rows[clamped];
      if (!r) return;
      setActiveKey(r.key);
      virtualizer.scrollToIndex(clamped, { align: "auto" });
      if (r.kind === "asset") onSelect(r.asset);
    },
    [rows, virtualizer, onSelect]
  );

  // Nearest ancestor row = the closest previous row at a shallower depth.
  const parentIndexOf = useCallback(
    (idx: number) => {
      const d = rows[idx].depth;
      for (let i = idx - 1; i >= 0; i--) {
        if (rows[i].depth < d) return i;
      }
      return -1;
    },
    [rows]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!rows.length) return;
      const curIdx = activeKey ? rows.findIndex((r) => r.key === activeKey) : -1;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusRow(curIdx < 0 ? 0 : curIdx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusRow(curIdx < 0 ? 0 : curIdx - 1);
          break;
        case "Home":
          e.preventDefault();
          focusRow(0);
          break;
        case "End":
          e.preventDefault();
          focusRow(rows.length - 1);
          break;
        case "ArrowRight": {
          e.preventDefault();
          if (curIdx < 0) {
            focusRow(0);
            break;
          }
          const r = rows[curIdx];
          if (r.kind === "asset" || r.kind === "loading") break;
          if (!expanded.has(r.nodeKey)) onRowClick(r); // expand (loads if kind group)
          else focusRow(curIdx + 1); // already open → step into first child
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (curIdx < 0) {
            focusRow(0);
            break;
          }
          const r = rows[curIdx];
          if (r.kind !== "asset" && r.kind !== "loading" && expanded.has(r.nodeKey)) {
            toggle(r.nodeKey); // collapse
          } else {
            const p = parentIndexOf(curIdx);
            if (p >= 0) focusRow(p); // hop to parent
          }
          break;
        }
        case "Enter":
        case " ":
          e.preventDefault();
          if (curIdx < 0) focusRow(0);
          else onRowClick(rows[curIdx]);
          break;
      }
    },
    [rows, activeKey, expanded, focusRow, parentIndexOf, onRowClick, toggle]
  );

  // Keep a valid focused row; focus the tree on first load so arrows work
  // immediately (without stealing focus from the search box).
  useEffect(() => {
    if (!rows.length) return;
    const valid = activeKey && rows.some((r) => r.key === activeKey);
    if (!valid) {
      setActiveKey(rows[0].key);
      if (!activeKey) {
        const ae = document.activeElement;
        if (!ae || ae === document.body) scrollRef.current?.focus();
      }
    }
  }, [rows, activeKey]);

  // Report the ordered visible assets up so the preview pane can step through
  // the same sequence the tree shows.
  const visibleAssets = useMemo(
    () =>
      rows.flatMap((r) => (r.kind === "asset" ? [r.asset] : [])),
    [rows]
  );
  useEffect(() => {
    onVisibleAssetsChange?.(visibleAssets);
  }, [visibleAssets, onVisibleAssetsChange]);

  // When selection changes from elsewhere (e.g. prev/next in the preview),
  // move the tree's focus ring to match and scroll it into view.
  useEffect(() => {
    if (!selected) return;
    const idx = rows.findIndex(
      (r) => r.kind === "asset" && r.asset.id === selected.id
    );
    if (idx >= 0 && rows[idx].key !== activeKey) {
      setActiveKey(rows[idx].key);
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selected, rows, activeKey, virtualizer]);

  return (
    <>
      <div className="sidebar-head">
        <input
          ref={searchRef}
          className="sidebar-search"
          placeholder="Search by name…   ( / )"
          aria-label="Search assets by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (query) setQuery("");
              else scrollRef.current?.focus();
            } else if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              scrollRef.current?.focus();
              focusRow(0);
            }
          }}
        />
        <button
          className="icon-btn"
          title={anyExpanded ? "Collapse all" : "Expand all"}
          aria-label={anyExpanded ? "Collapse all" : "Expand all"}
          disabled={!treeInteractive}
          onClick={anyExpanded ? collapseAll : expandAll}
        >
          {anyExpanded ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      </div>

      {searchResults && (
        <div className="index-status">
          {searchResults.length.toLocaleString()} result
          {searchResults.length === 1 ? "" : "s"} for “{query.trim()}”
        </div>
      )}

      <div
        className="tree-scroll"
        ref={scrollRef}
        tabIndex={0}
        role="tree"
        aria-label="Assets by date"
        onKeyDown={handleKeyDown}
        style={{ outline: "none" }}
      >
        {rows.length === 0 && !loading && (
          <div style={{ padding: 24, color: "var(--text-faint)", textAlign: "center" }}>
            {searchResults
              ? "No matching assets."
              : tree && tree.total === 0
                ? "No assets found in this range."
                : "No assets yet."}
          </div>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {items.map((vi) => {
            const row = rows[vi.index];
            const isOpen =
              row.kind !== "asset" && row.kind !== "loading" && expanded.has(row.nodeKey);
            const isSelected = row.kind === "asset" && selected?.id === row.asset.id;
            const hasChildren = row.kind !== "asset" && row.kind !== "loading";
            // Branch fold/unfold appears on every folder row — years, months
            // and days (a day expands/collapses its kind groups).
            const subtreeKeys = subtreeToggleKeys(row);
            const showSubtreeBtn = subtreeKeys.length > 0;
            const subtreeFully =
              showSubtreeBtn && subtreeKeys.every((k) => expanded.has(k));
            return (
              <div
                key={row.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: ROW_H,
                  transform: `translateY(${vi.start}px)`,
                  paddingLeft: 8 + (searchResults ? 4 : row.depth * 15),
                }}
              >
                <div
                  className={
                    "tree-row " +
                    (row.kind === "year"
                      ? "tree-year "
                      : row.kind === "month"
                        ? "tree-month "
                        : row.kind === "kindGroup"
                          ? "tree-kind "
                          : row.kind === "asset"
                            ? "tree-asset "
                            : "") +
                    (isSelected ? "selected " : "") +
                    (activeKey === row.key ? "focused" : "")
                  }
                  onClick={() => onRowClick(row)}
                  onContextMenu={
                    row.kind === "asset"
                      ? (e) => {
                          e.preventDefault();
                          onSelect((row as Extract<Row, { kind: "asset" }>).asset);
                          setMenu({
                            x: e.clientX,
                            y: e.clientY,
                            asset: (row as Extract<Row, { kind: "asset" }>).asset,
                          });
                        }
                      : undefined
                  }
                >
                  {hasChildren ? (
                    <span className={`tree-caret ${isOpen ? "open" : ""}`}>▶</span>
                  ) : (
                    <span className="tree-caret leaf">▶</span>
                  )}

                  {row.kind === "asset" ? (
                    <>
                      <AssetThumb asset={row.asset} />
                      {editing?.id === row.asset.id ? (
                        <input
                          className="rename-input"
                          value={editing.value}
                          autoFocus
                          onFocus={(e) => e.currentTarget.select()}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            setEditing({ id: row.asset.id, value: e.target.value })
                          }
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              skipBlurRef.current = true;
                              onRename?.(row.asset, editing.value);
                              setEditing(null);
                            } else if (e.key === "Escape") {
                              skipBlurRef.current = true;
                              setEditing(null);
                            }
                          }}
                          onBlur={() => {
                            if (skipBlurRef.current) {
                              skipBlurRef.current = false;
                              return;
                            }
                            onRename?.(row.asset, editing.value);
                            setEditing(null);
                          }}
                        />
                      ) : (
                        <span
                          className="asset-name"
                          title={row.asset.name}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditing({ id: row.asset.id, value: row.asset.name });
                          }}
                        >
                          {row.asset.name}
                        </span>
                      )}
                      {row.asset.favorite && <span className="fav-star">★</span>}
                    </>
                  ) : row.kind === "loading" ? (
                    <span className="tree-label" style={{ color: "var(--text-faint)" }}>
                      <span className="spinner" style={{ display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
                      Loading…
                    </span>
                  ) : (
                    <>
                      {row.kind === "kindGroup" && (
                        <span className="kind-ico">{row.icon}</span>
                      )}
                      <span className="tree-label">{row.label}</span>
                      <span className="tree-count">
                        {row.count.toLocaleString()}
                      </span>
                      {showSubtreeBtn && (
                        <button
                          className="subtree-btn"
                          tabIndex={-1}
                          title={subtreeFully ? "Collapse this branch" : "Expand this branch"}
                          aria-label={subtreeFully ? "Collapse this branch" : "Expand this branch"}
                          onKeyDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSubtree(row);
                          }}
                        >
                          {subtreeFully ? <CollapseIcon size={13} /> : <ExpandIcon size={13} />}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Copy name",
              onClick: () => navigator.clipboard?.writeText(menu.asset.name),
            },
            {
              label: "Copy path",
              onClick: () => navigator.clipboard?.writeText(menu.asset.path),
            },
            {
              label: "Reveal in Finder",
              onClick: () => revealInFinder(menu.asset.path),
            },
            {
              label: "Rename",
              onClick: () =>
                setEditing({ id: menu.asset.id, value: menu.asset.name }),
            },
          ]}
        />
      )}
    </>
  );
}
