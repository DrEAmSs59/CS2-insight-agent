/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import API from "../api/api.js";
import { useT } from "../i18n/useT.js";
import { playerAliasError } from "../utils/playerAliases.js";
import { SETTINGS_INPUT_CLASS, Segmented, SelectInput, SettingsButton, SettingsNote, SettingsRow, SettingsSubhead, Switch } from "../pages/settings/SettingsControls.jsx";

/** Only the per-demo name map leaves this component; identity is never editable. */
export default function PlayerAliasesSection({ demos = [], value, onChange, onReadyChange, disabled = false, compact = false, layout = "card" }) {
  const t = useT();
  const [rosters, setRosters] = useState({});
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selectedDemoKey, setSelectedDemoKey] = useState(null);
  const signature = JSON.stringify(demos);
  const enabled = value?.enabled === true;
  const selectedDemo = demos.find(demo => demo.key === selectedDemoKey) || demos[0];

  useEffect(() => {
    if (!enabled) { onReadyChange?.(true); return undefined; }
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    onReadyChange?.(false);
    const load = async () => {
      try {
        const next = {};
        const targets = JSON.parse(signature);
        if (!targets.length) throw new Error(t("playerAliases.noDemo"));
        for (const target of targets) {
          if (cancelled) return;
          const { data } = await API.post("/demo/alias-roster", target.id ? { id: Number(target.id) } : { path: target.path });
          if (!data?.players?.length) throw new Error(t("playerAliases.noPlayers"));
          next[target.key] = data.players;
        }
        if (!cancelled) { setRosters(next); onReadyChange?.(true); }
      } catch (error) {
        if (!cancelled) setLoadError(typeof error.response?.data?.detail === "string" ? error.response.data.detail : error.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [enabled, signature, revision, onReadyChange, t]);

  const edit = (demo, id, name) => onChange({
    ...value,
    drafts: { ...value.drafts, [demo]: { ...value.drafts?.[demo], [id]: name } },
  });

  if (layout === "rows") return (
    <div className="divide-y divide-cs2-border-subtle" data-testid="player-aliases-section">
      <SettingsRow label={t("playerAliases.title")} description={t("playerAliases.recordingHint")}>
        {enabled ? <SettingsButton variant="ghost" icon={RotateCcw} disabled={disabled} onClick={() => onChange({ ...value, drafts: {} })}>
          {t("playerAliases.reset")}
        </SettingsButton> : null}
        <Switch ariaLabel={t("playerAliases.enable")} checked={enabled} disabled={disabled || !onChange}
          onChange={enabled => onChange({ ...value, enabled, drafts: value?.drafts || {} })} />
      </SettingsRow>
      {enabled ? <>
        {loading ? <SettingsNote role="status">{t("playerAliases.loading")}</SettingsNote> : null}
        {loadError ? <SettingsNote tone="rose" role="alert">
          <p>{loadError}</p>
          <SettingsButton variant="ghost" disabled={disabled} className="mt-2" onClick={() => setRevision(v => v + 1)}>
            {t("playerAliases.retry")}
          </SettingsButton>
        </SettingsNote> : null}
        {!loading && !loadError && demos.length > 1 ? (
          <div className="min-w-0 overflow-x-auto px-4 py-3">
            {demos.length <= 4 ? <div className="w-max min-w-full">
              <Segmented ariaLabel={t("playerAliases.demoLabel")} value={selectedDemo?.key}
                onChange={setSelectedDemoKey} disabled={disabled}
                options={demos.map(demo => ({ value: demo.key, title: demo.label,
                  label: <span className="block max-w-[24rem] truncate">{demo.label}</span> }))} />
            </div> : <SelectInput ariaLabel={t("playerAliases.demoLabel")} value={selectedDemo?.key}
              onChange={setSelectedDemoKey} disabled={disabled} className="w-full"
              options={demos.map(demo => ({ value: demo.key, label: demo.label }))} />}
          </div>
        ) : null}
        {!loading && !loadError ? demos.filter(demo => demo.key === selectedDemo?.key).map(demo => <div key={demo.key} className="divide-y divide-cs2-border-subtle">
          {demos.length === 1 ? <SettingsSubhead><span className="break-all">{demo.label}</span></SettingsSubhead> : null}
          <div className="grid grid-cols-1 gap-px bg-cs2-border-subtle @min-[40rem]/params:grid-cols-2">
          {[2, 3, 0].map(team => {
            const players = (rosters[demo.key] || []).filter(player => {
              const number = Number(demo.playerTeams?.[player.steamid64] ?? player.team_number);
              return (number === 2 || number === 3 ? number : 0) === team;
            });
            if (!players.length) return null;
            const teamName = demo.teamNames?.[team] || (team === 3 ? "CT" : team === 2 ? "T" : t("playerAliases.otherPlayers"));
            return <div key={team} role="group" aria-label={teamName}
              className={`min-w-0 divide-y divide-cs2-border-subtle bg-cs2-bg-card ${team === 0 ? "@min-[40rem]/params:col-span-2" : ""}`}>
              <SettingsSubhead><span className={team === 3 ? "text-cs2-cyan-on-surface" : "text-cs2-amber-on-surface"}>
                {teamName}
              </span></SettingsSubhead>
              {players.map(player => {
                const name = value.drafts?.[demo.key]?.[player.steamid64] || "";
                const error = playerAliasError(name);
                return <SettingsRow key={player.steamid64} label={player.name}
                  tooltip={`${player.name} · ${player.steamid64}`}
                  footer={error ? <p role="alert" className="text-xs text-cs2-text-error">{t(error)}</p> : null}>
                  <input type="text" value={name} disabled={disabled} spellCheck={false}
                    aria-label={t("playerAliases.inputLabel", { name: player.name })} aria-invalid={!!error}
                    placeholder={t("playerAliases.placeholder")}
                    onChange={event => edit(demo.key, player.steamid64, event.target.value)}
                    className={`${error ? SETTINGS_INPUT_CLASS.replace("border-cs2-border", "border-cs2-border-error") : SETTINGS_INPUT_CLASS} w-40 max-w-full`} />
                </SettingsRow>;
              })}
            </div>;
          })}
          </div>
        </div>) : null}
      </> : null}
    </div>
  );

  return (
    <section className="rounded-xl border border-cs2-border bg-cs2-bg-card/50 p-4" data-testid="player-aliases-section">
      <div className="flex items-center gap-3">
        <Pencil className="h-5 w-5 shrink-0 text-cs2-accent" />
        <div className="min-w-0 flex-1">
          <h3 className={`${compact ? "text-[12px]" : ""} font-bold text-cs2-text-primary`}>{t("playerAliases.title")}</h3>
          <p className={`${compact ? "mt-0.5 text-[10px] leading-relaxed" : "mt-1 text-xs"} text-cs2-text-muted`}>{t("playerAliases.hint")}</p>
        </div>
        <label className={`flex shrink-0 items-center gap-2 ${compact ? "text-xs font-semibold" : "text-sm"}`}>
          <input type="checkbox" checked={enabled} disabled={disabled || !onChange} className="accent-cs2-accent"
            aria-label={t("playerAliases.enable")}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked, drafts: value?.drafts || {} })} />
          {t("playerAliases.enable")}
        </label>
      </div>
      {enabled && (
        <div className="mt-4 space-y-4 border-t border-cs2-border pt-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs leading-relaxed text-cs2-text-muted">{t("playerAliases.rules")}</p>
            <button type="button" disabled={disabled} onClick={() => onChange({ ...value, drafts: {} })}
              className="flex shrink-0 items-center gap-1 text-xs text-cs2-accent">
              <RotateCcw className="h-3 w-3" />{t("playerAliases.reset")}
            </button>
          </div>
          {loading && <p role="status" className="text-sm text-cs2-text-muted">{t("playerAliases.loading")}</p>}
          {loadError && <div role="alert" className="text-sm text-cs2-text-error">{loadError}
            <button type="button" className="ml-3 underline" onClick={() => setRevision((v) => v + 1)}>{t("playerAliases.retry")}</button>
          </div>}
          {!loading && !loadError && demos.map((demo) => (
            <div key={demo.key} className="space-y-3">
              <p className="break-all text-sm font-semibold text-cs2-text-primary">{demo.label}</p>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[2, 3, 0].map((team) => {
                  const players = (rosters[demo.key] || []).filter((p) => (p.team_number === 2 || p.team_number === 3 ? p.team_number : 0) === team);
                  if (!players.length) return null;
                  return <fieldset key={team} className="min-w-0 rounded-lg border border-cs2-border p-3">
                    <legend className={`px-1 text-xs font-bold ${team === 3 ? "text-[var(--cs2-cyan-on-surface)]" : "text-[var(--cs2-amber-on-surface)]"}`}>
                      {team === 3 ? "CT" : team === 2 ? "T" : t("playerAliases.otherPlayers")}
                    </legend>
                    <div className="space-y-3">{players.map((player) => {
                      const name = value.drafts?.[demo.key]?.[player.steamid64] || "";
                      const error = playerAliasError(name);
                      return <label key={player.steamid64} className="block min-w-0">
                        <span className="mb-1 block truncate text-xs text-cs2-text-muted" title={`${player.name} · ${player.steamid64}`}>{player.name}</span>
                        <input type="text" value={name} disabled={disabled} spellCheck={false}
                          aria-label={t("playerAliases.inputLabel", { name: player.name })} aria-invalid={!!error}
                          placeholder={t("playerAliases.placeholder")}
                          onChange={(event) => edit(demo.key, player.steamid64, event.target.value)}
                          className={`w-full min-w-0 rounded border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary outline-none focus:border-cs2-accent ${error ? "border-red-400" : "border-cs2-border"}`} />
                        {error && <span role="alert" className="mt-1 block text-xs text-cs2-text-error">{t(error)}</span>}
                      </label>;
                    })}</div>
                  </fieldset>;
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
