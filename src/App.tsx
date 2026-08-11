import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navbar } from "./components/Navbar";
import { DateTree } from "./components/DateTree";
import { PreviewPane } from "./components/PreviewPane";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { EmptyState } from "./components/EmptyState";
import {
  deleteAsset,
  getDateTree,
  onIndexProgress,
  onMenuOpenFolder,
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
  // True while a folder is being dragged over the window.
  const [dragging, setDragging] = useState(false);

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

  const handleDelete = useCallback(
    async (asset: Asset) => {
      const ok = await confirm(`“${asset.name}” will be moved to the Trash.`, {
        title: "Delete asset",
        kind: "warning",
        okLabel: "Move to Trash",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      // Pick a neighbour to select next, before the row disappears.
      const idx = visibleAssets.findIndex((a) => a.id === asset.id);
      const nextSel =
        visibleAssets[idx + 1] ?? visibleAssets[idx - 1] ?? null;
      try {
        await deleteAsset(asset.path);
        setSelected(nextSel && nextSel.id !== asset.id ? nextSel : null);
        setDataVersion((v) => v + 1);
        refreshTree();
      } catch (e) {
        await message(String(e), { title: "Couldn’t delete", kind: "error" });
      }
    },
    [visibleAssets, refreshTree]
  );

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

  // Open a folder by path (also used by recents, quick locations, drag-drop).
  const openFolderPath = useCallback(async (path: string) => {
    setSelected(null);
    setTree(null);
    setProgress({ scanned: 0, indexed: 0, total: null, done: false });
    try {
      const resolved = await setRoot(path);
      setRootPath(resolved);
    } catch (e) {
      setProgress(null);
      await message(String(e), { title: "Couldn’t open folder", kind: "error" });
    }
  }, []);

  const handlePickFolder = useCallback(async () => {
    const folder = await pickFolder();
    if (folder) openFolderPath(folder);
  }, [openFolderPath]);

  // Menu ▸ Open Folder (⌘O).
  useEffect(() => {
    let un: (() => void) | undefined;
    onMenuOpenFolder(() => handlePickFolder()).then((fn) => (un = fn));
    return () => un?.();
  }, [handlePickFolder]);

  // Drag a folder (or file) onto the window to open it.
  useEffect(() => {
    let un: (() => void) | undefined;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDragging(true);
          else if (p.type === "leave") setDragging(false);
          else if (p.type === "drop") {
            setDragging(false);
            if (p.paths && p.paths.length) openFolderPath(p.paths[0]);
          }
        })
        .then((fn) => (un = fn))
        .catch(() => {});
    } catch {
      /* not running inside the Tauri webview */
    }
    return () => un?.();
  }, [openFolderPath]);

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

      <div className={`progress ${indexing && root ? "" : "hidden"}`}>
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
              onDelete={handleDelete}
            />
          </>
        ) : (
          <EmptyState
            onPickFolder={handlePickFolder}
            onOpen={openFolderPath}
          />
        )}
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-glyph">📥</div>
            <div className="drop-title">Drop a folder to open it</div>
          </div>
        </div>
      )}
    </div>
  );
}
