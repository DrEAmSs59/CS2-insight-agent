import { useCallback, useEffect, useRef, useState } from "react";

import API from "../../api/api";
import { useLocaleStore } from "../../i18n/localeStore";
import { ensureClientClipUidsOnClips } from "../../utils/clipClientUid";
import {
  DEMO_ANALYSIS_REQUEST_TIMEOUT_MS,
  demoBatchFailureMessage,
  normalizeDemoBatchFailures,
} from "../../utils/demoBatchFailures";
import { freezeToDeathDraftFromClipFilter } from "../../utils/freezeToDeathRoundFilter";
import { playerIdentityKey } from "../../utils/playerIdentity";
import { buildPendingDemoAnalysisSpecs, demoAnalysisRoster } from "./state/analysisCache";

const LIBRARY_PARSE_CONCURRENCY = 2;

async function runAnalysisTasks(limit, items, work) {
  if (!items.length) return;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Owns Demo Analysis I/O and request lifecycle.
 *
 * Analysis session data remains supplied by App because Demo Library intentionally hands
 * loaded sessions into it. Recording/LiteCut state is not accepted here, keeping parsing
 * independent from downstream clip production.
 */
export function useDemoAnalysisWorkflows({
  t,
  navigate,
  setProgressText,
  setBatchLoadError,
  aiMode,
  uploadedDemos,
  setUploadedDemos,
  parsedMatches,
  setParsedMatches,
  currentMatchIndex,
  setCurrentMatchIndex,
  selectedPlayers,
  setSelectedPlayers,
  freezeToDeathRoundsByMatch,
  setFreezeToDeathRoundsByMatch,
  setActivePlayerTabs,
  setSelectedClientClipUids,
  libraryDemoIdsByIndex,
  setLibraryDemoIdsByIndex,
  autoParseLoadedDemosRef,
}) {
  const [parsing, setParsing] = useState(false);
  const [parsingByIndex, setParsingByIndex] = useState({});
  const [analysisInlineProgress, setAnalysisInlineProgress] = useState(null);
  const [aiReviewingPlayers, setAiReviewingPlayers] = useState({});
  const currentMatchIndexRef = useRef(currentMatchIndex);
  const aiReviewInFlightRef = useRef(new Set());

  useEffect(() => {
    currentMatchIndexRef.current = currentMatchIndex;
    setAnalysisInlineProgress(null);
  }, [currentMatchIndex]);

  const handleUpload = useCallback(async (files) => {
    const list = Array.isArray(files) ? files : [files];
    if (!list.length) return;

    setProgressText(t("app.uploadingDemo"), { loading: true });
    setParsing(true);

    try {
      const sourcePaths = list.map((file) => {
        if (typeof file === "string") return file;
        try {
          return window.electron?.getPathForFile?.(file) || "";
        } catch {
          return "";
        }
      });
      let data;
      if (sourcePaths.every(Boolean)) {
        ({ data } = await API.post("/demo/open-local", { paths: sourcePaths }));
      } else {
        const formData = new FormData();
        list.forEach((file) => formData.append("files", file));
        formData.append("source_paths_json", JSON.stringify(sourcePaths));
        ({ data } = await API.post("/demo/upload-multiple", formData));
      }
      const uploads = data.uploads ?? [];
      const preparationFailures = Array.isArray(data.failed) ? data.failed : [];
      if (!uploads.length) {
        const failed = normalizeDemoBatchFailures(preparationFailures, t, "upload");
        setAnalysisInlineProgress({ active: false, text: t("app.autoParseNoUsable") });
        setProgressText(t("app.autoParseNoUsable"), { isError: true });
        if (failed.length) {
          setBatchLoadError({ open: true, failed, mode: "analysis" });
        }
        return;
      }

      setUploadedDemos(uploads);
      setParsedMatches(uploads.map(() => null));
      setLibraryDemoIdsByIndex({});
      setCurrentMatchIndex(0);
      const selectedMap = {};
      uploads.forEach((upload, index) => {
        selectedMap[index] = (upload.players || [])
          .map(playerIdentityKey)
          .filter((name) => typeof name === "string" && name.trim());
      });
      setSelectedPlayers(selectedMap);
      setActivePlayerTabs({});
      setFreezeToDeathRoundsByMatch({});
      setSelectedClientClipUids(new Set());
      const uploadDoneMessage = uploads.length > 1
        ? t("app.uploadDoneMulti", { n: uploads.length })
        : t("app.uploadDoneSingle");
      setProgressText("");
      setAnalysisInlineProgress({ active: false, text: uploadDoneMessage });
      navigate("/analysis");
      await autoParseLoadedDemosRef.current?.(uploads, {}, preparationFailures);
    } catch (error) {
      setProgressText(t("app.uploadFail", { msg: demoBatchFailureMessage(error, t) }), {
        isError: true,
      });
    } finally {
      setParsing(false);
    }
  }, [
    autoParseLoadedDemosRef,
    navigate,
    setActivePlayerTabs,
    setBatchLoadError,
    setCurrentMatchIndex,
    setFreezeToDeathRoundsByMatch,
    setLibraryDemoIdsByIndex,
    setParsedMatches,
    setProgressText,
    setSelectedClientClipUids,
    setSelectedPlayers,
    setUploadedDemos,
    t,
  ]);

  const handleParseForIndex = useCallback(async (index, playerListOverride = null, context = null) => {
    const demos = context?.demos ?? uploadedDemos;
    const demoIds = context?.libraryDemoIdsByIndex ?? libraryDemoIdsByIndex;
    const quietProgress = Boolean(context?.suppressProgressText);
    if (!demos?.length) return undefined;
    const names = playerListOverride != null
      ? playerListOverride
      : (selectedPlayers[index] ?? []);
    if (!names.length) return undefined;
    const filename = demos[index]?.filename;
    if (!filename) return undefined;

    setParsingByIndex((previous) => ({ ...previous, [index]: true }));
    const viewingHere = currentMatchIndexRef.current === index;
    if (viewingHere && !quietProgress) {
      setProgressText("");
      setAnalysisInlineProgress({ active: true, text: t("app.parsingDemo", { fn: filename }) });
      setSelectedClientClipUids(new Set());
    }

    try {
      const activeLibraryDemoId = demoIds[index] ?? demos[index]?.id;
      const body = {
        target_players: names,
        locale: useLocaleStore.getState().locale,
      };
      const roundConfig = freezeToDeathRoundsByMatch[index] ?? { picked: [] };
      const pickedRounds = [...(roundConfig.picked || [])].sort((a, b) => a - b);
      body.freeze_to_death_rounds = pickedRounds.length ? pickedRounds : null;
      const { data } = activeLibraryDemoId
        ? await API.post(`/demos/${activeLibraryDemoId}/analyze`, body, {
            timeout: DEMO_ANALYSIS_REQUEST_TIMEOUT_MS,
          })
        : await API.post(
            `/demo/parse-multi?filename=${encodeURIComponent(filename)}&path=${encodeURIComponent(demos[index]?.path || filename)}`,
            body,
            { timeout: DEMO_ANALYSIS_REQUEST_TIMEOUT_MS },
          );

      const processedPlayers = {};
      for (const [playerName, playerData] of Object.entries(data.players ?? {})) {
        processedPlayers[playerName] = {
          ...playerData,
          clips: ensureClientClipUidsOnClips(playerData.clips ?? []),
        };
      }

      setParsedMatches((previous) => {
        const matches = previous && previous.length === demos.length
          ? [...previous]
          : demos.map(() => null);
        const current = matches[index];
        matches[index] = {
          players: { ...(current?.players || {}), ...processedPlayers },
          analysis_workspace: data.analysis_workspace ?? current?.analysis_workspace ?? null,
          has_player_keyboard_input: data.has_player_keyboard_input ?? null,
          demo_path: demos[index].path,
          demo_filename: filename,
        };
        return matches;
      });

      const firstMeta = Object.values(processedPlayers)[0]?.match_meta;
      const maxRounds = Math.max(
        1,
        Math.min(
          64,
          Number(firstMeta?.total_rounds) || Number(demos[index]?.match_meta?.total_rounds) || 24,
        ),
      );
      const referenceClips = processedPlayers[names[0]]?.clips ?? [];
      const compilation = referenceClips.find(
        (clip) => clip.category === "compilation" && clip.compilation_kind === "freeze_to_death",
      );
      setFreezeToDeathRoundsByMatch((previous) => ({
        ...previous,
        [index]: compilation
          ? freezeToDeathDraftFromClipFilter(compilation.freeze_to_death_round_filter, maxRounds)
          : { picked: [] },
      }));

      const rounds = firstMeta?.total_rounds ?? "?";
      const totalRegular = Object.values(processedPlayers).reduce(
        (sum, player) => sum + (player.clips ?? []).filter((clip) => clip.category !== "meme_death").length,
        0,
      );
      const totalMeme = Object.values(processedPlayers).reduce(
        (sum, player) => sum + (player.clips ?? []).filter((clip) => clip.category === "meme_death").length,
        0,
      );
      const playerLabel = names.length === 1
        ? names[0]
        : t("app.parseDonePlayerCount", { n: names.length });
      const doneMessage = totalMeme > 0
        ? t("app.parseDoneWithMeme", {
            fn: filename,
            rounds,
            playerLabel,
            totalRegular,
            totalMeme,
          })
        : t("app.parseDone", { fn: filename, rounds, playerLabel, totalRegular });
      if (!quietProgress) {
        if (viewingHere) setAnalysisInlineProgress({ active: false, text: doneMessage });
        else setProgressText((previous) => (previous ? `${previous}\n${doneMessage}` : doneMessage));
      }
      return { ok: true };
    } catch (error) {
      const reason = demoBatchFailureMessage(error, t);
      const message = t("app.parseFail", { fn: filename, msg: reason });
      if (!quietProgress) {
        if (viewingHere) setAnalysisInlineProgress({ active: false, text: message });
        else setProgressText((previous) => (previous ? `${previous}\n${message}` : message));
      }
      return { ok: false, reason };
    } finally {
      setParsingByIndex((previous) => {
        const next = { ...previous };
        delete next[index];
        return next;
      });
    }
  }, [
    freezeToDeathRoundsByMatch,
    libraryDemoIdsByIndex,
    selectedPlayers,
    setFreezeToDeathRoundsByMatch,
    setParsedMatches,
    setProgressText,
    setSelectedClientClipUids,
    t,
    uploadedDemos,
  ]);

  const handleParse = useCallback(async () => {
    await handleParseForIndex(currentMatchIndex, null, null);
  }, [currentMatchIndex, handleParseForIndex]);

  const autoParseLoadedDemos = useCallback(async (
    loaded,
    demoIdsByIndex = {},
    initialFailures = [],
  ) => {
    const demos = Array.isArray(loaded) ? loaded : [];
    const specs = buildPendingDemoAnalysisSpecs(demos);
    const inferredFailures = demos
      .map((demo, index) => ({ demo, index }))
      .filter(({ demo }) => demoAnalysisRoster(demo).length === 0)
      .map(({ demo, index }) => ({
        id: demo?.id ?? `roster-${index}`,
        filename: demo?.filename || `Demo ${index + 1}`,
        code: demo?.inspection_error?.code || "DEMO_INSPECTION_FAILED",
      }));
    const failures = normalizeDemoBatchFailures(
      [...(Array.isArray(initialFailures) ? initialFailures : []), ...inferredFailures],
      t,
      "analysis",
    );
    if (!specs.length) {
      setAnalysisInlineProgress({
        active: false,
        text: failures.length ? t("app.autoParseNoUsable") : "",
      });
      if (failures.length) {
        setBatchLoadError({ open: true, failed: failures, mode: "analysis" });
      }
      return;
    }

    let done = failures.length;
    let succeeded = 0;
    const activeNames = new Set();
    const total = specs.length + failures.length;
    const totalPlayers = specs.reduce((sum, spec) => sum + spec.players.length, 0);
    setAnalysisInlineProgress({
      active: true,
      text: t("app.autoParseStart", { demos: total, players: totalPlayers }),
    });
    const context = {
      demos,
      libraryDemoIdsByIndex: demoIdsByIndex,
      suppressProgressText: true,
    };

    const showRunningProgress = () => {
      setAnalysisInlineProgress({
        active: done < total,
        text: t("app.autoParseProgressDetail", {
          done,
          total,
          failed: failures.length,
          active: Array.from(activeNames).join("、") || t("app.autoParsePreparing"),
        }),
      });
    };

    await runAnalysisTasks(LIBRARY_PARSE_CONCURRENCY, specs, async (spec) => {
      const filename = demos[spec.index]?.filename || `Demo ${spec.index + 1}`;
      activeNames.add(filename);
      showRunningProgress();
      const result = await handleParseForIndex(spec.index, spec.players, context);
      activeNames.delete(filename);
      done += 1;
      if (result?.ok) {
        succeeded += 1;
      } else {
        failures.push({
          id: demos[spec.index]?.id ?? `analysis-${spec.index}`,
          filename,
          reason: result?.reason || t("api.err.demoAnalysisFailed"),
        });
      }
      setAnalysisInlineProgress({
        active: done < total,
        text: done < total
          ? t("app.autoParseProgressDetail", {
              done,
              total,
              failed: failures.length,
              active: Array.from(activeNames).join("、") || t("app.autoParsePreparing"),
            })
          : failures.length === 0
            ? t("app.autoParseDone", { demos: specs.length, players: totalPlayers })
            : t("app.autoParsePartial", { succeeded, failed: failures.length }),
      });
    });
    if (failures.length) {
      setBatchLoadError({ open: true, failed: failures, mode: "analysis" });
    }
  }, [handleParseForIndex, setBatchLoadError, t]);
  autoParseLoadedDemosRef.current = autoParseLoadedDemos;

  const ensurePlayerAiReview = useCallback(async (playerName, matchIndex = currentMatchIndex) => {
    const name = String(playerName || "").trim();
    if (!aiMode || !name) return false;
    const playerData = parsedMatches?.[matchIndex]?.players?.[name];
    const clipsToReview = Array.isArray(playerData?.clips) ? playerData.clips : [];
    if (!clipsToReview.length) return false;
    const alreadyReviewed = Boolean(playerData?.ai_reviewed) || clipsToReview.some((clip) => (
      clip?.ai_score != null || String(clip?.ai_commentary || clip?.ai_comment || "").trim()
    ));
    if (alreadyReviewed) return true;

    const requestKey = `${matchIndex}:${name}`;
    if (aiReviewInFlightRef.current.has(requestKey)) return false;
    aiReviewInFlightRef.current.add(requestKey);
    setAiReviewingPlayers((previous) => ({ ...previous, [requestKey]: true }));
    try {
      const { data } = await API.post("/demo/review-clips", {
        clips: clipsToReview,
        match_meta: playerData?.match_meta || {},
        locale: useLocaleStore.getState().locale,
      });
      const reviewedClips = ensureClientClipUidsOnClips(data?.clips || clipsToReview);
      setParsedMatches((previous) => {
        if (!Array.isArray(previous) || !previous[matchIndex]?.players?.[name]) return previous;
        const next = [...previous];
        const current = next[matchIndex];
        next[matchIndex] = {
          ...current,
          players: {
            ...current.players,
            [name]: {
              ...current.players[name],
              clips: reviewedClips,
              ai_reviewed: true,
            },
          },
        };
        return next;
      });
      return true;
    } catch (error) {
      setProgressText(t("app.aiReviewFailed", {
        message: error.response?.data?.detail || error.message || t("common.requestFail"),
      }), { isError: true });
      return false;
    } finally {
      aiReviewInFlightRef.current.delete(requestKey);
      setAiReviewingPlayers((previous) => {
        const next = { ...previous };
        delete next[requestKey];
        return next;
      });
    }
  }, [aiMode, currentMatchIndex, parsedMatches, setParsedMatches, setProgressText, t]);

  const resetAnalysisWorkflow = useCallback(() => {
    setAiReviewingPlayers({});
    aiReviewInFlightRef.current.clear();
    setAnalysisInlineProgress(null);
    setParsingByIndex({});
  }, []);

  return {
    parsing,
    parsingByIndex,
    analysisInlineProgress,
    aiReviewingPlayers,
    handleUpload,
    handleParse,
    ensurePlayerAiReview,
    resetAnalysisWorkflow,
  };
}
