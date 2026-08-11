import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listPlaceAssets } from "../api";
import type { Asset, AssetFilter, Places } from "../types";
import { AssetThumb } from "./AssetThumb";

const ROW_H = 30;
const NOLOC = "__noloc__";

type Row =
  | { kind: "country"; key: string; country: string; count: number; depth: 0 }
  | { kind: "city"; key: string; country: string; city: string; count: number; depth: 1 }
  | { kind: "noloc"; key: string; count: number; depth: 0 }
  | { kind: "asset"; key: string; depth: number; asset: Asset }
  | { kind: "loading"; key: string; depth: number };

interface Props {
  places: Places | null;
  filter: AssetFilter;
  selected: Asset | null;
  onSelect: (a: Asset) => void;
  onVisibleAssetsChange?: (assets: Asset[]) => void;
  focusPlace?: { country: string; city?: string } | null;
  refreshToken?: number;
  /** Asset ids to hide (e.g. pending an undoable delete). */
  hiddenIds?: Set<number>;
}

export function PlacesTree({
  places,
  filter,
  selected,
  onSelect,
  onVisibleAssetsChange,
  focusPlace,
  refreshToken,
  hiddenIds,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [assetsByKey, setAssetsByKey] = useState<Map<string, Asset[]>>(new Map());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-fetch the currently-expanded place nodes in place after an edit / filter
  // / data change, rather than clearing them (which left them stuck on
  // "Loading…" until the user re-expanded).
  useEffect(() => {
    if (!places) {
      setAssetsByKey(new Map());
      setLoadingKeys(new Set());
      return;
    }
    const toLoad: { key: string; country: string | null; city: string | null }[] = [];
    for (const co of places.countries) {
      const cKey = `C:${co.country}`;
      if (!expanded.has(cKey)) continue;
      for (const ci of co.cities) {
        const ciKey = `${cKey}:${ci.city}`;
        if (expanded.has(ciKey)) toLoad.push({ key: ciKey, country: co.country, city: ci.city });
      }
    }
    if (expanded.has(NOLOC)) toLoad.push({ key: NOLOC, country: null, city: null });
    if (toLoad.length === 0) {
      setAssetsByKey(new Map());
      setLoadingKeys(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        toLoad.map(async (t) => {
          try {
            const rows = await listPlaceAssets({ country: t.country, city: t.city, filter });
            return [t.key, rows] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const next = new Map<string, Asset[]>();
      for (const e of entries) if (e) next.set(e[0], e[1]);
      setAssetsByKey(next);
      setLoadingKeys(new Set());
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, places?.total, refreshToken]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const loadAssets = useCallback(
    async (cacheKey: string, country: string | null, city: string | null) => {
      setLoadingKeys((s) => new Set(s).add(cacheKey));
      try {
        const rows = await listPlaceAssets({ country, city, filter });
        setAssetsByKey((prev) => new Map(prev).set(cacheKey, rows));
      } catch (e) {
        console.error("list_place_assets failed", e);
      } finally {
        setLoadingKeys((s) => {
          const n = new Set(s);
          n.delete(cacheKey);
          return n;
        });
      }
    },
    [filter]
  );

  const rows = useMemo<Row[]>(() => {
    if (!places) return [];
    const out: Row[] = [];
    for (const co of places.countries) {
      const cKey = `C:${co.country}`;
      out.push({ kind: "country", key: cKey, country: co.country, count: co.count, depth: 0 });
      if (!expanded.has(cKey)) continue;
      for (const ci of co.cities) {
        const ciKey = `${cKey}:${ci.city}`;
        out.push({
          kind: "city",
          key: ciKey,
          country: co.country,
          city: ci.city,
          count: ci.count,
          depth: 1,
        });
        if (!expanded.has(ciKey)) continue;
        const assets = assetsByKey.get(ciKey);
        if (assets) {
          for (const a of assets) {
            if (hiddenIds?.has(a.id)) continue;
            out.push({ kind: "asset", key: `a:${a.id}`, depth: 2, asset: a });
          }
        } else {
          out.push({ kind: "loading", key: `l:${ciKey}`, depth: 2 });
        }
      }
    }
    if (places.noLocation > 0) {
      out.push({ kind: "noloc", key: NOLOC, count: places.noLocation, depth: 0 });
      if (expanded.has(NOLOC)) {
        const assets = assetsByKey.get(NOLOC);
        if (assets) {
          for (const a of assets) {
            if (hiddenIds?.has(a.id)) continue;
            out.push({ kind: "asset", key: `a:${a.id}`, depth: 1, asset: a });
          }
        } else {
          out.push({ kind: "loading", key: `l:${NOLOC}`, depth: 1 });
        }
      }
    }
    return out;
  }, [places, expanded, assetsByKey, hiddenIds]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const openCity = useCallback(
    (country: string, city: string) => {
      const key = `C:${country}:${city}`;
      setExpanded((s) => new Set(s).add(`C:${country}`).add(key));
      if (!assetsByKey.has(key) && !loadingKeys.has(key)) loadAssets(key, country, city);
    },
    [assetsByKey, loadingKeys, loadAssets]
  );

  const onRowClick = useCallback(
    (row: Row) => {
      setActiveKey(row.key);
      if (row.kind === "asset") {
        onSelect(row.asset);
      } else if (row.kind === "country") {
        toggle(row.key);
      } else if (row.kind === "city") {
        const willOpen = !expanded.has(row.key);
        toggle(row.key);
        const cacheKey = row.key;
        if (willOpen && !assetsByKey.has(cacheKey) && !loadingKeys.has(cacheKey))
          loadAssets(cacheKey, row.country, row.city);
      } else if (row.kind === "noloc") {
        const willOpen = !expanded.has(NOLOC);
        toggle(NOLOC);
        if (willOpen && !assetsByKey.has(NOLOC) && !loadingKeys.has(NOLOC))
          loadAssets(NOLOC, null, null);
      }
    },
    [expanded, toggle, assetsByKey, loadingKeys, loadAssets, onSelect]
  );

  // Focus a place when the map asks (expand + scroll to it).
  useEffect(() => {
    if (!focusPlace) return;
    if (focusPlace.city) openCity(focusPlace.country, focusPlace.city);
    else setExpanded((s) => new Set(s).add(`C:${focusPlace.country}`));
    const key = focusPlace.city
      ? `C:${focusPlace.country}:${focusPlace.city}`
      : `C:${focusPlace.country}`;
    setActiveKey(key);
    // scroll after the row appears
    setTimeout(() => {
      const idx = rows.findIndex((r) => r.key === key);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
    }, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPlace]);

  const visibleAssets = useMemo(
    () => rows.flatMap((r) => (r.kind === "asset" ? [r.asset] : [])),
    [rows]
  );
  useEffect(() => {
    onVisibleAssetsChange?.(visibleAssets);
  }, [visibleAssets, onVisibleAssetsChange]);

  useEffect(() => {
    if (!selected) return;
    const idx = rows.findIndex((r) => r.kind === "asset" && r.asset.id === selected.id);
    if (idx >= 0 && rows[idx].key !== activeKey) setActiveKey(rows[idx].key);
  }, [selected, rows, activeKey]);

  const items = virtualizer.getVirtualItems();

  if (places && places.total === 0) {
    return (
      <div className="tree-scroll">
        <div style={{ padding: 24, color: "var(--text-faint)", textAlign: "center" }}>
          No assets in this filter.
        </div>
      </div>
    );
  }

  return (
    <div className="tree-scroll" ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {items.map((vi) => {
          const row = rows[vi.index];
          const isOpen =
            (row.kind === "country" || row.kind === "city" || row.kind === "noloc") &&
            expanded.has(row.key);
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
                paddingLeft: 8 + row.depth * 15,
              }}
            >
              <div
                className={
                  "tree-row " +
                  (row.kind === "country" ? "tree-year " : row.kind === "asset" ? "tree-asset " : "") +
                  (activeKey === row.key ? "focused " : "") +
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
                    {row.asset.favorite && <span className="fav-star">★</span>}
                  </>
                ) : row.kind === "loading" ? (
                  <span className="tree-label" style={{ color: "var(--text-faint)" }}>
                    <span className="spinner" style={{ display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
                    Loading…
                  </span>
                ) : (
                  <>
                    <span className="kind-ico">
                      {row.kind === "country" ? "🏳️" : row.kind === "noloc" ? "🚫" : "📍"}
                    </span>
                    <span className="tree-label">
                      {row.kind === "noloc" ? "No location" : row.kind === "country" ? row.country : row.city}
                    </span>
                    <span className="tree-count">{row.count.toLocaleString()}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
