import { useState } from "react";
import axios from "axios";
import {
  Settings,
  Wifi,
  WifiOff,
  Brain,
  Zap,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Monitor,
  Server,
  FolderOpen,
  ScanSearch,
  Users,
} from "lucide-react";

const PROVIDER_PRESETS = {
  deepseek:    { label: "DeepSeek",        model: "deepseek-chat",          base_url: "https://api.deepseek.com",                  local: false },
  openai:      { label: "OpenAI",          model: "gpt-4o",                base_url: "https://api.openai.com",                    local: false },
  qwen:        { label: "通义千问 (Qwen)", model: "qwen-plus",             base_url: "https://dashscope.aliyuncs.com/compatible-mode", local: false },
  glm:         { label: "智谱 (GLM)",      model: "glm-4-flash",           base_url: "https://open.bigmodel.cn/api/paas",         local: false },
  minimax:     { label: "MiniMax",         model: "MiniMax-Text-01",       base_url: "https://api.minimax.chat",                  local: false },
  openrouter:  { label: "OpenRouter",      model: "deepseek/deepseek-chat",base_url: "https://openrouter.ai/api",                 local: false },
  ollama:      { label: "Ollama (本地)",   model: "qwen2.5:7b",            base_url: "http://localhost:11434",                     local: true  },
  lmstudio:    { label: "LM Studio (本地)",model: "loaded-model",          base_url: "http://localhost:1234",                      local: true  },
};

