import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listPersonAssets } from "../api";
import type { Asset, AssetFilter, Person } from "../types";
import { AssetThumb } from "./AssetThumb";
import { FaceThumb } from "./FaceThumb";

const ROW_H = 30;
const PERSON_ROW_H = 44;

type Row =
  | { kind: "person"; key: string; person: Person }
  | { kind: "asset"; key: string; asset: Asset }
  | { kind: "loading"; key: string; count: number };

interface Props {
  people: Person[] | null;
  filter: AssetFilter;
  selected: Asset | null;
  onSelect: (a: Asset) => void;
  onVisibleAssetsChange?: (assets: Asset[]) => void;
  onRename: (clusterId: number, name: string) => void;
  onRenameAsset?: (asset: Asset, newName: string) => void;
  focusPerson?: { clusterId: number } | null;
  refreshToken?: number;
}

export function PeopleTree({
  people,
  filter,
  selected,
  onSelect,
  onVisibleAssetsChange,
  onRename,
  onRenameAsset,
  focusPerson,
  refreshToken,
}: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [assetsByKey, setAssetsByKey] = useState<Map<number, Asset[]>>(new Map());
  const [loadingKeys, setLoadingKeys] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [editingAsset, setEditingAsset] = useState<{ id: number; value: string } | null>(null);
  const skipBlur = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-fetch the currently-expanded people in place after an edit / filter
  // change, rather than clearing them (which left them stuck on "Loading…").
  useEffect(() => {
    const ids = [...expanded];
    if (ids.length === 0) {
      setAssetsByKey(new Map());
      setLoadingKeys(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        ids.map(async (clusterId) => {
          try {
            const rows = await listPersonAssets({ clusterId, filter });
            return [clusterId, rows] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const next = new Map<number, Asset[]>();
      for (const e of entries) if (e) next.set(e[0], e[1]);
      setAssetsByKey(next);
      setLoadingKeys(new Set());
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, refreshToken]);

  const loadAssets = useCallback(
    async (clusterId: number) => {
      setLoadingKeys((s) => new Set(s).add(clusterId));
      try {
        const rows = await listPersonAssets({ clusterId, filter });
        setAssetsByKey((prev) => new Map(prev).set(clusterId, rows));
      } catch (e) {
        console.error("list_person_assets failed", e);
      } finally {
        setLoadingKeys((s) => {
          const n = new Set(s);
          n.delete(clusterId);
          return n;
        });
      }
    },
    [filter]
  );

  const toggle = useCallback(
    (clusterId: number) => {
      const willOpen = !expanded.has(clusterId);
      setExpanded((prev) => {
        const n = new Set(prev);
        n.has(clusterId) ? n.delete(clusterId) : n.add(clusterId);
        return n;
      });
      if (willOpen && !assetsByKey.has(clusterId) && !loadingKeys.has(clusterId))
        loadAssets(clusterId);
    },
    [expanded, assetsByKey, loadingKeys, loadAssets]
  );

  const rows = useMemo<Row[]>(() => {
    if (!people) return [];
    const out: Row[] = [];
    for (const p of people) {
      out.push({ kind: "person", key: `p:${p.clusterId}`, person: p });
      if (expanded.has(p.clusterId)) {
        const assets = assetsByKey.get(p.clusterId);
        if (assets) {
          for (const a of assets) out.push({ kind: "asset", key: `a:${a.id}`, asset: a });
        } else {
          out.push({ kind: "loading", key: `l:${p.clusterId}`, count: p.count });
        }
      }
    }
    return out;
  }, [people, expanded, assetsByKey]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "person" ? PERSON_ROW_H : ROW_H),
    overscan: 10,
  });

  // Focus a person when the grid asks.
  useEffect(() => {
    if (!focusPerson) return;
    const { clusterId } = focusPerson;
    setExpanded((s) => new Set(s).add(clusterId));
    if (!assetsByKey.has(clusterId) && !loadingKeys.has(clusterId)) loadAssets(clusterId);
    setTimeout(() => {
      const idx = rows.findIndex((r) => r.key === `p:${clusterId}`);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
    }, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPerson]);

  const visibleAssets = useMemo(
    () => rows.flatMap((r) => (r.kind === "asset" ? [r.asset] : [])),
    [rows]
  );
  useEffect(() => {
    onVisibleAssetsChange?.(visibleAssets);
  }, [visibleAssets, onVisibleAssetsChange]);

  // Keep the selected row in view as the selection moves (prev/next in the
  // preview pane). Tracked by id so re-flattening the rows doesn't yank the
  // list back to a row the user has since scrolled away from.
  const scrolledToRef = useRef<number | null>(null);
  useEffect(() => {
    if (!selected) {
      scrolledToRef.current = null;
      return;
    }
    if (scrolledToRef.current === selected.id) return;
    const idx = rows.findIndex((r) => r.kind === "asset" && r.asset.id === selected.id);
    if (idx < 0) return;
    scrolledToRef.current = selected.id;
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selected, rows, virtualizer]);

  const commitRename = (clusterId: number) => {
    if (editing && editing.id === clusterId) onRename(clusterId, editing.value);
    setEditing(null);
  };

  const items = virtualizer.getVirtualItems();

  if (people && people.length === 0) {
    return (
      <div className="tree-scroll">
        <div style={{ padding: 24, color: "var(--text-faint)", textAlign: "center", lineHeight: 1.5 }}>
          No people found yet. They appear once photos have been analyzed.
        </div>
      </div>
    );
  }

  return (
    <div className="tree-scroll" ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {items.map((vi) => {
          const row = rows[vi.index];
          const isSelected = row.kind === "asset" && selected?.id === row.asset.id;
          return (
            <div
              key={row.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
                paddingLeft: row.kind === "asset" ? 24 : 8,
              }}
            >
              {row.kind === "person" ? (
                <div
                  className={`person-row ${
                    loadingKeys.has(row.person.clusterId) ? "loading" : ""
                  }`}
                  onClick={() => toggle(row.person.clusterId)}
                >
                  <span className={`tree-caret ${expanded.has(row.person.clusterId) ? "open" : ""}`}>▶</span>
                  <FaceThumb
                    path={row.person.path}
                    box={{ x: row.person.x, y: row.person.y, w: row.person.w, h: row.person.h }}
                  />
                  <span className="person-body">
                    {editing?.id === row.person.clusterId ? (
                      <input
                        className="rename-input"
                        value={editing.value}
                        autoFocus
                        placeholder="Name"
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditing({ id: row.person.clusterId, value: e.target.value })}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            skipBlur.current = true;
                            commitRename(row.person.clusterId);
                          } else if (e.key === "Escape") {
                            skipBlur.current = true;
                            setEditing(null);
                          }
                        }}
                        onBlur={() => {
                          if (skipBlur.current) {
                            skipBlur.current = false;
                            return;
                          }
                          commitRename(row.person.clusterId);
                        }}
                      />
                    ) : (
                      <span
                        className={`person-name ${row.person.name ? "" : "unnamed"}`}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditing({ id: row.person.clusterId, value: row.person.name ?? "" });
                        }}
                        title="Double-click to name"
                      >
                        {row.person.name ?? "Add name"}
                      </span>
                    )}
                    <span className="person-count">{row.person.count.toLocaleString()} photos</span>
                  </span>
                </div>
              ) : row.kind === "loading" ? (
                <div className="tree-row">
                  <span className="tree-caret leaf">▶</span>
                  <span className="tree-label" style={{ color: "var(--text-faint)" }}>
                    <span className="spinner" style={{ display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
                    Loading {row.count.toLocaleString()} item
                    {row.count === 1 ? "" : "s"}…
                  </span>
                </div>
              ) : (
                <div
                  className={`tree-row tree-asset ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelect(row.asset)}
                >
                  <span className="tree-caret leaf">▶</span>
                  <AssetThumb asset={row.asset} />
                  {editingAsset?.id === row.asset.id ? (
                    <input
                      className="rename-input"
                      value={editingAsset.value}
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setEditingAsset({ id: row.asset.id, value: e.target.value })
                      }
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          skipBlur.current = true;
                          onRenameAsset?.(row.asset, editingAsset.value);
                          setEditingAsset(null);
                        } else if (e.key === "Escape") {
                          skipBlur.current = true;
                          setEditingAsset(null);
                        }
                      }}
                      onBlur={() => {
                        if (skipBlur.current) {
                          skipBlur.current = false;
                          return;
                        }
                        onRenameAsset?.(row.asset, editingAsset.value);
                        setEditingAsset(null);
                      }}
                    />
                  ) : (
                    <span
                      className="asset-name"
                      title={row.asset.name}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingAsset({ id: row.asset.id, value: row.asset.name });
                      }}
                    >
                      {row.asset.name}
                    </span>
                  )}
                  {row.asset.favorite && <span className="fav-star">★</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
