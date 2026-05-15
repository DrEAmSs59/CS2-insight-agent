import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
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
} from "lucide-react";

// ─── Setup checklist ────────────────────────────────────────────

function StatusDot({ ok, loading }) {
  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />;
  if (ok) return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  return <XCircle className="h-4 w-4 text-red-400" />;
}

const SETUP_ITEMS = [
  {
    key: "obs_connected",
    required: true,
    label: "OBS WebSocket 已连通",
    desc: "录制功能必需。OBS 需开启 WebSocket 服务器，并在配置中心填写端口与密码。",
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
  const timerRef = useRef(null);

  const fetchStatus = async (isBackground = false) => {
    if (!isBackground) setLoading(true);
    try {
      const { data } = await axios.get("/api/status/setup");
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      if (!isBackground) setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus(false);
    timerRef.current = setInterval(() => fetchStatus(true), 8000);
    return () => clearInterval(timerRef.current);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchStatus(true);
    } finally {
      setRefreshing(false);
    }
  };

  const allRequired =
    status?.obs_connected && status?.cs2_path_ok;

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
  { step: "1", text: "双击启动.bat 打开程序" },
  { step: "2", text: "OBS 开启 WebSocket → OBS 配置中心填写连接信息" },
  { step: "3", text: "Demo 库 / 解析分析 页面上传或选择录像" },
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
    a: [
      "确保黑色命令行窗口没有关闭。",
      "尝试手动在浏览器输入 http://127.0.0.1:19871。",
      "检查是否有防火墙/杀毒软件拦截了端口 19871。",
      "若需换端口：编辑「启动.bat」，CS2_INSIGHT_PORT=19871，把19871改成新的端口。",
    ],
  },
  {
    q: "OBS 测试连接失败？",
    a: [
      "确认 OBS 已经打开并且 WebSocket 服务器已启用（工具 → WebSocket 服务器设置）。",
      "检查端口号（默认 4455）与密码是否与 OBS 中一致。",
      "确认 OBS 版本 ≥ 28.0（旧版需单独安装 obs-websocket 插件）。",
      "可尝试在 OBS 中关闭认证（取消勾选），密码留空。",
    ],
  },
  {
    q: "CS2 路径没有自动检测到？",
    a: [
      "在设置页的「CS2 路径」中手动填写完整路径。默认 Steam 安装常见路径：",
      "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe",
      "若游戏库在其他盘（例如 D 盘）：",
      "D:\\steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe",
      "为保证录制与还原本机设置，录制开始后请勿再操作鼠标键盘或控制台；中途干预可能导致本机游戏设置被错误覆盖。",
    ],
  },
  {
    q: "实验性功能 POV HUD 是什么？",
    a: [
      "POV HUD 即第一人称视角 HUD，可让玩家在录制时以第一人称视角观看游戏。",
      "在侧边栏打开「常用参数管理」，底部「实验性功能」中可勾选 POV。开启后，本地 Demo 回放录制时会临时安装项目自带的 pov.vpk，并增量修改 CS2 game/csgo/gameinfo.gi 的搜索路径；录制结束后程序会自动恢复。",
      "开启 POV 后，部分与 HUD/雷达相关的预热选项会被隐藏并由程序强制设定；不要用于连接官方匹配服务器。",
      "若异常退出导致修改未恢复，可在同一页面查看提示并点击「恢复 POV 修改」（需先关闭 CS2）。",
    ],
  },
  {
    q: "录制时 CS2 没有画面 / OBS 录到黑屏？",
    a: [
      "确保 OBS 的「游戏捕获」来源设置正确（捕获 cs2.exe 的窗口）。",
      "尝试在「游戏捕获」属性中把模式改为「捕获任何全屏应用程序」。",
      "确认 CS2 没有被最小化到后台。",
      "若使用多显示器，确保 CS2 与 OBS 捕获的是同一屏幕。",
    ],
  },
  {
    q: "成片有黑边？",
    a: [
      "CS2 为 4:3 显示时可能出现该情况。",
      "在 OBS 的「游戏捕获」来源上右键 → 变换 → 拉伸到全屏。",
    ],
  },
  {
    q: "发布了新版本如何更新？",
    a: [
      "先关闭老版本程序，再将新版本压缩包全部解压覆盖到老版本目录。",
      ".json 与 .db 文件为配置与 Demo 数据，请勿删除。",
    ],
  },
  {
    q: "最终效果把控制台录进去了？",
    a: "OBS 设置 → 输出 → 录像质量，不能选「与串流画质相同」，需单独指定录像质量。",
  },
  {
    q: "录制时 CS2 停留在游戏主菜单？",
    a: "目前最新的 CS2 仅能播放 2026 年 4 月 21 日之后（ag2 动作系统更新之后）的 Demo。若要录制更早的比赛镜头（例如 IEM 里约等更新前 Demo），需将 CS2 版本回退到 1.41.4.1。",
  },
  {
    q: "录制出来的视频是第三人称视角？",
    a: "程序会自动切换成第一人称观看目标玩家。若异常，请在解析结果中确认所选目标玩家名称与 Demo 内名称完全一致。",
  },
  {
    q: "解析很慢怎么办？",
    a: [
      "第一次解析会稍慢，后续会快很多。",
      "建议不要同时解析多个超大 Demo。",
      "若开启 AI 模式，AI 点评依赖网络请求，视 API 响应可能额外需要数秒。",
    ],
  },
  {
    q: "AI 模式报错？",
    a: [
      "检查 API Key 是否正确（以 sk- 开头）。",
      "检查 API 账户是否仍有余额。",
      "使用 DeepSeek 时确认 Base URL 为 https://api.deepseek.com。",
      "不开启 AI 模式不影响其他所有功能。",
    ],
  },
  {
    q: "我是用 5E / 完美平台打的比赛，Demo 文件在哪？",
    a: [
      "5E：5E 客户端 → 比赛记录 → 选择某场比赛 → 下载 Demo。",
      "完美世界：完美世界竞技平台 → 比赛记录 → 下载录像。",
      "下载的 .dem 文件可直接拖入 CS2 Insight 使用。",
    ],
  },
  {
    q: "可以同时录多场 Demo 的片段吗？",
    a: "可以。支持批量录制：待录制队列中包含多个 Demo 的片段时，程序会依次加载每个 Demo 并录制其中已选片段。",
  },
  {
    q: "合辑导出提示找不到 FFmpeg？",
    a: "在设置页的「FFmpeg 可执行文件」填写 ffmpeg.exe 完整路径，或将 ffmpeg 所在目录加入系统 PATH 后重启程序。",
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
                  {Array.isArray(a) ? (
                    <ul className="list-inside list-disc space-y-1.5 text-[12px] leading-relaxed text-zinc-400 marker:text-zinc-600">
                      {a.map((line, j) => (
                        <li key={j}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12px] leading-relaxed text-zinc-400">{a}</p>
                  )}
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
