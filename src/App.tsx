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
import { OccasionsView } from "./components/OccasionsView";
import { OccasionsSidebar } from "./components/OccasionsSidebar";
import { folderName } from "./paths";
import { showToast, dismissToast, Toaster } from "./toast";
import {
  cancelIndexing,
  deleteAsset,
  getDateTree,
  getIndexStatus,
  getLastAnalysis,
  getPeople,
  getPlaces,
  addSpecialDate,
  deleteSpecialDate,
  listSpecialDates,
  listSlideshowAssets,
  mergePeople,
  onAnalysisDone,
  onIndexCancelled,
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
  type AnalysisRun,
  type Asset,
  type AssetFilter,
  type DateTree as DateTreeData,
  type IndexProgress,
  type IndexStatus,
  type Lens,
  type Person,
  type Places,
  type SavedSpecialDate,
  type SlideshowConfig,
  type SlideshowItem,
  type VisionProgress,
} from "./types";

/**
 * How a run in flight describes itself. Shared by the status bar and the
 * welcome screen's folder tile so the two can't drift apart.
 *
 * The index pass has two halves that report different numbers: the walk only
 * moves `scanned` and doesn't know the total until it ends, and the metadata
 * pass then climbs `indexed` towards it. Reading `indexed` during the walk is
 * how this said "0 assets" for the whole of a long scan.
 */
function runLabel(
  progress: IndexProgress | null,
  vision: VisionProgress | null
): string {
  if (vision) {
    return `Analyzing photos… ${vision.processed.toLocaleString()} of ${vision.total.toLocaleString()}`;
  }
  if (progress && !progress.done) {
    return progress.total
      ? `Indexing… ${progress.indexed.toLocaleString()} of ${progress.total.toLocaleString()} assets`
      : `Scanning… ${progress.scanned.toLocaleString()} assets found`;
  }
  // Between the two passes neither reports, but the run is still going.
  return "Analyzing…";
}

/** How long a delete stays undoable before the file actually goes to Trash. */
const UNDO_MS = 6000;

/** Optimistic progress shown between asking for a scan and the first event. */
const pendingIndex = (root: string): IndexProgress => ({
  runId: 0,
  root,
  elapsedMs: 0,
  scanned: 0,
  indexed: 0,
  total: null,
  done: false,
});

