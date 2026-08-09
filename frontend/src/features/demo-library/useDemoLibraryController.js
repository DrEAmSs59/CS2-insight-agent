import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import API, { getDemosStreamUrl } from "../../api/api";
import {
  demoBatchFailureMessage,
  normalizeDemoBatchFailures,
} from "../../utils/demoBatchFailures";
import { resetDemoAnalysisDefaultView } from "../demo-analysis/state/analysisSession";
import {
  buildLoadedLibraryDemo,
  prepareLibraryAnalysisHandoff,
} from "./analysisHandoff";
import { appendLibraryFilterParams, hasActiveLibraryFilters } from "./libraryFilters";

const DEFAULT_ADVANCED_FILTERS = {
  mapName: "",
  status: "all",
  playerQuery: "",
  steamQuery: "",
  minKills: "",
  maxDeaths: "",
  minAssists: "",
  minKd: "",
  roundsMin: "",
  roundsMax: "",
  durationMin: "",
  durationMax: "",
  dateFrom: "",
  dateTo: "",
};

export function useDemoLibraryController({
  t,
  navigate,
  setProgressText,
  startupInitDone,
  analysis,
}) {
  const {
    autoParseLoadedDemosRef,
    setUploadedDemos,
    setParsedMatches,
    setCurrentMatchIndex,
    setSelectedPlayers,
    setActivePlayerTabs,
    setFreezeToDeathRoundsByMatch,
    setSelectedClientClipUids,
  } = analysis;

  const [demoLibraryItems, setDemoLibraryItems] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryScanning, setLibraryScanning] = useState(false);
  const [libraryLoadingOverlay, setLibraryLoadingOverlay] = useState(false);
  const [libraryLoadingText, setLibraryLoadingText] = useState("");
  const [libraryPage, setLibraryPage] = useState(1);
  const libraryPageRef = useRef(1);
  const [libraryHasNextPage, setLibraryHasNextPage] = useState(false);
  const [libraryTotal, setLibraryTotal] = useState(null);
  const [selectedLibraryDemoIds, setSelectedLibraryDemoIds] = useState(new Set());
  const [libraryDemoIdsByIndex, setLibraryDemoIdsByIndex] = useState({});
  const [libraryRename, setLibraryRename] = useState(null);
  const [libraryDeletePrompt, setLibraryDeletePrompt] = useState(null);
  const [librarySearchInput, setLibrarySearchInput] = useState("");
  const [librarySearchQ, setLibrarySearchQ] = useState("");
  const [libraryAdvFilters, setLibraryAdvFilters] = useState(DEFAULT_ADVANCED_FILTERS);
  const [libraryJumpDraft, setLibraryJumpDraft] = useState("");
  const [libraryPageSize, setLibraryPageSize] = useState(12);
  const libraryPageSizeEffectSkipRef = useRef(false);
  const [batchLoadError, setBatchLoadError] = useState({
    open: false,
    failed: [],
    mode: "load",
  });

  const libraryTotalPages =
    libraryTotal == null ? null : Math.max(1, Math.ceil(libraryTotal / libraryPageSize));
  const hasLibraryAdvancedFilters = useMemo(
    () => hasActiveLibraryFilters(libraryAdvFilters),
    [libraryAdvFilters],
  );
  const libraryAdvFiltersKey = useMemo(
    () => JSON.stringify(libraryAdvFilters),
    [libraryAdvFilters],
  );

  useEffect(() => {
    setLibraryPage(1);
  }, [libraryAdvFiltersKey]);

  const appendFilterParams = useCallback(
    (params) => appendLibraryFilterParams(params, libraryAdvFilters),
    [libraryAdvFilters],
  );

  const refreshDemoLibrary = useCallback(
    async (page = libraryPage, opts = {}) => {
      const { manageLoading = true, searchQ: searchQOverride } = opts;
      if (manageLoading) setLibraryLoading(true);
      try {
        const limit = libraryPageSize;
        const offset = (page - 1) * limit;
        const params = { limit, offset };
        const effectiveSearch =
          searchQOverride !== undefined ? searchQOverride : librarySearchQ;
        if (effectiveSearch) params.q = effectiveSearch;
        appendFilterParams(params);
        const { data } = await API.get("/demos/compact", { params });
        const items = data.items || [];
        setDemoLibraryItems(items);
        const total = typeof data.total === "number" ? data.total : null;
        if (total != null) {
          setLibraryTotal(total);
          setLibraryHasNextPage(offset + items.length < total);
        } else {
          setLibraryTotal(null);
          setLibraryHasNextPage(items.length === limit);
        }
      } catch {
        // A transient refresh failure must not discard the currently visible page.
      } finally {
        if (manageLoading) setLibraryLoading(false);
      }
    },
    [appendFilterParams, libraryPage, libraryPageSize, librarySearchQ],
  );

  const refreshDemoLibraryRef = useRef(refreshDemoLibrary);
  refreshDemoLibraryRef.current = refreshDemoLibrary;

  const handleLibrarySearchSubmit = useCallback(() => {
    const next = librarySearchInput.trim();
    setLibrarySearchQ(next);
    setLibraryPage(1);
    void refreshDemoLibrary(1, { manageLoading: true, searchQ: next });
  }, [librarySearchInput, refreshDemoLibrary]);

  useEffect(() => {
    if (!libraryPageSizeEffectSkipRef.current) {
      libraryPageSizeEffectSkipRef.current = true;
      return;
    }
    setLibraryPage(1);
    void refreshDemoLibraryRef.current(1, { manageLoading: false });
  }, [libraryPageSize]);

  useEffect(() => {
    libraryPageRef.current = libraryPage;
  }, [libraryPage]);

  useEffect(() => {
    let cancelled = false;
    let eventSource = null;
    let debounce = null;
    const scheduleRefresh = () => {
      if (cancelled) return;
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        void refreshDemoLibrary(libraryPageRef.current, { manageLoading: false });
      }, 600);
    };
    const connect = () => {
      if (cancelled) return;
      try {
        eventSource = new EventSource(getDemosStreamUrl());
      } catch {
        return;
      }
      eventSource.addEventListener("library", scheduleRefresh);
      eventSource.onerror = () => {
        if (cancelled) return;
        try {
          eventSource?.close();
        } catch {
          // Ignore cleanup races.
        }
        eventSource = null;
        if (!cancelled) window.setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
      try {
        eventSource?.close();
      } catch {
        // Ignore cleanup races.
      }
    };
  }, [refreshDemoLibrary]);

  useEffect(() => {
    if (!startupInitDone) return;
    void refreshDemoLibrary(libraryPage, { manageLoading: false });
  }, [libraryPage, refreshDemoLibrary, startupInitDone]);

  useEffect(() => {
    if (!startupInitDone) return;
    const timer = window.setTimeout(() => {
      const next = librarySearchInput.trim();
      if (next === librarySearchQ) return;
      setLibrarySearchQ(next);
      setLibraryPage(1);
      void refreshDemoLibraryRef.current(1, {
        manageLoading: false,
        searchQ: next,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [librarySearchInput, librarySearchQ, startupInitDone]);

  const handleLibraryPageJump = useCallback(() => {
    const raw = libraryJumpDraft.trim();
    if (!raw) return;
    const requestedPage = parseInt(raw, 10);
    if (!Number.isFinite(requestedPage) || requestedPage < 1) {
      setProgressText(t("app.libraryPageJumpInvalid"));
      return;
    }
    let target = requestedPage;
    if (libraryTotalPages != null && requestedPage > libraryTotalPages) {
      target = libraryTotalPages;
      setProgressText(t("app.libraryPageJumpClamped", { maxPage: libraryTotalPages }));
    }
    setLibraryJumpDraft("");
    setLibraryPage(target);
    void refreshDemoLibrary(target, { manageLoading: false });
  }, [libraryJumpDraft, libraryTotalPages, refreshDemoLibrary, setProgressText, t]);

  const handleScanDemos = useCallback(async () => {
    setLibraryScanning(true);
    try {
      const { data } = await API.post("/demos/scan");
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
      const discovered = data?.discovered_count;
      setProgressText(
        typeof discovered === "number" && discovered > 0
          ? t("app.scanDone", { n: discovered })
          : t("app.scanDoneEmpty", { scanned: data?.scanned || 0 }),
      );
      return data;
    } catch (error) {
      setProgressText(
        t("app.scanFail", { msg: error.response?.data?.detail || error.message }),
        { isError: true },
      );
      return null;
    } finally {
      setLibraryScanning(false);
    }
  }, [libraryPage, refreshDemoLibrary, setProgressText, t]);

  const handleDeleteDemo = useCallback(
    async (id) => {
      setLibraryDeletePrompt(null);
      setLibraryLoadingOverlay(true);
      setLibraryLoadingText(t("app.deletingDemo"));
      try {
        await API.delete(`/demos/${id}`);
        await refreshDemoLibrary(libraryPage, { manageLoading: false });
      } catch (error) {
        setProgressText(
          t("app.deleteFail", { msg: error.response?.data?.detail || error.message }),
          { isError: true },
        );
      } finally {
        setLibraryLoadingOverlay(false);
        setLibraryLoadingText(t("app.libraryLoadingDemo"));
      }
    },
    [libraryPage, refreshDemoLibrary, setProgressText, t],
  );

  const handleDeleteDemoFile = useCallback(
    async (id) => {
      try {
        await API.post(`/demos/${id}/delete-file`);
        setLibraryDeletePrompt(null);
        setProgressText(t("app.deleteFileDone"));
        await refreshDemoLibrary(libraryPage, { manageLoading: false });
      } catch (error) {
        setProgressText(
          t("app.deleteFileFail", { msg: error.response?.data?.detail || error.message }),
          { isError: true },
        );
      }
    },
    [libraryPage, refreshDemoLibrary, setProgressText, t],
  );

  const handleLibraryBatchDelete = useCallback(
    async (ids) => {
      const list = [...ids];
      if (!list.length) return;
      setLibraryLoadingOverlay(true);
      setLibraryLoadingText(t("app.batchDeleteProgress", { done: 0, total: list.length }));
      let done = 0;
      try {
        for (const id of list) {
          try {
            await API.delete(`/demos/${id}`);
            done += 1;
            setLibraryLoadingText(
              t("app.batchDeleteProgress", { done, total: list.length }),
            );
          } catch (error) {
            setProgressText(
              t("app.batchDeleteFail", {
                msg: error.response?.data?.detail || error.message,
              }),
              { isError: true },
            );
            await refreshDemoLibrary(libraryPage, { manageLoading: false });
            return;
          }
        }
        setSelectedLibraryDemoIds(new Set());
        setProgressText(t("app.batchDeleteDone", { n: list.length }));
        await refreshDemoLibrary(libraryPage, { manageLoading: false });
      } finally {
        setLibraryLoadingOverlay(false);
        setLibraryLoadingText(t("app.libraryLoadingDemo"));
      }
    },
    [libraryPage, refreshDemoLibrary, setProgressText, t],
  );

  const handleSaveLibraryRename = useCallback(async () => {
    if (!libraryRename) return;
    try {
      await API.patch(`/demos/${libraryRename.id}`, {
        display_name: libraryRename.draft,
      });
      setLibraryRename(null);
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
    } catch (error) {
      setProgressText(
        t("app.renameFail", { msg: error.response?.data?.detail || error.message }),
        { isError: true },
      );
    }
  }, [libraryPage, libraryRename, refreshDemoLibrary, setProgressText, t]);

  const handleLoadDemoFromLibrary = useCallback(
    async (items, opts = {}) => {
      const { resolvedByDemoId, skipLoadingOverlay = false } = opts;
      if (!skipLoadingOverlay) {
        setLibraryLoadingOverlay(true);
        setLibraryLoadingText(t("app.libraryLoadingDemo"));
      }
      try {
        const list = Array.isArray(items) ? items : [items];
        const loaded = await Promise.all(
          list.map(async (item) => {
            const playersResult =
              item.players != null
                ? { players: item.players, match_meta: item.match_meta }
                : (await API.get(`/demos/${item.id}/players`)).data;
            return buildLoadedLibraryDemo(item, playersResult);
          }),
        );

        resetDemoAnalysisDefaultView(loaded);
        const handoff = prepareLibraryAnalysisHandoff(loaded, resolvedByDemoId);
        setUploadedDemos(loaded);
        setParsedMatches(handoff.parsedMatches);
        setLibraryDemoIdsByIndex(handoff.libraryDemoIdsByIndex);
        setCurrentMatchIndex(0);
        setSelectedPlayers(handoff.selectedPlayers);
        setActivePlayerTabs({});
        setFreezeToDeathRoundsByMatch(handoff.freezeToDeathRoundsByMatch);
        setSelectedClientClipUids(new Set());
        setProgressText("");
        navigate("/analysis");
        return loaded;
      } catch (error) {
        setProgressText(
          t("app.libraryLoadFail", { msg: demoBatchFailureMessage(error, t) }),
          { isError: true },
        );
        return null;
      } finally {
        if (!skipLoadingOverlay) {
          setLibraryLoadingOverlay(false);
          setLibraryLoadingText(t("app.libraryLoadingDemo"));
        }
      }
    },
    [
      navigate,
      setActivePlayerTabs,
      setCurrentMatchIndex,
      setFreezeToDeathRoundsByMatch,
      setParsedMatches,
      setProgressText,
      setSelectedClientClipUids,
      setSelectedPlayers,
      setUploadedDemos,
      t,
    ],
  );

  const handleLoadSelectedLibraryDemos = useCallback(async () => {
    const ids = Array.from(selectedLibraryDemoIds);
    if (!ids.length) return;
    setLibraryLoadingOverlay(true);
    setLibraryLoadingText(t("app.libraryLoadingDemo"));
    try {
      ids.sort((a, b) => Number(a) - Number(b));
      const { data } = await API.post("/demos/batch-summary", { ids });
      const failedItems = Array.isArray(data.failed) ? data.failed : [];
      if (!data.items?.length) {
        setBatchLoadError({
          open: true,
          failed: normalizeDemoBatchFailures(failedItems, t, "library"),
          mode: "analysis",
        });
        return;
      }
      const loaded = await handleLoadDemoFromLibrary(data.items, {
        skipLoadingOverlay: true,
      });
      if (loaded?.length) {
        const idMap = Object.fromEntries(
          loaded.map((demo, index) => [index, demo.id]),
        );
        setLibraryLoadingOverlay(false);
        await autoParseLoadedDemosRef.current?.(loaded, idMap, failedItems);
      }
    } catch (error) {
      const failed = error.response?.data?.detail?.failed;
      if (Array.isArray(failed) && failed.length) {
        setBatchLoadError({
          open: true,
          failed: normalizeDemoBatchFailures(failed, t, "library"),
          mode: "load",
        });
      } else {
        setProgressText(
          t("app.libraryLoadSelectedFail", {
            msg: demoBatchFailureMessage(error, t),
          }),
          { isError: true },
        );
      }
    } finally {
      setLibraryLoadingOverlay(false);
    }
  }, [
    autoParseLoadedDemosRef,
    handleLoadDemoFromLibrary,
    selectedLibraryDemoIds,
    setProgressText,
    t,
  ]);

  const selectLibraryPage = useCallback(() => {
    setSelectedLibraryDemoIds((previous) => {
      const next = new Set(previous);
      for (const item of demoLibraryItems) next.add(item.id);
      return next;
    });
  }, [demoLibraryItems]);

  const selectAllLibraryDemos = useCallback(async () => {
    try {
      const cap = 1000;
      const wanted = libraryTotal != null ? Math.min(libraryTotal, cap) : cap;
      const params = { limit: wanted, offset: 0 };
      if (librarySearchQ) params.q = librarySearchQ;
      appendFilterParams(params);
      const { data } = await API.get("/demos/ids", { params });
      setSelectedLibraryDemoIds(new Set(data.ids || []));
      if (libraryTotal != null && libraryTotal > cap) {
        setProgressText(t("app.librarySelectAllCapped", { cap }));
      }
    } catch (error) {
      setProgressText(
        t("app.librarySelectAllFail", {
          msg: error.response?.data?.detail || error.message,
        }),
        { isError: true },
      );
    }
  }, [appendFilterParams, librarySearchQ, libraryTotal, setProgressText, t]);

  const clearLibrarySelection = useCallback(() => {
    setSelectedLibraryDemoIds(new Set());
  }, []);

  return {
    demoLibraryItems,
    libraryLoading,
    libraryScanning,
    libraryLoadingOverlay,
    libraryLoadingText,
    libraryPage,
    setLibraryPage,
    libraryHasNextPage,
    libraryTotal,
    selectedLibraryDemoIds,
    setSelectedLibraryDemoIds,
    libraryDemoIdsByIndex,
    libraryRename,
    setLibraryRename,
    libraryDeletePrompt,
    setLibraryDeletePrompt,
    librarySearchInput,
    setLibrarySearchInput,
    librarySearchQ,
    setLibrarySearchQ,
    libraryAdvFilters,
    setLibraryAdvFilters,
    libraryJumpDraft,
    setLibraryJumpDraft,
    libraryPageSize,
    setLibraryPageSize,
    libraryTotalPages,
    batchLoadError,
    setBatchLoadError,
    hasLibraryAdvancedFilters,
    refreshDemoLibrary,
    handleLibrarySearchSubmit,
    handleLibraryPageJump,
    handleScanDemos,
    handleDeleteDemo,
    handleDeleteDemoFile,
    handleLibraryBatchDelete,
    handleSaveLibraryRename,
    handleLoadDemoFromLibrary,
    handleLoadSelectedLibraryDemos,
    selectLibraryPage,
    selectAllLibraryDemos,
    clearLibrarySelection,
  };
}
