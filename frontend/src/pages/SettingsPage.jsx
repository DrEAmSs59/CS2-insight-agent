import { useState } from "react";
import { useAppShell } from "../context/AppShellContext";
import {
  Brain,
  Zap,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Server,
  FolderOpen,
  ScanSearch,
  Users,
} from "lucide-react";

const PROVIDER_PRESETS = {
  deepseek: { label: "DeepSeek", model: "deepseek-chat", base_url: "https://api.deepseek.com", local: false },
  openai: { label: "OpenAI", model: "gpt-4o", base_url: "https://api.openai.com", local: false },
  qwen: { label: "通义千问 (Qwen)", model: "qwen-plus", base_url: "https://dashscope.aliyuncs.com/compatible-mode", local: false },
  glm: { label: "智谱 (GLM)", model: "glm-4-flash", base_url: "https://open.bigmodel.cn/api/paas", local: false },
  minimax: { label: "MiniMax", model: "MiniMax-Text-01", base_url: "https://api.minimax.chat", local: false },
  openrouter: { label: "OpenRouter", model: "deepseek/deepseek-chat", base_url: "https://openrouter.ai/api", local: false },
  ollama: { label: "Ollama (本地)", model: "qwen2.5:7b", base_url: "http://localhost:11434", local: true },
  lmstudio: { label: "LM Studio (本地)", model: "loaded-model", base_url: "http://localhost:1234", local: true },
};

