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
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-white/5 hover:text-dynamic-zinc-300 disabled:opacity-50"
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
                    <span className="text-[13px] font-semibold text-dynamic-white">{label}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        required
                          ? "bg-cs2-orange/20 text-cs2-orange"
                          : "bg-zinc-700/60 text-dynamic-zinc-400"
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
            <span className="text-[12px] text-dynamic-zinc-300">{text}</span>
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
  { to: "/params", label: "录制参数配置", desc: "全局节奏与观战默认", icon: SlidersHorizontal },
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
              <p className="text-[12px] font-bold text-dynamic-white">{label}</p>
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
    q: "OBS / WebSocket 连不上？",
    a: "不管 Agent 自动探测的 OBS 路径正不正确，建议手动复制 OBS 路径粘贴到 Agent 中（示例：E:\\Steam\\steamapps\\common\\OBS Studio\\bin\\64bit\\obs64.exe）。连接配置中主机地址填 localhost，默认端口 4455，端口冲突才需要改。检查 OBS → 工具 → WebSocket 服务器设置是否已启用，并确认 Agent 与 OBS 的端口和密码保持一致；必要时可取消 OBS 身份验证，密码留空。",
  },
  {
    q: "录制后提示录制失败？",
    a: "检查后台是否有 5E、完美、WeGame、ACE 等游戏平台正在运行，录制时需要关闭。也可以尝试以管理员身份打开 Agent 和 OBS 再录制。",
  },
  {
    q: "进入 Demo 后是奇怪的第三人称视角，过一会儿自动退出，录制没录全？",
    a: "检查本机键位设置，确认「~」键是否绑定了打开控制台；若是，开始录制时请切换到英文键盘。同时将「录制参数配置」→「额外启动参数」中的 -fullscreen 去掉，并在游戏设置里改为全屏窗口模式。",
  },
  {
    q: "录制时 CS2 没有画面 / OBS 录到黑屏？",
    a: "重新在 Agent 内进行 OBS 校准，校准完毕后必须重启 OBS。确保 OBS 和 Agent 的运行权限一致（必要时均以管理员启动）。检查「CS2 Insight Recording」场景内游戏捕获源的属性是否正确。多显示器时确保 CS2 和 OBS 捕获的是同一个屏幕。",
  },
  {
    q: "录制没声音 / CS2 没声音？",
    a: "检查 OBS 音频捕获源：「桌面音频捕获」和「应用音频捕获」只保留其中一个，两个同时存在可能互相冲突。同时确认只有一条音轨。",
  },
  {
    q: "导出的视频打不开 / 视频文件异常 / 发群失败？",
    a: "可能是 Windows 权限或管理员启动 Agent 导致输出文件权限异常。尝试不以管理员身份启动 Agent；关掉 Agent / OBS 后再移动文件；或将视频拖到其他文件夹后再打开。",
  },
  {
    q: "成片有黑边 / 游戏画面被裁切？",
    a: "CS2 以 4:3 显示时可能出现黑边，在 OBS「游戏捕获」来源上右键 → 变换 → 拉伸到全屏。若画面被裁切，确保游戏以全屏模式（非全屏窗口模式）运行，且该分辨率在显示器上存在；也可在「额外启动参数」中去掉 -fullscreen，改用全屏窗口模式。",
  },
  {
    q: "最终效果没录全（只录了一个击杀后面黑屏）或把控制台录进去了？",
    a: "重新进行 OBS 校准，校准完毕后必须重启 OBS。OBS「设置 → 输出 → 录像质量」不能选「与串流画质相同」，需单独指定录像质量。若 OBS 输出模式为「高级」，请将录像的视频编码器改为非「使用直播编码器」选项，或先切换到「简单」模式再校准。",
  },
  {
    q: "录制时 CS2 停留在游戏主菜单？",
    a: "目前最新的 CS2 版本仅能播放 2026 年 4 月 21 日（ag2 动作系统更新）之后的 Demo。如需录制更早的比赛，需要将 CS2 版本回退到 1.41.4.1。",
  },
  {
    q: "录制出来的成片帧数不高 / 画面模糊？",
    a: "帧数和画质由 OBS 完全接管，请自行调整 OBS 的录制质量和编码设置。",
  },
  {
    q: "程序打不开 / 安装后没有快捷方式？",
    a: "确认安装包已正常运行到完成（而非中途关闭）。检查 Windows「开始菜单」中是否有 CS2 Insight Agent 的条目。如有问题，尝试重新运行安装包。",
  },
  {
    q: "启动时弹出 Windows SmartScreen 警告？",
    a: "这不是病毒，是因为程序尚未积累足够多的用户信任记录。点击「更多信息」→「仍要运行」即可正常启动。",
  },
  {
    q: "如何更新到新版本？",
    a: "程序内置自动更新：启动后若检测到新版本，界面会弹出更新提示，点击下载并安装即可，配置和数据不会丢失。也可前往 GitHub Releases 页面下载新安装包重新安装，同样不影响已有数据。",
  },
  {
    q: "OBS 测试连接失败？",
    a: "确认 OBS 已打开且 WebSocket 服务器已启用（工具 → WebSocket 服务器设置）。检查端口号（默认 4455）与密码是否匹配。OBS 版本须 ≥ 28.0（旧版需单独安装 obs-websocket 插件）。也可尝试关闭 OBS 认证、密码留空。",
  },
  {
    q: "CS2 路径没有自动检测到？",
    a: "手动在设置中填写完整路径。默认 Steam 路径通常为 C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe；若游戏库在其他盘，将盘符替换即可。注意：录制开始后请勿干预键鼠操作，否则可能覆盖玩家本机的游戏设置。",
  },
  {
    q: "实验性功能 POV HUD 是什么？",
    a: "POV HUD 能让 Demo 画面更接近实际个人游戏视角。在「常用参数管理」→「实验性功能」中勾选 POV 后，录制时会临时安装项目自带的 pov.vpk 并修改 gameinfo.gi 搜索路径，录制结束后程序自动恢复。若异常退出导致修改未恢复，可在同一页面点击「恢复 POV 修改」（需先关闭 CS2）。",
  },
  {
    q: "录制出来的视频是第三人称视角？",
    a: "程序会自动切换为第一人称视角。若出现问题，请在解析结果中确认选择的目标玩家名称与 Demo 中完全一致。",
  },
  {
    q: "解析很慢怎么办？",
    a: "第一次解析会稍慢，后续 Demo 库有缓存会快很多。建议不要同时解析多个超大 Demo。开启 AI 模式时，AI 点评需要网络请求，视 API 响应速度可能额外需要几秒。",
  },
  {
    q: "AI 模式报错？",
    a: "检查 API Key 是否正确（以 sk- 开头）及账户余额。使用 DeepSeek 时确认 Base URL 为 https://api.deepseek.com。不开启 AI 模式不影响其他所有功能。",
  },
  {
    q: "用 5E / 完美平台打的比赛，Demo 文件在哪？",
    a: "5E 客户端：比赛记录 → 选场次 → 下载 Demo。完美世界竞技平台：比赛记录 → 下载录像。官匹 Demo：CS2 主菜单 → 你的比赛 → 选场次 → 下载。下载的 .dem 文件可直接拖入 CS2 Insight 使用。",
  },
  {
    q: "可以同时录多场 Demo 的片段吗？",
    a: "可以。将来自不同 Demo 的片段都加入录制队列，程序会自动按 Demo 分组，依次启动 CS2 并录制各自的片段，全程无需人工干预。",
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
                <span className="text-[12px] font-semibold text-dynamic-zinc-200">{q}</span>
                {open ? (
                  <ChevronUp className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
              </button>
              {open && (
                <div className="border-t border-white/6 px-4 py-3">
                  <p className="text-[12px] leading-relaxed text-dynamic-zinc-400">{a}</p>
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
          <h1 className="text-xl font-bold text-dynamic-white">上手指南</h1>
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
