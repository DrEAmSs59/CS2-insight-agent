import { useState } from "react";
import { Loader2, CircleCheck } from "lucide-react";
import { testSteamConnection, saveMatchCredentials } from "../../api/matchHistoryApi";

const MODES = [
  { value: "premier", label: "优先排位" },
  { value: "competitive", label: "竞技" },
];
const COUNTS = [20, 50, 100];

export default function CredentialPanel({
  configured,
  maskedKey,
  steamId64,
  syncedAt,
  matchMode,
  matchCount,
  onSaved,
  onSync,
}) {
  const [apiKey, setApiKey] = useState("");
  const [id64, setId64] = useState(steamId64 || "");
  const [mode, setMode] = useState(matchMode || "premier");
  const [count, setCount] = useState(matchCount || 20);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testErr, setTestErr] = useState("");

  async function handleTest() {
    setTesting(true);
    setTestErr("");
    setTestResult(null);
    try {
      const res = await testSteamConnection(apiKey, id64);
      setTestResult(res);
    } catch (e) {
      setTestErr(e?.response?.data?.detail || "连接失败");
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveMatchCredentials(apiKey || undefined, id64, mode, count);
      onSaved?.();
    } catch (e) {
      setTestErr(e?.response?.data?.detail || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (configured) {
    return (
      <div
        className="flex items-center gap-3 rounded-[10px] border px-5 py-3"
        style={{ background: "rgba(46,184,106,0.10)", borderColor: "rgba(46,184,106,0.28)" }}
      >
        <div
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: "#2eb86a", boxShadow: "0 0 8px #2eb86a80" }}
        />
        <div className="flex-1 text-[13px]">
          <span className="font-semibold text-[#2eb86a]">凭据已生效</span>
          {maskedKey && (
            <span className="ml-2 font-mono text-[12px] text-cs2-text-secondary">
              Key: {maskedKey}
            </span>
          )}
          {steamId64 && (
            <span className="ml-2 font-mono text-[12px] text-cs2-text-secondary">
              · {steamId64}
            </span>
          )}
          {syncedAt && (
            <span className="ml-2 text-[11px] text-cs2-text-muted">· 上次同步 {syncedAt}</span>
          )}
        </div>
        <button
          onClick={onSync}
          className="rounded-[7px] border border-cs2-border px-3 py-1 text-[12px] text-cs2-text-secondary hover:text-cs2-text-primary"
        >
          同步
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-cs2-border bg-[#16161a] px-6 py-5">
      <div className="grid grid-cols-2 gap-x-5 gap-y-4">
        {/* API Key */}
        <div>
          <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
            Steam Web API Key
            <a
              href="https://steamcommunity.com/dev/apikey"
              target="_blank"
              rel="noreferrer"
              className="ml-2 text-cs2-accent underline"
            >
              获取
            </a>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="32 位字符串，例如 1A2B3C4D5E6F…"
            className="w-full rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[12.5px] text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent focus:outline-none"
          />
          <p className="mt-1 text-[11.5px] text-cs2-text-muted">
            注册时「域名名称」填 <span className="font-mono text-cs2-text-secondary">localhost</span> 即可，
            API Key 仅存储于本地配置文件，请勿泄露给他人
          </p>
        </div>

        {/* SteamID64 */}
        <div>
          <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
            Steam64ID
            <a
              href="https://www.steamidfinder.com/"
              target="_blank"
              rel="noreferrer"
              className="ml-2 text-cs2-accent underline"
            >
              查询
            </a>
          </label>
          <input
            type="text"
            value={id64}
            onChange={(e) => setId64(e.target.value)}
            placeholder="17 位数字，以 7656119 开头"
            className="w-full rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[12.5px] text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent focus:outline-none"
          />
          <p className="mt-1 text-[11.5px] text-cs2-text-muted">
            Steam 客户端右上角头像 → 账户明细，页面中即可看到；
            或点「查询」用昵称 / 个人资料链接搜索
          </p>
        </div>

        {/* Mode */}
        <div>
          <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
            对局模式
          </label>
          <div className="flex gap-1">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                className={`flex-1 rounded-[7px] border px-3 py-2 text-[12.5px] font-semibold transition-colors ${
                  mode === m.value
                    ? "border-cs2-accent/60 bg-cs2-accent/10 text-cs2-accent"
                    : "border-cs2-border text-cs2-text-secondary hover:text-cs2-text-primary"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Count */}
        <div>
          <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
            每次拉取数量
          </label>
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-full rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[12.5px] text-cs2-text-primary focus:border-cs2-accent focus:outline-none"
          >
            {COUNTS.map((c) => (
              <option key={c} value={c}>最近 {c} 场</option>
            ))}
          </select>
        </div>
      </div>

      {/* Risk notice */}
      <div
        className="mt-4 rounded-[8px] border px-4 py-3 text-[12px] leading-relaxed text-cs2-text-secondary"
        style={{ background: "rgba(255,140,0,0.07)", borderColor: "rgba(255,140,0,0.25)" }}
      >
        <span className="font-semibold text-cs2-accent">⚠ 安全提示：</span>
        Steam Web API Key 相当于账号的访问凭证，泄露后他人可查询你的对局记录。
        本工具仅在本机与 Steam 官方服务器之间通信，Key 不会上传至任何第三方。
        若 Key 意外泄露，请前往{" "}
        <a
          href="https://steamcommunity.com/dev/apikey"
          target="_blank"
          rel="noreferrer"
          className="text-cs2-accent underline"
        >
          Steam 开发者页面
        </a>{" "}
        重新生成。
      </div>

      {testResult && (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-[#2eb86a]">
          <CircleCheck className="h-4 w-4" />
          连接成功 · {testResult.name}
        </div>
      )}
      {testErr && <p className="mt-2 text-[12.5px] text-cs2-fail">{testErr}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border px-4 py-2 text-[13px] font-semibold text-cs2-text-secondary hover:text-cs2-text-primary disabled:opacity-50"
        >
          {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          测试连接
        </button>
        <button
          onClick={handleSave}
          disabled={saving || (!apiKey && !id64)}
          className="flex items-center gap-1.5 rounded-[7px] bg-cs2-accent px-4 py-2 text-[13px] font-semibold text-black hover:bg-cs2-accent-light disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          保存并拉取战绩
        </button>
      </div>
    </div>
  );
}