function SettingsForm({
  aiMode,
  onAiModeChange,
  llmConfig,
  onLlmConfigChange,
  llmKeySavedOnServer = false,
  onPersistLlm,
  cs2Path,
  onCs2PathChange,
  ffmpegPath = "",
  onFfmpegPathChange,
  cs2FpsMax = 240,
  onCs2FpsMaxChange,
  onSaveConfig,
  onDetectCs2,
  expectedParsePlayersText = "",
  onExpectedParsePlayersTextChange,
  onSaveExpectedParsePlayers,
}) {
  const [cs2Open, setCs2Open] = useState(true);
  const [llmOpen, setLlmOpen] = useState(true);
  const [expectedPlayersOpen, setExpectedPlayersOpen] = useState(true);
  const [detectingCs2, setDetectingCs2] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const handleDetectCs2 = async () => {
    if (!onDetectCs2) return;
    setDetectingCs2(true);
    try {
      await onDetectCs2();
    } finally {
      setDetectingCs2(false);
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
    <div className="h-full min-h-0 w-full overflow-y-auto px-4 py-4 pb-12 sm:px-5">
      <div className="mb-6 border-b border-white/10 pb-4">
        <h1 className="text-lg font-bold text-white">设置</h1>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          CS2 启动路径、关注玩家名单与大模型（AI 洞察模式）。Demo 监听目录请在「Demo 库」页配置。OBS WebSocket 请在侧边栏「OBS 配置中心」中配置。
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-cs2-bg-card/80">
        <div className="border-b border-white/10 px-4 py-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-cs2-text-secondary">分析模式</div>
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-cs2-bg-dark p-1">
            <button
              type="button"
              onClick={() => void onAiModeChange(false)}
              className={`flex items-center justify-center gap-1.5 rounded-md py-2.5 text-xs font-semibold transition-all ${
                !aiMode
                  ? "bg-cs2-orange text-black shadow-lg shadow-cs2-orange/20"
                  : "text-cs2-text-secondary hover:text-white"
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              极速本地
            </button>
            <button
              type="button"
              onClick={() => void onAiModeChange(true)}
              className={`flex items-center justify-center gap-1.5 rounded-md py-2.5 text-xs font-semibold transition-all ${
                aiMode
                  ? "bg-cs2-orange text-black shadow-lg shadow-cs2-orange/20"
                  : "text-cs2-text-secondary hover:text-white"
              }`}
            >
              <Brain className="h-3.5 w-3.5" />
              AI 洞察
            </button>
          </div>
        </div>

        <div className="border-b border-white/10">
          <button type="button" onClick={() => setCs2Open(!cs2Open)} className="flex w-full items-center justify-between px-4 py-3 text-left">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-3.5 w-3.5 text-cs2-text-secondary" />
              <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">CS2 路径</span>
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
              <Input
                label="FFmpeg 可执行文件（合辑导出，可选）"
                value={ffmpegPath ?? ""}
                placeholder="留空则使用 PATH 中的 ffmpeg"
                onChange={(v) => onFfmpegPathChange?.(v)}
                onBlur={() => onSaveConfig?.({ ffmpeg_path: ffmpegPath ?? "" })}
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

        <div className="border-b border-white/10">
          <button
            type="button"
            onClick={() => setExpectedPlayersOpen(!expectedPlayersOpen)}
            className="flex w-full items-center justify-between px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-cs2-text-secondary" />
              <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">关注玩家</span>
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

        {aiMode && (
          <div className="border-b border-white/10">
            <button type="button" onClick={() => setLlmOpen(!llmOpen)} className="flex w-full items-center justify-between px-4 py-3 text-left">
              <div className="flex items-center gap-2">
                <Brain className="h-3.5 w-3.5 text-cs2-text-secondary" />
                <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">大模型配置</span>
              </div>
              {llmOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
              )}
            </button>
            {llmOpen && (
              <div className="space-y-3 px-4 pb-4">
                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">服务商</label>
                  <div className="relative">
                    <select
                      value={llmConfig.provider}
                      onChange={(e) => handleProviderChange(e.target.value)}
                      className="w-full cursor-pointer appearance-none rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 pr-8 text-xs text-white transition-colors focus:border-cs2-orange/50 focus:outline-none"
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
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-secondary" />
                  </div>
                </div>

                {isLocal && (
                  <div className="flex items-center gap-1.5 rounded-md border border-cs2-orange/20 bg-cs2-orange/10 px-2.5 py-2">
                    <Server className="h-3 w-3 shrink-0 text-cs2-orange" />
                    <span className="text-[10px] text-cs2-orange">本地模型无需 API 密钥，请确保服务已启动</span>
                  </div>
                )}

                <Input
                  label="模型名称"
                  value={llmConfig.model}
                  placeholder={currentPreset?.model || ""}
                  onChange={(v) => onLlmConfigChange({ ...llmConfig, model: v })}
                  onBlur={schedulePersistLlm}
                />

                {!isLocal && (
                  <div>
                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">API 密钥</label>
                    {llmKeySavedOnServer && !llmConfig.api_key?.trim() && (
                      <p className="mb-1.5 text-[10px] leading-relaxed text-emerald-500/90">
                        密钥已在服务器保存（刷新不显示明文）。若要更换，输入新密钥后失焦即可覆盖。
                      </p>
                    )}
                    <div className="relative">
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={llmConfig.api_key}
                        placeholder={llmKeySavedOnServer && !llmConfig.api_key?.trim() ? "留空沿用已保存密钥" : "sk-..."}
                        onChange={(e) => onLlmConfigChange({ ...llmConfig, api_key: e.target.value })}
                        onBlur={schedulePersistLlm}
                        className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 pr-9 font-mono text-xs text-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cs2-text-secondary transition-colors hover:text-white"
                      >
                        {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}

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
      </div>

      <p className="mt-8 text-center font-mono text-[10px] text-cs2-text-secondary">CS2 洞察智能体 · v2.0.0</p>
    </div>
  );
}

export default function SettingsPage() {
  const s = useAppShell();
  return (
    <SettingsForm
      aiMode={s.aiMode}
      onAiModeChange={s.handleAiModeChange}
      llmConfig={s.llmConfig}
      onLlmConfigChange={s.setLlmConfig}
      llmKeySavedOnServer={s.llmKeySavedOnServer}
      onPersistLlm={s.persistLlmConfig}
      cs2Path={s.cs2Path}
      onCs2PathChange={s.setCs2Path}
      ffmpegPath={s.ffmpegPath}
      onFfmpegPathChange={s.setFfmpegPath}
      cs2FpsMax={s.cs2FpsMax}
      onCs2FpsMaxChange={s.setCs2FpsMax}
      onSaveConfig={s.handleSaveConfig}
      onDetectCs2={s.handleDetectCs2}
      expectedParsePlayersText={s.expectedParsePlayersText}
      onExpectedParsePlayersTextChange={s.setExpectedParsePlayersText}
      onSaveExpectedParsePlayers={s.handleSaveExpectedParsePlayers}
    />
  );
}

function Input({ label, value, type = "text", placeholder, onChange, onBlur }) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">{label}</label>
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
