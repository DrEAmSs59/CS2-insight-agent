import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/api";
import { getObsConfigStatus } from "../api/obsConfigCenter";
import { obsConfigHasIssues } from "../utils/obsConfigHealth";
import {
  BookOpen,
  Clapperboard,
  Library,
  Microscope,
  Package,
  SlidersHorizontal,
  Settings,
  Gamepad2,
  RadioTower,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";

// ─── Setup checklist ────────────────────────────────────────────

function StatusDot({ ok, loading }) {
  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />;
  if (ok) return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  return <XCircle className="h-4 w-4 text-red-400" />;
}

const SETUP_ITEMS = [
  {
    key: "obs_configured",
    required: true,
    label: "OBS 配置已验证",
    desc: "录制功能必需。需在 OBS 配置中心点击「配置检查」，成功连接后标记为已验证。录制前会自动检测 OBS 是否运行。",
    to: "/obs-config-center",
    linkLabel: "OBS 配置中心",
  },
  {
    key: "cs2_path_ok",
    required: true,
    label: "CS2 路径已配置",
    desc: "录制功能必需。需要指向 cs2.exe 可执行文件，程序会自动探测 Steam 安装，也可手动填写。",
    to: "/settings",
    linkLabel: "设置页",
  },
  {
    key: "ffmpeg_ok",
    required: false,
    label: "FFmpeg 可用",
    desc: "合辑导出必需。可在设置中指定 ffmpeg.exe 路径，或将 ffmpeg 加入系统 PATH 变量。",
    to: "/settings",
    linkLabel: "设置页",
  },
  {
    key: "ai_key_ok",
    required: false,
    label: "AI 锐评 API Key 已配置",
    desc: "可选。配置后可为每个片段生成 AI 评分与锐评文案。推荐 DeepSeek，费用极低。",
    to: "/settings",
    linkLabel: "设置页",
  },
];

function SetupChecklist() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [obsConfigHasIssues, setObsConfigHasIssues] = useState(/** @type {boolean | null} */ (null));
  const timerRef = useRef(null);

  const fetchStatus = async (isBackground = false) => {
    if (!isBackground) setLoading(true);
    try {
      const { data } = await API.get("/config/quick-check");
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      if (!isBackground) setLoading(false);
    }
  };

  // OBS 已配置时拉一次配置健康状态（随 setup 刷新同步）
  const fetchObsConfigHealth = async () => {
    try {
      const st = await getObsConfigStatus();
      if (!st?.obs_connected) { setObsConfigHasIssues(null); return; }
      setObsConfigHasIssues(obsConfigHasIssues(st));
    } catch {
      setObsConfigHasIssues(null);
    }
  };

  useEffect(() => {
    fetchStatus(false);
    // quick-check 不连 OBS 很快，保留轮询以反映配置变化
    timerRef.current = setInterval(() => fetchStatus(true), 15000);
    return () => clearInterval(timerRef.current);
  }, []);

  // OBS 配置状态变化时同步拉配置健康
  useEffect(() => {
    if (status?.obs_configured) {
      void fetchObsConfigHealth();
    } else {
      setObsConfigHasIssues(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.obs_configured]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchStatus(true);
      if (status?.obs_configured) await fetchObsConfigHealth();
    } finally {
      setRefreshing(false);
    }
  };

  const allRequired =
    status?.obs_configured && status?.cs2_path_ok;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-bold uppercase tracking-widest text-zinc-500">
          配置核查清单
        </h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-white/5 hover:text-zinc-300 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
          刷新
        </button>
      </div>

      {allRequired && !loading && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          必需配置已全部就绪，可以开始录制了！
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {SETUP_ITEMS.map(({ key, required, label, desc, to, linkLabel }) => {
          const ok = status?.[key] ?? false;
          const isObs = key === "obs_configured";
          return (
            <div
              key={key}
              className={`rounded-xl border px-4 py-3 transition-colors ${
                ok
                  ? "border-emerald-500/20 bg-emerald-500/5"
                  : required
                  ? "border-red-500/20 bg-red-500/5"
                  : "border-white/8 bg-cs2-bg-card/70"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  <StatusDot ok={ok} loading={loading} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-white">{label}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        required
                          ? "bg-cs2-orange/20 text-cs2-orange"
                          : "bg-zinc-700/60 text-zinc-400"
                      }`}
                    >
                      {required ? "必需" : "可选"}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{desc}</p>
                  {!ok && (
                    <Link
                      to={to}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-cs2-orange hover:underline"
                    >
                      前往 {linkLabel} 配置
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  )}
                  {/* OBS 连通后的录制配置子项 */}
                  {isObs && ok && obsConfigHasIssues !== null && (
                    <div className={`mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] ${
                      obsConfigHasIssues
                        ? "border-amber-500/25 bg-amber-500/8 text-amber-300"
                        : "border-emerald-500/20 bg-emerald-500/8 text-emerald-300"
                    }`}>
                      {obsConfigHasIssues
                        ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      }
                      <div>
                        <span className="font-semibold">
                          {obsConfigHasIssues ? "录制配置存在问题" : "录制配置正常"}
                        </span>
                        <span className="ml-1 text-zinc-500">
                          {obsConfigHasIssues
                            ? "— 画布/场景/格式需修复"
                            : "— 画布、场景源、格式均就绪"
                          }
                        </span>
                        {obsConfigHasIssues && (
                          <Link
                            to="/obs-config-center"
                            className="ml-2 font-semibold text-cs2-orange hover:underline"
                          >
                            前往修复 →
                          </Link>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Quick‑start steps ──────────────────────────────────────────

const STEPS = [
  { step: "1", text: "完成 OBS、Demo库 配置" },
  { step: "2", text: "进入 Demo 库扫描 Demo 或手动加入 Demo" },
  { step: "3", text: "选择 Demo 解析分析" },
  { step: "4", text: "选玩家 → 解析 → 勾选片段 → 一键录制" },
];

function QuickStart() {
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-bold uppercase tracking-widest text-zinc-500">
        快速上手
      </h2>
      <div className="flex flex-wrap gap-2">
        {STEPS.map(({ step, text }, i) => (
          <div key={step} className="flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cs2-orange/20 font-mono text-[11px] font-bold text-cs2-orange">
              {step}
            </div>
            <span className="text-[12px] text-zinc-300">{text}</span>
            {i < STEPS.length - 1 && (
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Feature nav cards ──────────────────────────────────────────

const NAV_CARDS = [
  { to: "/library", label: "Demo 库", desc: "搜索、筛选、载入解析", icon: Library },
  { to: "/analysis", label: "解析分析", desc: "上传 .dem 提取高光片段", icon: Microscope },
  { to: "/queue", label: "录制队列", desc: "批量 OBS 全自动录制", icon: Package },
  { to: "/montage", label: "合辑工作台", desc: "已录片段时间线拼接导出", icon: Clapperboard },
  { to: "/obs-config-center", label: "OBS 配置中心", desc: "WebSocket 连接与场景配置", icon: RadioTower },
  { to: "/params", label: "常用参数", desc: "全局节奏与观战默认", icon: SlidersHorizontal },
  { to: "/player-game-config", label: "玩家游戏配置", desc: "CFG 备份与异常恢复", icon: Gamepad2 },
  { to: "/settings", label: "设置", desc: "OBS · CS2 路径 · FFmpeg · AI", icon: Settings },
];

function FeatureCards() {
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-bold uppercase tracking-widest text-zinc-500">
        功能入口
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {NAV_CARDS.map(({ to, label, desc, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-center gap-3 rounded-xl border border-white/8 bg-cs2-bg-card/80 px-3 py-3 transition-colors hover:border-cs2-orange/30 hover:bg-cs2-bg-card"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cs2-orange/12 text-cs2-orange transition-colors group-hover:bg-cs2-orange/22">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[12px] font-bold text-white">{label}</p>
              <p className="truncate text-[11px] text-zinc-500">{desc}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─── FAQ accordion ──────────────────────────────────────────────

const FAQ_ITEMS = [
  {
    q: "页面打不开 / 显示无法连接？",
    a: "确保黑色命令行窗口没有关闭。尝试手动在浏览器输入 http://127.0.0.1:8000。如端口冲突，编辑 启动.bat，将 8000 改为 8010（两处都要改），同时修改 backend/app/run_server.py 中的默认端口。",
  },
  {
    q: "OBS 测试连接失败？",
    a: "确认 OBS 已打开且 WebSocket 服务器已启用（工具 → WebSocket 服务器设置）。检查端口（默认 4455）和密码是否匹配。OBS 版本须 ≥ 28.0，旧版需单独安装 obs-websocket 插件。也可在 OBS 中取消「启用认证」，密码留空。",
  },
  {
    q: "CS2 路径没有自动检测到？",
    a: "手动在设置页填写完整路径，默认 Steam 路径通常为：C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe。注意：录制过程中请勿干预键盘鼠标，否则可能覆盖玩家本机游戏设置。",
  },
  {
    q: "合辑导出提示找不到 FFmpeg？",
    a: "在设置页的「FFmpeg 可执行文件」一栏填写 ffmpeg.exe 的完整路径，或将 ffmpeg 所在目录加入系统 PATH 环境变量后重启程序即可。",
  },
  {
    q: "录制时 CS2 没有画面 / OBS 录到黑屏？",
    a: "确保 OBS 的「游戏捕获」来源设置正确，捕获 cs2.exe 窗口。也可尝试改为「捕获任何全屏应用程序」。确认 CS2 没有被最小化。多显示器时确保 CS2 和 OBS 捕获同一屏幕。",
  },
  {
    q: "成片有黑边？",
    a: "CS2 以 4:3 显示时可能出现黑边。在 OBS 的「游戏捕获」来源上右键 → 变换 → 拉伸到全屏。",
  },
  {
    q: "最终效果把控制台录进去了？",
    a: "OBS 输出设置中的「录像质量」不能选「与串流画质相同」，需要单独指定一个录像质量。",
  },
  {
    q: "录制时 CS2 停留在游戏主菜单？",
    a: "CS2 目前仅能播放 2024 年 4 月 21 日（ag2 动作系统更新）之后的 Demo。更旧的录像需要将 CS2 版本回退到 1.41.4.1。",
  },
  {
    q: "录制出来的视频是第三人称视角？",
    a: "程序会自动切换为第一人称视角。若出现问题，请确认解析时选择的目标玩家名称与 Demo 中完全一致。",
  },
  {
    q: "实验性功能 POV HUD 是什么？",
    a: "在「常用参数」页底部「实验性功能」勾选 POV 后，录制时会临时安装项目自带的 pov.vpk 并修改 gameinfo.gi 搜索路径，录制结束后程序自动恢复。若异常退出未恢复，可在同一页面点击「恢复 POV 修改」（需先关闭 CS2）。",
  },
  {
    q: "AI 模式报错？",
    a: "检查 API Key 是否正确（以 sk- 开头）及账户余额。使用 DeepSeek 时确认 Base URL 为 https://api.deepseek.com。不开 AI 模式不影响其他所有功能。",
  },
  {
    q: "Demo 文件在哪里下载？",
    a: "官匹：CS2 主菜单 → 你的比赛 → 选场次 → 下载。5E 客户端：比赛记录 → 选场次 → 下载 Demo。完美世界：竞技平台 → 比赛记录 → 下载录像。下载的 .dem 文件可直接拖入解析分析页。",
  },
  {
    q: "可以同时录多场 Demo 的片段吗？",
    a: "可以。录制队列支持跨 Demo 批量录制，程序会自动依次加载每个 Demo 并录制其中选中的片段。",
  },
  {
    q: "发布了新版本如何更新？",
    a: "先关闭老版本程序，将新版本压缩包全部解压覆盖到老版本目录中。.json 和 .db 文件是你的配置与 Demo 数据，不要删除。",
  },
  {
    q: "解析很慢怎么办？",
    a: "第一次解析会稍慢，后续会快很多。建议不要同时解析多个超大 Demo。开启 AI 模式时，AI 点评需要网络请求，视 API 响应速度可能额外需要几秒。",
  },
];

function FaqAccordion() {
  const [openIdx, setOpenIdx] = useState(null);

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-bold uppercase tracking-widest text-zinc-500">
        常见问题 FAQ
      </h2>
      <div className="divide-y divide-white/8 rounded-xl border border-white/8 bg-cs2-bg-card/60">
        {FAQ_ITEMS.map(({ q, a }, i) => {
          const open = openIdx === i;
          return (
            <div key={i}>
              <button
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/[0.03]"
                onClick={() => setOpenIdx(open ? null : i)}
              >
                <span className="text-[12px] font-semibold text-zinc-200">{q}</span>
                {open ? (
                  <ChevronUp className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
              </button>
              {open && (
                <div className="border-t border-white/6 px-4 py-3">
                  <p className="text-[12px] leading-relaxed text-zinc-400">{a}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Page root ──────────────────────────────────────────────────

export default function GuidePage() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto px-4 py-4 sm:px-5">
      {/* header */}
      <div className="mb-5 shrink-0 border-b border-white/10 pb-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-cs2-orange" />
          <h1 className="text-xl font-bold text-white">上手指南</h1>
        </div>
        <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-zinc-500">
          第一次使用？按照下方清单完成配置，然后拖入 Demo 开始解析录制。
        </p>
      </div>

      <div className="flex flex-col gap-7">
        <QuickStart />
        <SetupChecklist />
        <FeatureCards />
        <FaqAccordion />
      </div>

      {/* footer padding */}
      <div className="h-6 shrink-0" />
    </div>
  );
}
