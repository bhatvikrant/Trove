import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navbar } from "./components/Navbar";
import { DateTree } from "./components/DateTree";
import { PreviewPane } from "./components/PreviewPane";
import { message } from "@tauri-apps/plugin-dialog";
import {
  getDateTree,
  onIndexProgress,
  pickFolder,
  renameAsset,
  rescan,
  setRoot,
} from "./api";
import type {
  Asset,
  DateRange,
  DateTree as DateTreeData,
  IndexProgress,
} from "./types";

const EMPTY_RANGE: DateRange = { start: null, end: null };

export default function App() {
  const [root, setRootPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [range, setRange] = useState<DateRange>(EMPTY_RANGE);
  const [tree, setTree] = useState<DateTreeData | null>(null);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [sidebarW, setSidebarW] = useState(340);
  const [loadingTree, setLoadingTree] = useState(false);
  // The ordered assets currently visible in the tree, reported up by DateTree,
  // so the preview pane can step to the one before/after the selected asset.
  const [visibleAssets, setVisibleAssets] = useState<Asset[]>([]);
  // Bumped after a rename/delete to force the tree to re-fetch cached lists.
  const [dataVersion, setDataVersion] = useState(0);

  const handleRename = useCallback(
    async (asset: Asset, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === asset.name) return;
      try {
        const updated = await renameAsset(asset.path, trimmed);
        setSelected((cur) => (cur && cur.id === updated.id ? updated : cur));
        setDataVersion((v) => v + 1);
      } catch (e) {
        await message(String(e), { title: "Couldn’t rename", kind: "error" });
      }
    },
    []
  );

  const position = useMemo(() => {
    if (!selected) return null;
    const index = visibleAssets.findIndex((a) => a.id === selected.id);
    return index < 0 ? null : { index, total: visibleAssets.length };
  }, [selected, visibleAssets]);

  // The assets immediately before/after the selected one — the preview pane
  // prefetches these so stepping is instant.
  const neighbors = useMemo(() => {
    if (!position || visibleAssets.length < 2) return { prev: null, next: null };
    const n = visibleAssets.length;
    return {
      prev: visibleAssets[(position.index - 1 + n) % n],
      next: visibleAssets[(position.index + 1) % n],
    };
  }, [position, visibleAssets]);

  // Move selection to the asset `delta` steps away, wrapping around the ends.
  const selectRelative = useCallback(
    (delta: number) => {
      setSelected((cur) => {
        if (!cur || visibleAssets.length === 0) return cur;
        const idx = visibleAssets.findIndex((a) => a.id === cur.id);
        if (idx < 0) return cur;
        const n = visibleAssets.length;
        return visibleAssets[(idx + delta + n) % n];
      });
    },
    [visibleAssets]
  );

  // Keep a ref so the debounced tree refresh always sees the latest range.
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const refreshTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const t = await getDateTree(rangeRef.current);
      setTree(t);
    } catch (e) {
      console.error("get_date_tree failed", e);
    } finally {
      setLoadingTree(false);
    }
  }, []);

  // Subscribe to indexing progress; refresh the tree as items stream in.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let lastRefresh = 0;
    onIndexProgress((p) => {
      setProgress(p);
      const now = performance.now();
      // Throttle live refreshes while scanning; always refresh on completion.
      if (p.done || now - lastRefresh > 700) {
        lastRefresh = now;
        refreshTree();
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [refreshTree]);

  // Re-query the tree whenever the date range changes.
  useEffect(() => {
    if (root) refreshTree();
  }, [range, root, refreshTree]);

  const handlePickFolder = useCallback(async () => {
    const folder = await pickFolder();
    if (!folder) return;
    setRootPath(folder);
    setSelected(null);
    setTree(null);
    setProgress({ scanned: 0, indexed: 0, total: null, done: false });
    await setRoot(folder);
  }, []);

  const handleRescan = useCallback(async () => {
    if (!root) return;
    setProgress({ scanned: 0, indexed: 0, total: null, done: false });
    await rescan();
  }, [root]);

  const indexing = !!progress && !progress.done;

  const onResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = (e.currentTarget.previousElementSibling as HTMLElement)
      .offsetWidth;
    const move = (ev: MouseEvent) => {
      const next = Math.min(
        Math.max(startW + (ev.clientX - startX), 220),
        window.innerWidth * 0.6
      );
      setSidebarW(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);

  const total = tree?.total ?? 0;

  const progressPct = useMemo(() => {
    if (!progress || progress.done) return 0;
    if (!progress.total) return null; // indeterminate
    return Math.min(100, (progress.scanned / progress.total) * 100);
  }, [progress]);

  return (
    <div className="app">
      <Navbar
        root={root}
        range={range}
        onRange={setRange}
        onPickFolder={handlePickFolder}
        onRescan={handleRescan}
        canRescan={!!root && !indexing}
      />

      <div className={`progress ${indexing ? "" : "hidden"}`}>
        {progressPct === null ? (
          <div className="bar" style={{ width: "100%", opacity: 0.4 }} />
        ) : (
          <div className="bar" style={{ width: `${progressPct}%` }} />
        )}
      </div>

      <div className="body">
        {root ? (
          <>
            <div className="sidebar" style={{ width: sidebarW }}>
              {indexing && (
                <div className="index-status">
                  <span className="spinner" />
                  Indexing… {progress?.indexed.toLocaleString()} assets
                  {progress?.total ? ` of ~${progress.total.toLocaleString()}` : ""}
                </div>
              )}
              <DateTree
                tree={tree}
                loading={loadingTree}
                range={range}
                selected={selected}
                onSelect={setSelected}
                onVisibleAssetsChange={setVisibleAssets}
                onRename={handleRename}
                refreshToken={dataVersion}
              />
            </div>
            <div className="resizer" onMouseDown={onResize} />
            <PreviewPane
              asset={selected}
              total={total}
              position={position}
              onNavigate={selectRelative}
              prevAsset={neighbors.prev}
              nextAsset={neighbors.next}
              onRename={handleRename}
            />
          </>
        ) : (
          <div className="empty">
            <div className="glyph">🗂️</div>
            <h2>No folder open</h2>
            <p>
              Point Assets Viewer at a folder — a local directory or a connected
              SSD — and it will index your photos, videos, audio and PDFs by the
              date they were captured.
            </p>
            <button className="btn primary" onClick={handlePickFolder}>
              Choose Folder…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
