import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listAssets, searchAssets } from "../api";
import type {
  Asset,
  DateRange,
  DateTree as DateTreeData,
  Kind,
} from "../types";
import { AssetThumb } from "./AssetThumb";

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
  range: DateRange;
  selected: Asset | null;
  onSelect: (a: Asset) => void;
}

export function DateTree({ tree, loading, range, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [assetsByKey, setAssetsByKey] = useState<Map<string, Asset[]>>(new Map());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Asset[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Reset cached asset lists whenever the tree identity (root/range) changes.
  useEffect(() => {
    setAssetsByKey(new Map());
    setLoadingKeys(new Set());
  }, [range, tree?.total]);

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
        const res = await searchAssets(q, range);
        if (!cancelled) setSearchResults(res);
      } catch (e) {
        console.error("search failed", e);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, range]);

  const loadAssets = useCallback(
    async (nodeKey: string, y: number, m: number, d: number, k: Kind) => {
      setLoadingKeys((s) => new Set(s).add(nodeKey));
      try {
        const rows = await listAssets({ year: y, month: m, day: d, kind: k, range });
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
    [range]
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

  return (
    <>
      <div className="sidebar-head">
        <input
          className="sidebar-search"
          placeholder="Search by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="icon-btn"
          title={anyExpanded ? "Collapse all" : "Expand all"}
          aria-label={anyExpanded ? "Collapse all" : "Expand all"}
          disabled={!treeInteractive}
          onClick={anyExpanded ? collapseAll : expandAll}
        >
          {anyExpanded ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 9l4 4 4-4" />
              <path d="M8 15l4-4 4 4" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 8l4-4 4 4" />
              <path d="M8 16l4 4 4-4" />
            </svg>
          )}
        </button>
      </div>

      {searchResults && (
        <div className="index-status">
          {searchResults.length.toLocaleString()} result
          {searchResults.length === 1 ? "" : "s"} for “{query.trim()}”
        </div>
      )}

      <div className="tree-scroll" ref={scrollRef}>
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
                    (isSelected ? "selected" : "")
                  }
                  onClick={() => onRowClick(row)}
                >
                  {hasChildren ? (
                    <span className={`tree-caret ${isOpen ? "open" : ""}`}>▶</span>
                  ) : (
                    <span className="tree-caret leaf">▶</span>
                  )}

                  {row.kind === "asset" ? (
                    <>
                      <AssetThumb asset={row.asset} />
                      <span className="asset-name" title={row.asset.name}>
                        {row.asset.name}
                      </span>
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
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
