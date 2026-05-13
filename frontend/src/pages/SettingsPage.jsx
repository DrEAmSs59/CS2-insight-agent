import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useAppShell } from "../context/AppShellContext";
import {
  Brain,
  Zap,
  Eye,
  EyeOff,
  Check,
  Server,
} from "lucide-react";

const API = axios.create({ baseURL: "/api" });

function llmBaseUrlLooksLocal(baseUrl) {
  try {
    const u = String(baseUrl || "").trim();
    if (!u) return false;
    const withProto = u.includes("://") ? u : `http://${u}`;
    const host = new URL(withProto).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function parsePlayerLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {"ok"|"warn"|"err"|"muted"} tone */
function StatusLine({ tone, children }) {
  const dot =
    tone === "ok"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.45)]"
      : tone === "warn"
        ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.35)]"
        : tone === "err"
          ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.35)]"
          : "bg-zinc-500";
  return (
    <div className="flex items-start gap-2 text-[11px] leading-snug text-zinc-300">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function SettingsCard({ title, hint, children, className = "", fill = false }) {
  return (
    <section
      className={`rounded-xl border border-white/[0.08] bg-cs2-bg-card/90 p-3 shadow-sm shadow-black/20 sm:p-4 ${
        fill
          ? "flex min-h-0 flex-col @min-[52rem]/settings:flex-1"
          : "flex flex-col"
      } ${className}`}
    >
      <div className="mb-3 shrink-0">
        <h2 className="text-[13px] font-bold tracking-wide text-zinc-100">{title}</h2>
        {hint ? <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{hint}</p> : null}
      </div>
      {fill ? (
        <div className="flex min-h-0 flex-col @min-[52rem]/settings:flex-1">{children}</div>
      ) : (
        children
      )}
    </section>
  );
}

function SecondaryButton({ children, className = "", ...rest }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[11px] font-semibold text-zinc-200 transition-colors hover:border-cs2-orange/45 hover:text-white disabled:opacity-45 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function PrimaryButton({ children, className = "", ...rest }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md bg-cs2-orange px-4 py-2.5 text-xs font-bold text-black shadow-md shadow-cs2-orange/25 transition-colors hover:bg-cs2-orange/90 disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function PathFieldRow({ label, value, placeholder, onChange, onBlurSave, onPastePath }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">{label}</label>
      <div className="flex min-w-0 flex-col gap-2 @min-[28rem]/settings:flex-row @min-[28rem]/settings:items-stretch">
        <input
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlurSave}
          className="min-w-0 w-full flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2.5 font-mono text-[11px] text-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none sm:text-[12px]"
        />
        <SecondaryButton
          type="button"
          className="w-full shrink-0 px-2.5 py-2 @min-[28rem]/settings:w-auto"
          onClick={onPastePath}
          title="从剪贴板粘贴完整路径"
        >
          粘贴路径
        </SecondaryButton>
      </div>
    </div>
  );
}

function SmallField({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">{label}</label>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const s = useAppShell();
  const [setup, setSetup] = useState(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [players, setPlayers] = useState(() => parsePlayerLines(s.expectedParsePlayersText));
  const [playerDraft, setPlayerDraft] = useState("");

  useEffect(() => {
    setPlayers(parsePlayerLines(s.expectedParsePlayersText));
  }, [s.expectedParsePlayersText]);

  const refreshSetup = useCallback(async () => {
    try {
      const { data } = await API.get("status/setup");
      setSetup(data);
    } catch {
      setSetup(null);
    }
  }, []);

  useEffect(() => {
    void refreshSetup();
    const id = window.setInterval(() => void refreshSetup(), 10000);
    return () => window.clearInterval(id);
  }, [refreshSetup]);

  const isLocal = llmBaseUrlLooksLocal(s.llmConfig.base_url);

  const schedulePersistLlm = () => {
    queueMicrotask(() => void s.persistLlmConfig());
  };

  const cs2Status = useMemo(() => {
    if (!setup) return { tone: "muted", text: "CS2：检测中…" };
    if (setup.cs2_path_ok) return { tone: "ok", text: "CS2：已检测到可执行文件" };
    if (String(s.cs2Path || "").trim())
      return { tone: "warn", text: "CS2：路径已填但文件不存在或不可访问" };
    return { tone: "err", text: "CS2：未配置" };
  }, [setup, s.cs2Path]);

  const ffmpegStatus = useMemo(() => {
    if (!setup) return { tone: "muted", text: "FFmpeg：检测中…" };
    if (setup.ffmpeg_ok) return { tone: "ok", text: "FFmpeg：编码器 / 可执行文件可用" };
    return { tone: "warn", text: "FFmpeg：未在 PATH 或自定义路径中找到" };
  }, [setup]);

  const aiRowStatus = useMemo(() => {
    if (!s.aiMode) return { tone: "muted", text: "AI：极速本地（未启用云端锐评）" };
    if (isLocal) {
      return { tone: "ok", text: "AI：本机接口（可不填密钥）" };
    }
    if (!setup) return { tone: "muted", text: "AI：检测中…" };
    if (setup.ai_key_ok || s.llmKeySavedOnServer) {
      return { tone: "ok", text: "AI：已配置网关与密钥" };
    }
    return { tone: "warn", text: "AI：请填写并保存 API 密钥" };
  }, [s.aiMode, s.llmKeySavedOnServer, setup, isLocal]);

  const handlePasteCs2 = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) {
        s.setCs2Path(t);
        await s.handleSaveConfig({ cs2_path: t });
      }
    } catch {
      s.setProgressText("无法读取剪贴板，请手动粘贴路径。");
    }
  };

  const handlePasteFfmpeg = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) {
        s.setFfmpegPath(t);
        await s.handleSaveConfig({ ffmpeg_path: t });
      }
    } catch {
      s.setProgressText("无法读取剪贴板，请手动粘贴路径。");
    }
  };

  const addPlayer = (name) => {
    const n = String(name || "").trim();
    if (!n) return;
    if (players.includes(n)) {
      setPlayerDraft("");
      return;
    }
    if (players.length >= 50) return;
    setPlayers((p) => [...p, n]);
    setPlayerDraft("");
  };

  const removePlayer = (name) => {
    setPlayers((p) => p.filter((x) => x !== name));
  };

  const editPlayer = (name) => {
    const next = window.prompt("编辑昵称", name);
    if (next == null) return;
    const t = String(next).trim();
    if (!t || t === name) return;
    setPlayers((p) => p.map((x) => (x === name ? t : x)));
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-cs2-bg-dark">
      <header className="shrink-0 border-b border-white/10 bg-cs2-bg-dark/95 px-4 py-3 backdrop-blur-sm sm:px-5">
        <div className="w-full min-w-0">
          <h1 className="text-lg font-bold tracking-tight text-white">设置中心</h1>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-zinc-500">
            管理 CS2、FFmpeg、AI 洞察与录制相关选项。
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 min-[420px]:grid-cols-3 min-[420px]:gap-x-3">
            <StatusLine tone={cs2Status.tone}>{cs2Status.text}</StatusLine>
            <StatusLine tone={ffmpegStatus.tone}>{ffmpegStatus.text}</StatusLine>
            <StatusLine
              tone={
                aiRowStatus.tone === "err"
                  ? "err"
                  : aiRowStatus.tone === "warn"
                    ? "warn"
                    : aiRowStatus.tone === "ok"
                      ? "ok"
                      : "muted"
              }
            >
              {aiRowStatus.text}
            </StatusLine>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">
          <div className="@container/settings flex min-h-0 w-full min-w-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-4">
            <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 pb-5 @min-[52rem]/settings:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @min-[52rem]/settings:items-stretch @min-[52rem]/settings:gap-5 @min-[52rem]/settings:pb-6">
              <div className="flex min-w-0 flex-col gap-3 @min-[52rem]/settings:min-h-0 @min-[52rem]/settings:flex-1 @min-[52rem]/settings:gap-4">
            <SettingsCard
              title="运行模式"
              hint="切换后会影响解析是否请求大模型；AI 模式需配置密钥。"
              fill
            >
              <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 @min-[36rem]/settings:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void s.handleAiModeChange(false)}
                  className={`relative flex min-h-[5.5rem] flex-1 flex-col rounded-lg border p-3 text-left transition-all @min-[36rem]/settings:min-h-[7.5rem] sm:min-h-[8rem] ${
                    !s.aiMode
                      ? "border-cs2-orange bg-cs2-orange/12 shadow-[0_0_0_1px_rgba(255,140,0,0.35)]"
                      : "border-white/[0.08] bg-black/20 hover:border-white/15"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Zap className={`h-4 w-4 ${!s.aiMode ? "text-cs2-orange" : "text-zinc-500"}`} />
                    <span className={`text-sm font-bold ${!s.aiMode ? "text-white" : "text-zinc-400"}`}>极速本地</span>
                    {!s.aiMode ? (
                      <Check className="ml-auto h-4 w-4 shrink-0 text-cs2-orange" aria-label="已选中" />
                    ) : null}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">本地规则提取片段，无需 AI</p>
                </button>
                <button
                  type="button"
                  onClick={() => void s.handleAiModeChange(true)}
                  className={`relative flex min-h-[5.5rem] flex-1 flex-col rounded-lg border p-3 text-left transition-all @min-[36rem]/settings:min-h-[7.5rem] sm:min-h-[8rem] ${
                    s.aiMode
                      ? "border-cs2-orange bg-cs2-orange/12 shadow-[0_0_0_1px_rgba(255,140,0,0.35)]"
                      : "border-white/[0.08] bg-black/20 hover:border-white/15"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Brain className={`h-4 w-4 ${s.aiMode ? "text-cs2-orange" : "text-zinc-500"}`} />
                    <span className={`text-sm font-bold ${s.aiMode ? "text-white" : "text-zinc-400"}`}>AI 洞察</span>
                    {s.aiMode ? (
                      <Check className="ml-auto h-4 w-4 shrink-0 text-cs2-orange" aria-label="已选中" />
                    ) : null}
                  </div>
                  <ul className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-zinc-500">
                    <li>· AI 锐评与评分</li>
                  </ul>
                </button>
              </div>
            </SettingsCard>

            <SettingsCard
              title="CS2 路径"
              hint="一键录制依赖本机 CS2；若自动探测失败请粘贴 Steam 库中的 cs2.exe 完整路径。"
              fill
            >
              <div className="flex min-h-0 flex-1 flex-col space-y-3">
                <PathFieldRow
                  label="cs2.exe 完整路径"
                  value={s.cs2Path}
                  placeholder="...\\game\\bin\\win64\\cs2.exe"
                  onChange={s.setCs2Path}
                  onBlurSave={() => void s.handleSaveConfig({ cs2_path: s.cs2Path ?? "" })}
                  onPastePath={() => void handlePasteCs2()}
                />
                <p className="mt-auto text-[10px] leading-relaxed text-zinc-600">
                  可从资源管理器地址栏复制路径，使用「粘贴路径」。
                </p>
              </div>
            </SettingsCard>

            <SettingsCard
              title="关注玩家"
              hint="用于 Demo 库展示名匹配等；不会自动拆高光。最多 50 名。"
              fill
            >
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <div className="flex min-h-[4.5rem] flex-1 flex-wrap content-start gap-2 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/25 p-2 @min-[40rem]/settings:min-h-[6rem] @min-[52rem]/settings:min-h-[8rem]">
                {players.length === 0 ? (
                  <span className="py-1 text-[11px] text-zinc-600">尚未添加玩家</span>
                ) : (
                  players.map((p) => (
                    <span
                      key={p}
                      className="group inline-flex items-center gap-1 rounded-md border border-cs2-orange/30 bg-cs2-orange/10 pl-2 pr-1 py-1 text-[11px] font-semibold text-cs2-orange"
                    >
                      <button
                        type="button"
                        className="max-w-[140px] truncate text-left hover:underline"
                        title="双击编辑"
                        onDoubleClick={() => editPlayer(p)}
                      >
                        {p}
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-white"
                        aria-label={`移除 ${p}`}
                        onClick={() => removePlayer(p)}
                      >
                        ✕
                      </button>
                    </span>
                  ))
                )}
                </div>
              <div className="flex shrink-0 flex-col gap-2 @min-[24rem]/settings:flex-row @min-[24rem]/settings:flex-wrap @min-[24rem]/settings:items-center">
                <input
                  value={playerDraft}
                  onChange={(e) => setPlayerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPlayer(playerDraft);
                    }
                  }}
                  placeholder="输入昵称后回车或点添加"
                  className="min-w-0 w-full flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[12px] text-white placeholder:text-zinc-600 focus:border-cs2-orange/50 focus:outline-none"
                  spellCheck={false}
                />
                <SecondaryButton type="button" className="w-full shrink-0 @min-[24rem]/settings:w-auto" onClick={() => addPlayer(playerDraft)}>
                  ＋ 添加玩家
                </SecondaryButton>
              </div>
              </div>
            </SettingsCard>

              </div>

              {/* 右列 */}
              <div className="flex min-w-0 flex-col gap-3 @min-[52rem]/settings:min-h-0 @min-[52rem]/settings:flex-1 @min-[52rem]/settings:gap-4">
            <SettingsCard title="FFmpeg 与合辑" hint="合辑导出与编码器；fps_max 作用于录制启动时的 CS2。" fill>
              <div className="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto">
                <div className="shrink-0">
                  <PathFieldRow
                    label="FFmpeg 可执行文件（可选）"
                    value={s.ffmpegPath}
                    placeholder="留空则使用 PATH 中的 ffmpeg"
                    onChange={s.setFfmpegPath}
                    onBlurSave={() => void s.handleSaveConfig({ ffmpeg_path: s.ffmpegPath ?? "" })}
                    onPastePath={() => void handlePasteFfmpeg()}
                  />
                </div>
                <div className="shrink-0">
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-cs2-text-secondary">
                    合辑视频编码
                  </label>
                  <select
                    value={s.montageEncoder ?? "auto"}
                    onChange={(e) => s.setMontageEncoder(e.target.value)}
                    onBlur={() => void s.handleSaveConfig({ montage_encoder: s.montageEncoder ?? "auto" })}
                    className="w-full max-w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-white focus:border-cs2-orange/50 focus:outline-none"
                  >
                    <option value="auto">自动（NVENC → QSV → AMF → x264）</option>
                    <option value="h264_nvenc">NVIDIA NVENC</option>
                    <option value="h264_qsv">Intel Quick Sync (QSV)</option>
                    <option value="h264_amf">AMD AMF</option>
                    <option value="libx264">x264 软件（CPU）</option>
                  </select>
                  <p className="mt-1 text-[10px] text-zinc-600">失败时可改用 x264 软件编码。</p>
                </div>
                <div className="shrink-0">
                  <SmallField label="录制帧率上限 fps_max（0=不限制）">
                    <input
                      type="number"
                      min={0}
                      max={9999}
                      step={10}
                      value={s.cs2FpsMax}
                      onChange={(e) => s.setCs2FpsMax(Number(e.target.value))}
                      onBlur={() => void s.handleSaveConfig({ cs2_fps_max: s.cs2FpsMax })}
                      className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white focus:border-cs2-orange/50 focus:outline-none"
                    />
                  </SmallField>
                </div>
                <div className="flex-1" aria-hidden />
              </div>
            </SettingsCard>

            {s.aiMode ? (
              <SettingsCard
                title="大模型（AI）"
                hint="填写 OpenAI 兼容网关的 base URL 与模型 id。密钥在服务器保存后刷新不显示明文。"
                fill
              >
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  <SmallField label="接口地址 (OpenAI 兼容)">
                    <input
                      value={s.llmConfig.base_url || ""}
                      placeholder="https://api.example.com/v1 或 http://127.0.0.1:11434/v1"
                      onChange={(e) => s.setLlmConfig({ ...s.llmConfig, base_url: e.target.value })}
                      onBlur={schedulePersistLlm}
                      className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2.5 font-mono text-[12px] text-white focus:border-cs2-orange/50 focus:outline-none"
                    />
                  </SmallField>
                  <SmallField label="模型名称">
                    <input
                      value={s.llmConfig.model}
                      placeholder="网关上注册的模型名，如 deepseek-chat、gpt-4o-mini"
                      onChange={(e) => s.setLlmConfig({ ...s.llmConfig, model: e.target.value })}
                      onBlur={schedulePersistLlm}
                      className="w-full min-w-0 max-w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white focus:border-cs2-orange/50 focus:outline-none @min-[40rem]/settings:max-w-md"
                    />
                  </SmallField>
                  {isLocal && (
                    <div className="flex items-center gap-1.5 rounded-md border border-cs2-orange/20 bg-cs2-orange/10 px-2.5 py-2">
                      <Server className="h-3 w-3 shrink-0 text-cs2-orange" />
                      <span className="text-[10px] text-cs2-orange">
                        检测到本机地址：可不填 API 密钥（后端使用占位密钥）。请确保兼容服务已启动。
                      </span>
                    </div>
                  )}
                  {!isLocal && (
                    <div>
                      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">API 密钥</label>
                      {s.llmKeySavedOnServer && !s.llmConfig.api_key?.trim() && (
                        <p className="mb-1.5 text-[10px] leading-relaxed text-emerald-500/90">
                          密钥已在服务器保存。更换请输入新密钥后失焦保存。
                        </p>
                      )}
                      <div className="relative min-w-0 w-full max-w-full @min-[40rem]/settings:max-w-xl">
                        <input
                          type={showApiKey ? "text" : "password"}
                          value={s.llmConfig.api_key}
                          placeholder={s.llmKeySavedOnServer && !s.llmConfig.api_key?.trim() ? "留空沿用已保存密钥" : "sk-..."}
                          onChange={(e) => s.setLlmConfig({ ...s.llmConfig, api_key: e.target.value })}
                          onBlur={schedulePersistLlm}
                          className="w-full rounded-md border border-cs2-border bg-cs2-bg-input py-2.5 pl-3 pr-10 font-mono text-[12px] text-white focus:border-cs2-orange/50 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cs2-text-secondary hover:text-white"
                        >
                          {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </SettingsCard>
            ) : null}

            <div className="flex shrink-0 flex-col items-stretch gap-3 rounded-xl border border-cs2-orange/25 bg-cs2-orange/[0.06] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <p className="text-[11px] leading-relaxed text-zinc-400">
                将路径、帧率、编码、关注名单与大模型接口/模型名一次性写入配置文件。
              </p>
              <PrimaryButton
                className="shrink-0 sm:min-w-[140px]"
                onClick={() => void s.handleSaveAllSettingsPage(players)}
              >
                保存设置
              </PrimaryButton>
            </div>

              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