export default function Sidebar({
  aiMode,
  onAiModeChange,
  obsConfig,
  onObsConfigChange,
  onPersistObs,
  obsPasswordPlaceholder = "",
  onObsPasswordFocus,
  onObsPasswordBlur,
  llmConfig,
  onLlmConfigChange,
  llmKeySavedOnServer = false,
  onPersistLlm,
  cs2Path,
  onCs2PathChange,
  cs2FpsMax = 240,
  onCs2FpsMaxChange,
  demoWatchPaths = [],
  onDemoWatchPathsChange,
  onSaveConfig,
  onDetectCs2,
  onScanDemos,
  demoLibraryLoading = false,
  expectedParsePlayersText = "",
  onExpectedParsePlayersTextChange,
  onSaveExpectedParsePlayers,
}) {
  const [obsOpen, setObsOpen] = useState(true);
  const [cs2Open, setCs2Open] = useState(true);
  const [llmOpen, setLlmOpen] = useState(true);
  const [expectedPlayersOpen, setExpectedPlayersOpen] = useState(true);
  const [obsTestResult, setObsTestResult] = useState(null);
  const [obsTesting, setObsTesting] = useState(false);
  const [detectingCs2, setDetectingCs2] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [watchOpen, setWatchOpen] = useState(true);
  const [watchPathInput, setWatchPathInput] = useState("");

  const handleDetectCs2 = async () => {
    if (!onDetectCs2) return;
    setDetectingCs2(true);
    try {
      await onDetectCs2();
    } finally {
      setDetectingCs2(false);
    }
  };

  const testObs = async () => {
    setObsTesting(true);
    setObsTestResult(null);
    try {
      const { data } = await axios.post("/api/obs/test", obsConfig);
      setObsTestResult(data);
      if (data?.ok) {
        await onPersistObs?.();
      }
    } catch (e) {
      setObsTestResult({ ok: false, error: e?.response?.data?.detail || e.message });
    } finally {
      setObsTesting(false);
    }
  };

  const schedulePersistLlm = () => {
    if (!onPersistLlm) return;
    queueMicrotask(() => {
      void onPersistLlm();
    });
  };

  const handleProviderChange = (provider) => {
    const preset = PROVIDER_PRESETS[provider];
    if (preset) {
      onLlmConfigChange({
        ...llmConfig,
        provider,
        model: preset.model,
        base_url: preset.base_url,
      });
    } else {
      onLlmConfigChange({ ...llmConfig, provider });
    }
    schedulePersistLlm();
  };

  const currentPreset = PROVIDER_PRESETS[llmConfig.provider];
  const isLocal = currentPreset?.local ?? false;

  return (
    <aside className="w-72 bg-cs2-bg-sidebar border-r border-cs2-border flex flex-col overflow-y-auto shrink-0">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-cs2-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-cs2-orange/20 flex items-center justify-center">
            <Monitor className="w-4 h-4 text-cs2-orange" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-wide">CS2 洞察</div>
            <div className="text-[10px] text-cs2-text-secondary font-mono tracking-widest">智能体 v1.1.1</div>
          </div>
        </div>
      </div>

      {/* Mode Switcher */}
      <div className="px-4 py-4 border-b border-cs2-border">
        <div className="text-[10px] font-semibold text-cs2-text-secondary tracking-widest uppercase mb-3">
          分析模式
        </div>
        <div className="grid grid-cols-2 gap-1 bg-cs2-bg-dark rounded-lg p-1">
          <button
            type="button"
            onClick={() => void onAiModeChange(false)}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-semibold transition-all ${
              !aiMode
                ? "bg-cs2-orange text-black shadow-lg shadow-cs2-orange/20"
                : "text-cs2-text-secondary hover:text-white"
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            极速本地
          </button>
          <button
            type="button"
            onClick={() => void onAiModeChange(true)}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-semibold transition-all ${
              aiMode
                ? "bg-cs2-orange text-black shadow-lg shadow-cs2-orange/20"
                : "text-cs2-text-secondary hover:text-white"
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            AI 洞察
          </button>
        </div>
      </div>

      {/* OBS Config */}
      <div className="border-b border-cs2-border">
        <button
          onClick={() => setObsOpen(!obsOpen)}
          className="flex items-center justify-between w-full px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <Settings className="w-3.5 h-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold tracking-wide uppercase text-cs2-text-secondary">
              OBS 连接配置
            </span>
          </div>
          {obsOpen ? (
            <ChevronUp className="w-3.5 h-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {obsOpen && (
          <div className="px-4 pb-4 space-y-3">
            <Input label="主机地址" value={obsConfig.host} onChange={(v) => onObsConfigChange({ ...obsConfig, host: v })} />
            <Input label="端口" value={obsConfig.port} type="number" onChange={(v) => onObsConfigChange({ ...obsConfig, port: Number(v) })} />
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
                密码
              </label>
              <input
                type="password"
                value={obsConfig.password}
                placeholder={obsPasswordPlaceholder}
                onChange={(e) => onObsConfigChange({ ...obsConfig, password: e.target.value })}
                onFocus={() => onObsPasswordFocus?.()}
                onBlur={() => onObsPasswordBlur?.()}
                autoComplete="new-password"
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
              />
            </div>
            <button
              onClick={testObs}
              disabled={obsTesting}
              className="w-full py-2 rounded-md text-xs font-semibold bg-cs2-bg-input border border-cs2-border hover:border-cs2-orange/50 transition-colors disabled:opacity-50"
            >
              {obsTesting ? "测试中..." : "测试连接"}
            </button>
            {obsTestResult && (
              <div className={`text-[11px] font-mono px-2 py-1.5 rounded ${obsTestResult.ok ? "text-cs2-highlight bg-cs2-highlight/10" : "text-cs2-fail bg-cs2-fail/10"}`}>
                {obsTestResult.ok ? (
                  <span className="flex items-center gap-1"><Wifi className="w-3 h-3" /> OBS {obsTestResult.obs_version}</span>
                ) : (
                  <span className="flex items-center gap-1"><WifiOff className="w-3 h-3" /> {obsTestResult.error}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* CS2 路径 — 一键录制启动游戏所需 */}
      <div className="border-b border-cs2-border">
        <button
          type="button"
          onClick={() => setCs2Open(!cs2Open)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">
              CS2 路径
            </span>
          </div>
          {cs2Open ? (
            <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {cs2Open && (
          <div className="space-y-2 px-4 pb-4">
            <Input
              label="cs2.exe 完整路径"
              value={cs2Path ?? ""}
              placeholder="...\\game\\bin\\win64\\cs2.exe"
              onChange={(v) => onCs2PathChange?.(v)}
              onBlur={() => onSaveConfig?.({ cs2_path: cs2Path ?? "" })}
            />
            <div className="space-y-1">
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-cs2-text-secondary">
                录制帧率上限 (fps_max，0=不限制)
              </label>
              <input
                type="number"
                min={0}
                max={9999}
                step={10}
                value={cs2FpsMax}
                onChange={(e) => onCs2FpsMaxChange?.(Number(e.target.value))}
                onBlur={() => onSaveConfig?.({ cs2_fps_max: cs2FpsMax })}
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={handleDetectCs2}
              disabled={detectingCs2}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-orange/50 disabled:opacity-50"
            >
              <ScanSearch className="h-3.5 w-3.5" />
              {detectingCs2 ? "探测中…" : "自动探测"}
            </button>
            <p className="text-[10px] leading-relaxed text-cs2-text-secondary">
              一键录制会启动本机 CS2 播放 Demo。若探测失败，请从 Steam 库右键 CS2 → 管理 → 浏览本地文件，找到
              <span className="font-mono text-zinc-500"> game\bin\win64\cs2.exe </span>
              并粘贴完整路径。
            </p>
          </div>
        )}
      </div>

      <div className="border-b border-cs2-border">
        <button
          type="button"
          onClick={() => setWatchOpen(!watchOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">
              Demo 监听路径
            </span>
          </div>
          {watchOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {watchOpen && (
          <div className="space-y-2 px-4 pb-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={watchPathInput}
                onChange={(e) => setWatchPathInput(e.target.value)}
                placeholder="D:\\SteamLibrary\\...\\csgo"
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
              />
              <button
                type="button"
                className="rounded-md border border-cs2-border bg-cs2-bg-input px-3 text-xs font-semibold hover:border-cs2-orange/50"
                onClick={() => {
                  const p = watchPathInput.trim();
                  if (!p) return;
                  const next = Array.from(new Set([...(demoWatchPaths || []), p]));
                  onDemoWatchPathsChange?.(next);
                  onSaveConfig?.({ demo_watch_paths: next });
                  setWatchPathInput("");
                }}
              >
                添加
              </button>
            </div>
            <div className="space-y-1">
              {(demoWatchPaths || []).map((p) => (
                <div
                  key={p}
                  className="flex items-center justify-between rounded border border-white/10 bg-cs2-bg-input/60 px-2 py-1"
                >
                  <span className="truncate font-mono text-[10px] text-zinc-300">{p}</span>
                  <button
                    type="button"
                    className="text-[10px] text-cs2-fail hover:opacity-80"
                    onClick={() => {
                      const next = (demoWatchPaths || []).filter((x) => x !== p);
                      onDemoWatchPathsChange?.(next);
                      onSaveConfig?.({ demo_watch_paths: next });
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              disabled={demoLibraryLoading}
              onClick={() => void onScanDemos?.()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-orange/50 disabled:opacity-50"
            >
              <ScanSearch className={`h-3.5 w-3.5 ${demoLibraryLoading ? "animate-spin" : ""}`} />
              扫描现有 Demo
            </button>
          </div>
        )}
      </div>

      <div className="border-b border-cs2-border">
        <button
          type="button"
          onClick={() => setExpectedPlayersOpen(!expectedPlayersOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">
              关注玩家
            </span>
          </div>
          {expectedPlayersOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {expectedPlayersOpen && (
          <div className="space-y-2 px-4 pb-4">
            <p className="text-[10px] leading-relaxed text-cs2-text-secondary">
              每行一个游戏内昵称，<strong className="text-zinc-400">可写多行多名</strong>。
              <strong className="text-zinc-400">不会</strong>自动拆高光；要出片段请在库里选中后自行点解析。
            </p>
            <textarea
              rows={5}
              value={expectedParsePlayersText}
              onChange={(e) => onExpectedParsePlayersTextChange?.(e.target.value)}
              placeholder={"PlayerOne\nPlayerTwo"}
              className="w-full resize-y rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[11px] text-white placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
              spellCheck={false}
            />
            <button
              type="button"
              className="w-full rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-orange/50"
              onClick={() => void onSaveExpectedParsePlayers?.()}
            >
              保存名单
            </button>
          </div>
        )}
      </div>

      {/* LLM Config (AI mode only) */}
      {aiMode && (
        <div className="border-b border-cs2-border">
          <button
            onClick={() => setLlmOpen(!llmOpen)}
            className="flex items-center justify-between w-full px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              <Brain className="w-3.5 h-3.5 text-cs2-text-secondary" />
              <span className="text-xs font-semibold tracking-wide uppercase text-cs2-text-secondary">
                大模型配置
              </span>
            </div>
            {llmOpen ? (
              <ChevronUp className="w-3.5 h-3.5 text-cs2-text-secondary" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-cs2-text-secondary" />
            )}
          </button>
          {llmOpen && (
            <div className="px-4 pb-4 space-y-3">
              {/* 服务商选择 */}
              <div>
                <label className="block text-[10px] font-semibold text-cs2-text-secondary tracking-wider uppercase mb-1.5">服务商</label>
                <div className="relative">
                  <select
                    value={llmConfig.provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full appearance-none bg-cs2-bg-input border border-cs2-border rounded-md px-3 py-2 pr-8 text-xs text-white focus:outline-none focus:border-cs2-orange/50 transition-colors cursor-pointer"
                  >
                    <optgroup label="云端服务">
                      <option value="deepseek">DeepSeek</option>
                      <option value="qwen">通义千问 (Qwen)</option>
                      <option value="glm">智谱 (GLM)</option>
                      <option value="minimax">MiniMax</option>
                      <option value="openai">OpenAI</option>
                      <option value="openrouter">OpenRouter</option>
                    </optgroup>
                    <optgroup label="本地模型">
                      <option value="ollama">Ollama (本地)</option>
                      <option value="lmstudio">LM Studio (本地)</option>
                    </optgroup>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cs2-text-secondary" />
                </div>
              </div>

              {/* 本地模型提示 */}
              {isLocal && (
                <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-md bg-cs2-orange/10 border border-cs2-orange/20">
                  <Server className="w-3 h-3 text-cs2-orange shrink-0" />
                  <span className="text-[10px] text-cs2-orange">本地模型无需 API 密钥，请确保服务已启动</span>
                </div>
              )}

              {/* 模型名称 */}
              <Input
                label="模型名称"
                value={llmConfig.model}
                placeholder={currentPreset?.model || ""}
                onChange={(v) => onLlmConfigChange({ ...llmConfig, model: v })}
                onBlur={schedulePersistLlm}
              />

              {/* API 密钥 (云端模型才显示) */}
              {!isLocal && (
                <div>
                  <label className="block text-[10px] font-semibold text-cs2-text-secondary tracking-wider uppercase mb-1.5">
                    API 密钥
                  </label>
                  {llmKeySavedOnServer && !llmConfig.api_key?.trim() && (
                    <p className="mb-1.5 text-[10px] leading-relaxed text-emerald-500/90">
                      密钥已在服务器保存（刷新不显示明文）。若要更换，输入新密钥后失焦即可覆盖。
                    </p>
                  )}
                  <div className="relative">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={llmConfig.api_key}
                      placeholder={
                        llmKeySavedOnServer && !llmConfig.api_key?.trim()
                          ? "留空沿用已保存密钥"
                          : "sk-..."
                      }
                      onChange={(e) => onLlmConfigChange({ ...llmConfig, api_key: e.target.value })}
                      onBlur={schedulePersistLlm}
                      className="w-full bg-cs2-bg-input border border-cs2-border rounded-md px-3 py-2 pr-9 text-xs text-white placeholder-cs2-text-secondary/50 focus:outline-none focus:border-cs2-orange/50 transition-colors font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cs2-text-secondary hover:text-white transition-colors"
                    >
                      {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              )}

              {/* 接口地址 */}
              <Input
                label="接口地址"
                value={llmConfig.base_url || ""}
                
                onChange={(v) => onLlmConfigChange({ ...llmConfig, base_url: v })}
                onBlur={schedulePersistLlm}
              />
            </div>
          )}
        </div>
      )}

      <div className="mt-auto px-4 py-4 border-t border-cs2-border">
        <div className="text-[10px] text-cs2-text-secondary font-mono text-center">
          CS2 洞察智能体 &copy; 2026
        </div>
      </div>
    </aside>
  );
}

function Input({ label, value, type = "text", placeholder, onChange, onBlur }) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
        {label}
      </label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
      />
    </div>
  );
}
