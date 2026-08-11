import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navbar } from "./components/Navbar";
import { DateTree } from "./components/DateTree";
import { PreviewPane } from "./components/PreviewPane";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { EmptyState } from "./components/EmptyState";
import { FilterChips } from "./components/FilterChips";
import { LensSwitcher } from "./components/LensSwitcher";
import { PlacesTree } from "./components/PlacesTree";
import { PlacesMap } from "./components/PlacesMap";
import { PeopleTree } from "./components/PeopleTree";
import { PeopleGrid } from "./components/PeopleGrid";
import { SettingsModal } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { SlideshowSetup } from "./components/SlideshowSetup";
import { SlideshowPlayer } from "./components/SlideshowPlayer";
import { showToast, dismissToast, Toaster } from "./toast";
import {
  deleteAsset,
  getDateTree,
  getPeople,
  getPlaces,
  listSlideshowAssets,
  mergePeople,
  onIndexProgress,
  onMenuOpenFolder,
  onMenuSettings,
  onVisionProgress,
  pickFolder,
  renameAsset,
  renamePerson,
  rescan,
  setFavorite,
  setRoot,
} from "./api";
import {
  DEFAULT_SLIDESHOW_CONFIG,
  EMPTY_FILTER,
  type Asset,
  type AssetFilter,
  type DateTree as DateTreeData,
  type IndexProgress,
  type Lens,
  type Person,
  type Places,
  type SlideshowConfig,
  type SlideshowItem,
  type VisionProgress,
} from "./types";