export default function App() {
  const [root, setRootPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  // The folder the run in flight belongs to, or null when nothing is indexing.
  // Deliberately separate from `root`: indexing keeps going after the user
  // returns to the welcome screen, and starts before a folder is open when a
  // launch resumes the last one — in both cases this is the only handle the UI
  // has on which recent-folder tile the progress belongs to.
  const [indexRoot, setIndexRoot] = useState<string | null>(null);
  const [filter, setFilter] = useState<AssetFilter>(EMPTY_FILTER);
  const [lens, setLens] = useState<Lens>("date");
  const [places, setPlaces] = useState<Places | null>(null);
  const [focusPlace, setFocusPlace] = useState<{ country: string; city?: string } | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [focusPerson, setFocusPerson] = useState<{ clusterId: number } | null>(null);
  const [tree, setTree] = useState<DateTreeData | null>(null);
  const [vision, setVision] = useState<VisionProgress | null>(null);
  // Analysis timing: when the run in flight started (wall clock, null when
  // nothing is running), how long it has been going, and the last run that
  // finished — the latter comes from the db, so it outlives the session.
  const [runStart, setRunStart] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisRun | null>(null);
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
  // Saved occasions (recurring special dates) for the Occasions lens.
  const [occasions, setOccasions] = useState<SavedSpecialDate[] | null>(null);
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
  // Deletes awaiting their undo window, by asset id. Several can be in flight
  // at once — clearing out a handful of files in a row shouldn't make each
  // delete cut the previous one's undo short — and each keeps its own commit
  // timer and the id of its "Moved to Trash" toast so undo can dismiss it.
  const pendingRef = useRef(
    new Map<number, { asset: Asset; timer: number; toastId: number }>()
  );

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
  // Cancel one pending delete and bring its row back.
  const handleUndo = useCallback((id: number) => {
    const pending = pendingRef.current.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    dismissToast(pending.toastId);
    pendingRef.current.delete(id);
    setHiddenIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setSelected(pending.asset);
  }, []);

  const handleDelete = useCallback(
    (asset: Asset) => {
      const pending = pendingRef.current;
      // Pick a neighbour to select next, before the row disappears. Skip the
      // ones already on their way out, or deleting a run of files would land
      // the selection on a row that isn't there any more.
      const idx = visibleAssets.findIndex((a) => a.id === asset.id);
      const nextLive = (from: number, step: number) => {
        for (let i = from; i >= 0 && i < visibleAssets.length; i += step) {
          const a = visibleAssets[i];
          if (a.id !== asset.id && !pending.has(a.id)) return a;
        }
        return null;
      };
      const nextSel =
        idx < 0 ? null : nextLive(idx + 1, 1) ?? nextLive(idx - 1, -1);
      setHiddenIds((prev) => new Set(prev).add(asset.id));
      setSelected((cur) => (cur && cur.id === asset.id ? nextSel : cur));
      const timer = window.setTimeout(() => {
        pending.delete(asset.id);
        commitDelete(asset);
      }, UNDO_MS);
      const toastId = showToast(`Moved “${asset.name}” to Trash`, {
        action: { label: "Undo", onClick: () => handleUndo(asset.id) },
        duration: UNDO_MS,
        // Pushed off the stack early: the undo is no longer on offer, so don't
        // leave the file in limbo on a countdown nobody can see.
        onEvict: () => {
          if (!pending.has(asset.id)) return;
          clearTimeout(timer);
          pending.delete(asset.id);
          commitDelete(asset);
        },
      });
      pending.set(asset.id, { asset, timer, toastId });
    },
    [visibleAssets, commitDelete, handleUndo]
  );

  // Commit anything still pending if the app unmounts.
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        deleteAsset(p.asset.path).catch(() => {});
      }
      pending.clear();
    };
  }, []);

  // The run whose clock is on screen. Progress events carry the backend's own
  // elapsed time, so the timer starts from the right place even if the UI only
  // hears about a run that has been going for a while.
  const runIdRef = useRef<number | null>(null);
  // A run the user stopped. Its worker notices at its next checkpoint, so a
  // straggler event can still arrive; events tagged with it are ignored.
  const stoppedRunRef = useRef<number | null>(null);
  // The newest run this screen has heard from. Run ids only ever increase, so
  // anything below it belongs to a run that has already been superseded — its
  // late events must not put the folder it was scanning back on screen.
  const newestRunRef = useRef(0);
  const indexRootRef = useRef<string | null>(null);
  indexRootRef.current = indexRoot;

  /** True for an event from a run that was stopped or already superseded. */
  const staleEvent = useCallback((runId: number) => {
    if (runId === stoppedRunRef.current || runId < newestRunRef.current) return true;
    newestRunRef.current = runId;
    return false;
  }, []);
  /** Start the clock the moment the user asks for a scan, before the first event. */
  const beginClock = useCallback(() => {
    runIdRef.current = null;
    setRunStart(Date.now());
    setElapsedMs(0);
  }, []);
  const startClock = useCallback((runId: number, elapsed: number) => {
    if (runIdRef.current === runId) return; // same run: keep ticking locally
    runIdRef.current = runId;
    setRunStart(Date.now() - elapsed);
    setElapsedMs(elapsed);
  }, []);

  /** Forget the run in flight — it finished, was stopped, or never started. */
  const clearRun = useCallback(() => {
    setIndexRoot(null);
    setProgress(null);
    setVision(null);
    setRunStart(null);
    runIdRef.current = null;
  }, []);

  // Tick the elapsed time while a run is in flight.
  useEffect(() => {
    if (runStart === null) return;
    const tick = () => setElapsedMs(Date.now() - runStart);
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [runStart]);

  // A run finished: stop the clock and keep how long it took. The run may well
  // belong to a folder that isn't on screen, so only that folder's own status
  // bar picks up the duration.
  useEffect(() => {
    let un: (() => void) | undefined;
    onAnalysisDone((r) => {
      if (staleEvent(r.runId)) return;
      setRunStart(null);
      setVision(null);
      setIndexRoot((cur) => (cur === r.root ? null : cur));
      if (r.root === rootRef.current) {
        setLastAnalysis({ durationMs: r.durationMs, finishedAt: r.finishedAt });
      }
    }).then((fn) => (un = fn));
    return () => un?.();
  }, [staleEvent]);

  // A run was stopped before it finished (the user pressed Stop, or the app
  // closed the folder out from under it).
  useEffect(() => {
    let un: (() => void) | undefined;
    onIndexCancelled((c) => {
      stoppedRunRef.current = c.runId;
      clearRun();
    }).then((fn) => (un = fn));
    return () => un?.();
  }, [clearRun]);

  /** Show a run that was already going when this screen started listening. */
  const adoptStatus = useCallback(
    (s: IndexStatus) => {
      setIndexRoot(s.root);
      startClock(s.runId, s.elapsedMs);
      setProgress({
        runId: s.runId,
        root: s.root,
        elapsedMs: s.elapsedMs,
        scanned: s.scanned,
        indexed: s.indexed,
        total: s.total,
        done: s.phase === "analyzing",
      });
      setVision(
        s.phase === "analyzing"
          ? {
              runId: s.runId,
              root: s.root,
              elapsedMs: s.elapsedMs,
              processed: s.processed,
              total: s.visionTotal,
              done: false,
            }
          : null
      );
    },
    [startClock]
  );

  // Indexing outlives the screen that started it, so on mount ask what's already
  // running rather than waiting for the next event — at launch the backend
  // resumes the last folder before this app ever renders.
  useEffect(() => {
    let dropped = false;
    getIndexStatus()
      .then((s) => {
        if (dropped || !s || indexRootRef.current) return;
        adoptStatus(s);
      })
      .catch(() => {});
    return () => {
      dropped = true;
    };
  }, [adoptStatus]);

  // Show the folder's stored analysis time until this session's run replaces it.
  useEffect(() => {
    if (!root) {
      setLastAnalysis(null);
      return;
    }
    getLastAnalysis()
      .then(setLastAnalysis)
      .catch(() => setLastAnalysis(null));
  }, [root]);

  // Subscribe to indexing progress; refresh the tree as items stream in.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let lastRefresh = 0;
    onIndexProgress((p) => {
      if (staleEvent(p.runId)) return;
      setProgress(p);
      // `done` here only ends the index pass — photo analysis follows, and the
      // run isn't over until `analysis-done`.
      setIndexRoot(p.root);
      startClock(p.runId, p.elapsedMs);
      // The tree is only on screen for the open folder; a run for anything else
      // (or none, on the welcome screen) has nothing to refresh.
      if (p.root !== rootRef.current) return;
      const now = performance.now();
      // Throttle live refreshes while scanning; always refresh on completion.
      if (p.done || now - lastRefresh > 700) {
        lastRefresh = now;
        refreshTree();
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [refreshTree, startClock, staleEvent]);

  // Track Vision (scene/OCR) enrichment progress.
  useEffect(() => {
    let un: (() => void) | undefined;
    onVisionProgress((p) => {
      if (staleEvent(p.runId)) return;
      setVision(p.done ? null : p);
      setIndexRoot(p.root);
      startClock(p.runId, p.elapsedMs);
    }).then((fn) => (un = fn));
    return () => un?.();
  }, [startClock, staleEvent]);

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

  // Refresh saved occasions (counts depend on the indexed assets).
  const refreshOccasions = useCallback(() => {
    listSpecialDates().then(setOccasions).catch(() => setOccasions([]));
  }, []);

  // Refresh occasions (and their counts) while the Occasions lens is active.
  useEffect(() => {
    if (!root || lens !== "occasions") return;
    refreshOccasions();
  }, [root, lens, dataVersion, tree, refreshOccasions]);

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
  const openFolderPath = useCallback(
    async (path: string) => {
      setSelected(null);
      setTree(null);
      // Opening the folder that's already indexing in the background attaches to
      // that run instead of restarting it, so leave its progress and clock alone.
      const attaching = indexRootRef.current === path;
      if (!attaching) {
        setProgress(pendingIndex(path));
        setVision(null);
        setIndexRoot(path);
        beginClock();
      }
      try {
        const resolved = await setRoot(path);
        setRootPath(resolved);
        if (!attaching) setIndexRoot(resolved);
      } catch (e) {
        if (!attaching) clearRun();
        await message(String(e), { title: "Couldn’t open folder", kind: "error" });
      }
    },
    [beginClock, clearRun]
  );

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
    setProgress(pendingIndex(root));
    setIndexRoot(root);
    beginClock();
    showToast("Rescanning for changes…");
    await rescan();
  }, [root, beginClock]);

  /** Stop the background run, whichever folder it belongs to. */
  const handleCancelIndexing = useCallback(async () => {
    const target = indexRootRef.current;
    const name = target ? folderName(target) : null;
    stoppedRunRef.current = runIdRef.current;
    clearRun();
    try {
      await cancelIndexing();
      showToast(name ? `Stopped indexing “${name}”` : "Stopped indexing");
    } catch (e) {
      await message(String(e), { title: "Couldn’t stop indexing", kind: "error" });
    }
  }, [clearRun]);

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

  const handleAddOccasion = useCallback(
    async (month: number, day: number, label: string | null) => {
      try {
        const row = await addSpecialDate(month, day, label);
        setOccasions((os) => [...(os ?? []), row].sort(
          (a, b) => a.month - b.month || a.day - b.day
        ));
        showToast(`Added ${label ?? "occasion"}`, { kind: "success" });
      } catch (e) {
        await message(String(e), { title: "Couldn’t add", kind: "error" });
      }
    },
    []
  );

  const handleDeleteOccasion = useCallback(async (id: number) => {
    setOccasions((os) => (os ? os.filter((o) => o.id !== id) : os));
    try {
      await deleteSpecialDate(id);
    } catch {
      refreshOccasions();
    }
  }, [refreshOccasions]);

  const handlePlayOccasion = useCallback(
    (o: SavedSpecialDate) =>
      handleStartSlideshow({
        ...DEFAULT_SLIDESHOW_CONFIG,
        specialDates: [
          { month: o.month, day: o.day, label: o.label ?? undefined },
        ],
      }),
    [handleStartSlideshow]
  );

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
  // Any run in flight deliberately survives this — it keeps going in the
  // background and reports itself on that folder's tile in the recents list.
  const handleHome = useCallback(() => {
    setRootPath(null);
    setSelected(null);
    setTree(null);
    setVisibleAssets([]);
    setFilter(EMPTY_FILTER);
    setLens("date");
    setPeople(null);
    setFocusPerson(null);
    setPlaces(null);
  }, []);

  // Progress belongs to whichever folder the run is for; only the folder on
  // screen reports it in its own status bar.
  const showingRun = indexRoot !== null && indexRoot === root;
  // A run is on the clock until the backend says it finished. This also covers
  // the handover from indexing to photo analysis, when neither reports yet.
  const running = showingRun && runStart !== null;
  // Rescan is only barred during the index pass; photo analysis can be
  // superseded by one.
  const indexing = showingRun && !!progress && !progress.done;

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

  // How far along the run is, across both passes. Null means indeterminate —
  // the walk can't know its own total until it has finished.
  const runPct = useMemo(() => {
    if (vision) {
      return vision.total > 0
        ? Math.min(100, (vision.processed / vision.total) * 100)
        : null;
    }
    if (progress && !progress.done && progress.total) {
      return Math.min(100, (progress.indexed / progress.total) * 100);
    }
    return null;
  }, [progress, vision]);

  const label = useMemo(() => runLabel(progress, vision), [progress, vision]);

  // What the welcome screen shows on the tile of the folder being indexed.
  const folderIndexing = useMemo(
    () => (indexRoot ? { root: indexRoot, label, pct: runPct } : null),
    [indexRoot, label, runPct]
  );

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
        showFilters={lens !== "occasions"}
        canRescan={!!root && !indexing}
      />

      {root && lens !== "occasions" && (
        <FilterChips filter={filter} onChange={setFilter} />
      )}

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
                  onRename={handleRename}
                  focusPlace={focusPlace}
                  refreshToken={dataVersion}
                  hiddenIds={hiddenIds}
                />
              ) : lens === "people" ? (
                <PeopleTree
                  people={people}
                  filter={filter}
                  selected={selected}
                  onSelect={setSelected}
                  onVisibleAssetsChange={setVisibleAssets}
                  onRename={handleRenamePerson}
                  onRenameAsset={handleRename}
                  focusPerson={focusPerson}
                  refreshToken={dataVersion}
                />
              ) : (
                <OccasionsSidebar
                  occasions={occasions}
                  onPlay={handlePlayOccasion}
                  onDelete={handleDeleteOccasion}
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
                ) : lens === "occasions" ? (
                  <OccasionsView
                    occasions={occasions}
                    onAdd={handleAddOccasion}
                    onDelete={handleDeleteOccasion}
                    onPlay={handlePlayOccasion}
                  />
                ) : undefined
              }
            />
          </>
        ) : (
          <EmptyState
            onPickFolder={handlePickFolder}
            onOpen={openFolderPath}
            refreshToken={dataVersion}
            indexing={folderIndexing}
            onCancelIndexing={handleCancelIndexing}
          />
        )}
      </div>

      {root && (
        <StatusBar
          root={root}
          running={running}
          label={running ? label : null}
          pct={runPct}
          total={total}
          elapsedMs={elapsedMs}
          lastAnalysis={lastAnalysis}
          onCancel={handleCancelIndexing}
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

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          root={root}
          onFolderReset={() => {
            // The folder is re-indexing from scratch; clear derived views and
            // show the progress bar. Index events refresh the tree as it runs.
            setSelected(null);
            setPeople(null);
            setPlaces(null);
            setDataVersion((v) => v + 1);
            if (root) {
              setProgress(pendingIndex(root));
              setIndexRoot(root);
            }
            beginClock();
          }}
          onFeatureReset={(feature) => {
            // Reflect the reset in the live views without a full re-index.
            setDataVersion((v) => v + 1);
            if (feature === "favorites") {
              setSelected((cur) => (cur ? { ...cur, favorite: false } : cur));
            } else if (feature === "faces") {
              setPeople((ps) =>
                ps ? ps.map((p) => ({ ...p, name: null })) : ps
              );
            } else if (feature === "occasions") {
              setOccasions([]);
            }
          }}
          onAppReset={handleHome}
        />
      )}

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