export default function App() {
  const [root, setRootPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [filter, setFilter] = useState<AssetFilter>(EMPTY_FILTER);
  const [lens, setLens] = useState<Lens>("date");
  const [places, setPlaces] = useState<Places | null>(null);
  const [focusPlace, setFocusPlace] = useState<{ country: string; city?: string } | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [focusPerson, setFocusPerson] = useState<{ clusterId: number } | null>(null);
  const [tree, setTree] = useState<DateTreeData | null>(null);
  const [vision, setVision] = useState<VisionProgress | null>(null);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Slideshow: the setup modal, then the resolved items being played.
  const [slideshowSetup, setSlideshowSetup] = useState(false);
  const [slideshow, setSlideshow] = useState<{
    items: SlideshowItem[];
    config: SlideshowConfig;
  } | null>(null);
  // True in native macOS fullscreen, where the traffic lights are hidden and the
  // navbar can reclaim the left inset that normally clears them.
  const [fullscreen, setFullscreen] = useState(false);
  // Asset ids hidden from the tree while their deletion is pending undo.
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());
  // The delete awaiting the undo window: the asset, its commit timer, and the
  // id of the "Moved to Trash" toast so it can be dismissed on undo.
  const pendingRef = useRef<{
    asset: Asset;
    timer: number;
    toastId: number;
  } | null>(null);

  const handleRename = useCallback(
    async (asset: Asset, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === asset.name) return;
      try {
        const updated = await renameAsset(asset.path, trimmed);
        setSelected((cur) => (cur && cur.id === updated.id ? updated : cur));
        setDataVersion((v) => v + 1);
        showToast(`Renamed to “${trimmed}”`, { kind: "success" });
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

  // Keep a ref so the debounced tree refresh always sees the latest filter.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // The folder drop-to-open is only for the welcome screen; a ref lets the
  // once-registered drag handler see whether a folder is already open (so it
  // doesn't collide with in-app dragging, e.g. merging faces).
  const rootRef = useRef(root);
  rootRef.current = root;

  const refreshTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const t = await getDateTree(filterRef.current);
      setTree(t);
    } catch (e) {
      console.error("get_date_tree failed", e);
    } finally {
      setLoadingTree(false);
    }
  }, []);

  const handleToggleFavorite = useCallback(async (asset: Asset) => {
    const next = !asset.favorite;
    try {
      await setFavorite(asset.id, next);
      setSelected((cur) =>
        cur && cur.id === asset.id ? { ...cur, favorite: next } : cur
      );
      setDataVersion((v) => v + 1);
      showToast(next ? "Added to favorites" : "Removed from favorites");
    } catch (e) {
      await message(String(e), { title: "Couldn’t update", kind: "error" });
    }
  }, []);

  // Actually move a pending asset to the Trash and drop it from the index.
  const commitDelete = useCallback(
    async (asset: Asset) => {
      try {
        await deleteAsset(asset.path);
        setDataVersion((v) => v + 1);
        refreshTree();
      } catch (e) {
        await message(String(e), { title: "Couldn’t delete", kind: "error" });
      } finally {
        setHiddenIds((prev) => {
          const n = new Set(prev);
          n.delete(asset.id);
          return n;
        });
      }
    },
    [refreshTree]
  );

  // Delete is optimistic + undoable: hide the row immediately, show a toast,
  // and only move the file to the Trash once the undo window elapses.
  // Cancel the pending delete and bring the row back.
  const handleUndo = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    dismissToast(pending.toastId);
    pendingRef.current = null;
    setHiddenIds((prev) => {
      const n = new Set(prev);
      n.delete(pending.asset.id);
      return n;
    });
    setSelected(pending.asset);
  }, []);

  const handleDelete = useCallback(
    (asset: Asset) => {
      // Flush any still-pending delete before starting a new one.
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer);
        dismissToast(pendingRef.current.toastId);
        commitDelete(pendingRef.current.asset);
        pendingRef.current = null;
      }
      // Pick a neighbour to select next, before the row disappears.
      const idx = visibleAssets.findIndex((a) => a.id === asset.id);
      const nextSel = visibleAssets[idx + 1] ?? visibleAssets[idx - 1] ?? null;
      setHiddenIds((prev) => new Set(prev).add(asset.id));
      setSelected((cur) =>
        cur && cur.id === asset.id
          ? nextSel && nextSel.id !== asset.id
            ? nextSel
            : null
          : cur
      );
      const timer = window.setTimeout(() => {
        pendingRef.current = null;
        commitDelete(asset);
      }, 6000);
      const toastId = showToast(`Moved “${asset.name}” to Trash`, {
        action: { label: "Undo", onClick: handleUndo },
        duration: 6000,
      });
      pendingRef.current = { asset, timer, toastId };
    },
    [visibleAssets, commitDelete, handleUndo]
  );

  // Commit any pending delete if the app unmounts.
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer);
        deleteAsset(pendingRef.current.asset.path).catch(() => {});
      }
    };
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

  // Track Vision (scene/OCR) enrichment progress.
  useEffect(() => {
    let un: (() => void) | undefined;
    onVisionProgress((p) => setVision(p.done ? null : p)).then((fn) => (un = fn));
    return () => un?.();
  }, []);

  // Settings… (⌘,) menu.
  useEffect(() => {
    let un: (() => void) | undefined;
    onMenuSettings(() => setSettingsOpen(true)).then((fn) => (un = fn));
    return () => un?.();
  }, []);

  // Re-query the tree whenever the filter changes.
  useEffect(() => {
    if (root) refreshTree();
  }, [filter, root, refreshTree]);

  // Re-query places while the Places lens is active.
  useEffect(() => {
    if (!root || lens !== "places") return;
    getPlaces(filter)
      .then(setPlaces)
      .catch((e) => console.error("get_places failed", e));
  }, [root, lens, filter, dataVersion, tree]);

  // Re-query people while the People lens is active (refresh as analysis runs).
  useEffect(() => {
    if (!root || lens !== "people") return;
    getPeople(filter)
      .then(setPeople)
      .catch((e) => console.error("get_people failed", e));
  }, [root, lens, filter, dataVersion, vision]);

  const handleRenamePerson = useCallback(
    async (clusterId: number, name: string) => {
      try {
        await renamePerson(clusterId, name);
        setPeople((ps) =>
          ps
            ? ps.map((p) =>
                p.clusterId === clusterId ? { ...p, name: name.trim() || null } : p
              )
            : ps
        );
        showToast(
          name.trim() ? `Named “${name.trim()}”` : "Name cleared",
          { kind: "success" }
        );
      } catch (e) {
        await message(String(e), { title: "Couldn’t rename", kind: "error" });
      }
    },
    []
  );

  const handleMergePeople = useCallback(
    async (source: number, target: number) => {
      // Optimistically drop the merged-away card, then refetch for exact counts.
      setPeople((ps) => (ps ? ps.filter((p) => p.clusterId !== source) : ps));
      try {
        await mergePeople(source, target);
        const fresh = await getPeople(filterRef.current);
        setPeople(fresh);
        showToast("Merged people", { kind: "success" });
      } catch (e) {
        await message(String(e), { title: "Couldn’t merge", kind: "error" });
        getPeople(filterRef.current).then(setPeople).catch(() => {});
      }
    },
    []
  );

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

  // Track native fullscreen so the navbar can drop its traffic-light inset.
  useEffect(() => {
    let un: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      const sync = () =>
        win.isFullscreen().then(setFullscreen).catch(() => {});
      sync();
      win
        .onResized(sync)
        .then((fn) => (un = fn))
        .catch(() => {});
    } catch {
      /* not running inside the Tauri webview */
    }
    return () => un?.();
  }, []);

  // Drag a folder (or file) onto the window to open it.
  useEffect(() => {
    let un: (() => void) | undefined;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          // Only active on the welcome screen; ignore once a folder is open.
          if (rootRef.current) {
            setDragging(false);
            return;
          }
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
    showToast("Rescanning for changes…");
    await rescan();
  }, [root]);

  // Resolve a slideshow config to its items and launch the player.
  const handleStartSlideshow = useCallback(async (config: SlideshowConfig) => {
    try {
      const items = await listSlideshowAssets(config);
      if (items.length === 0) {
        showToast("No media matches this slideshow");
        return;
      }
      setSlideshowSetup(false);
      setSlideshow({ items, config });
    } catch (e) {
      await message(String(e), { title: "Couldn’t start slideshow", kind: "error" });
    }
  }, []);

  // One-tap slideshow of today's calendar day across every year.
  const handleOnThisDay = useCallback(() => {
    const now = new Date();
    handleStartSlideshow({
      ...DEFAULT_SLIDESHOW_CONFIG,
      specialDates: [{ month: now.getMonth() + 1, day: now.getDate() }],
    });
  }, [handleStartSlideshow]);

  // Switching lens (Date / Places / People) clears the current preview, since
  // the selected asset may not exist in the new view.
  const handleLens = useCallback(
    (l: Lens) => {
      if (l === lens) return;
      setLens(l);
      setSelected(null);
    },
    [lens]
  );

  // Return to the welcome screen (keeps the folder indexed for a quick reopen).
  const handleHome = useCallback(() => {
    setRootPath(null);
    setSelected(null);
    setTree(null);
    setProgress(null);
    setVisibleAssets([]);
    setFilter(EMPTY_FILTER);
    setLens("date");
    setVision(null);
    setPeople(null);
    setFocusPerson(null);
    setPlaces(null);
  }, []);

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
    <div className={`app${fullscreen ? " fullscreen" : ""}`}>
      <Navbar
        root={root}
        filter={filter}
        onFilter={setFilter}
        onPickFolder={handlePickFolder}
        onRescan={handleRescan}
        onHome={handleHome}
        onSettings={() => setSettingsOpen(true)}
        onSlideshow={() => setSlideshowSetup(true)}
        onOnThisDay={handleOnThisDay}
        canRescan={!!root && !indexing}
      />

      {root && <FilterChips filter={filter} onChange={setFilter} />}

      <div className="body">
        {root ? (
          <>
            <div className="sidebar" style={{ width: sidebarW }}>
              <LensSwitcher lens={lens} onLens={handleLens} />
              {lens === "date" ? (
                <DateTree
                  tree={tree}
                  loading={loadingTree}
                  filter={filter}
                  selected={selected}
                  onSelect={setSelected}
                  onVisibleAssetsChange={setVisibleAssets}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  refreshToken={dataVersion}
                  hiddenIds={hiddenIds}
                />
              ) : lens === "places" ? (
                <PlacesTree
                  places={places}
                  filter={filter}
                  selected={selected}
                  onSelect={setSelected}
                  onVisibleAssetsChange={setVisibleAssets}
                  focusPlace={focusPlace}
                  refreshToken={dataVersion}
                  hiddenIds={hiddenIds}
                />
              ) : (
                <PeopleTree
                  people={people}
                  filter={filter}
                  selected={selected}
                  onSelect={setSelected}
                  onVisibleAssetsChange={setVisibleAssets}
                  onRename={handleRenamePerson}
                  focusPerson={focusPerson}
                  refreshToken={dataVersion}
                />
              )}
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
              onToggleFavorite={handleToggleFavorite}
              onClose={() => setSelected(null)}
              emptyOverride={
                lens === "places" ? (
                  <PlacesMap places={places} onFocusPlace={setFocusPlace} />
                ) : lens === "people" ? (
                  <PeopleGrid
                    people={people}
                    onFocusPerson={setFocusPerson}
                    onMerge={handleMergePeople}
                    onRename={handleRenamePerson}
                  />
                ) : undefined
              }
            />
          </>
        ) : (
          <EmptyState
            onPickFolder={handlePickFolder}
            onOpen={openFolderPath}
          />
        )}
      </div>

      {root && (
        <StatusBar
          indexing={indexing}
          progress={progress}
          progressPct={progressPct}
          vision={vision}
          total={total}
        />
      )}

      {dragging && !root && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-glyph">📥</div>
            <div className="drop-title">Drop a folder to open it</div>
          </div>
        </div>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {slideshowSetup && (
        <SlideshowSetup
          onClose={() => setSlideshowSetup(false)}
          onStart={handleStartSlideshow}
        />
      )}

      {slideshow && (
        <SlideshowPlayer
          items={slideshow.items}
          config={slideshow.config}
          onClose={() => setSlideshow(null)}
        />
      )}

      <Toaster />
    </div>
  );
}
