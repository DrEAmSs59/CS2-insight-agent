// 所有 tag → 中文/英文说明。命中优先级：精确匹配 → 前缀匹配。
// 保持文本尽量短，hover tooltip 用。
// IMPORTANT: tag keys (Chinese strings) are used as IDs by the backend/DB — do NOT change them.

const EXACT = {
  // ── 动作子标 ──
  "🙈 盲狙": {
    zh: "AWP/SSG08 开镜前开枪命中（noscope 为真）",
    en: "AWP/SSG08 kill before scoping (noscope)",
  },
  "🧱 穿墙杀": {
    zh: "子弹穿透一个及以上实体后击杀",
    en: "Kill through one or more solid entities (wallbang)",
  },
  "🌫️ 混烟": {
    zh: "子弹穿过烟雾命中",
    en: "Shot fired through smoke connected",
  },
  "😎 全白反杀": {
    zh: "被完全致盲状态下完成击杀",
    en: "Kill while completely blinded by a flashbang",
  },
  "🤝 好闪配好人": {
    zh: "队友闪光致盲敌人后完成击杀",
    en: "Kill after a teammate's flash blinded the enemy",
  },
  "🔙 偷背身": {
    zh: "枪杀受害者背对自己时完成击杀",
    en: "Kill while the enemy had their back turned",
  },
  "爆头": {
    zh: "命中头部",
    en: "Hit the head",
  },
  "🔫 手枪哥": {
    zh: "手枪系武器（Glock / USP / P250 等）爆头击杀",
    en: "Headshot kill with a pistol (Glock / USP / P250 etc.)",
  },
  "👃 零距离": {
    zh: "与受害者距离 ≤ 60 units 且爆头",
    en: "Headshot at point-blank range (≤ 60 units)",
  },
  "🫵 贴脸超度": {
    zh: "与受害者距离 ≤ 120 units",
    en: "Kill at very close range (≤ 120 units)",
  },
  "🎯 超远穿墙": {
    zh: "穿墙击杀且距离 > 400 units（子弹穿过 + 远射）",
    en: "Long-range wallbang kill (distance > 400 units)",
  },
  "🚀 上去就是干": {
    zh: "击杀瞬间水平速度 > 220（冲刺中）",
    en: "Kill while sprinting at full speed (horizontal speed > 220)",
  },
  "🏃‍♂️ 跑打": {
    zh: "击杀瞬间仍在移动（速度 120–220，排除急停后出枪）",
    en: "Kill while moving at moderate speed (120–220, not counter-strafing)",
  },
  "🎿 一个大拉": {
    zh: "侧向高速移动击杀（速度 > 150 且移动方向与视角夹角 ≥ 45°）",
    en: "Kill while strafing sideways at high speed (speed > 150, angle ≥ 45°)",
  },
  "🛸 乌鸦坐飞机": {
    zh: "攻击者腾空时完成击杀",
    en: "Kill while airborne",
  },
  "🌪️ 甩狙": {
    zh: "大狙击杀前 0.25s 内准星偏转 ≥ 40°（快速甩枪击杀）",
    en: "AWP kill with crosshair swung ≥ 40° in the 0.25s before the shot",
  },
  "✈️ 飞天盲狙": {
    zh: "跳跃途中 noscope 击杀（Z 轴位移 + 无镜击杀）",
    en: "Noscope kill while airborne (jumping noscope)",
  },
  "冷神附体": {
    zh: "飞天盲狙的气质补充",
    en: "Accompanies a jumping noscope kill",
  },
  "💥 颗秒": {
    zh: "步枪 / 重手枪爆头且击杀前 2s 同武器 ≤3 枪",
    en: "Rifle or heavy pistol headshot with ≤ 3 shots fired in the 2s before the kill",
  },
  "🔪 手撕大狙": {
    zh: "用任意武器击杀正举 AWP 瞄准你的敌人",
    en: "Kill an enemy who was aiming an AWP at you",
  },
  "🔪 刀杀": {
    zh: "本回合至少一次刀类武器击杀",
    en: "At least one knife kill this round",
  },

  // ── 回合级高光：数量/节奏 ──
  "双杀": {
    zh: "本回合 2 杀",
    en: "2 kills this round",
  },
  "三杀": {
    zh: "本回合 3 杀",
    en: "3 kills this round",
  },
  "四杀": {
    zh: "本回合 4 杀",
    en: "4 kills this round",
  },
  "五杀 (ACE)": {
    zh: "本回合 5 杀（ACE）",
    en: "5 kills this round (ACE)",
  },
  "爆发刷屏": {
    zh: "双杀 ≤3s / 三杀及以上 ≤10s",
    en: "Rapid multi-kill: double kill ≤ 3s or triple kill+ ≤ 10s",
  },
  "枪枪爆头": {
    zh: "本回合所有击杀均为爆头",
    en: "Every kill this round was a headshot",
  },
  "⚔️ 首杀": {
    zh: "本回合第一个击杀是你拿下的",
    en: "You got the first kill of the round",
  },

  // ── 经济 / 装备 ──
  "🔫 手枪局专家": {
    zh: "第 1 或第 13 回合（手枪局）完成多杀",
    en: "Multi-kill in a pistol round (round 1 or 13)",
  },
  "💸 ECO翻盘": {
    zh: "本方装备 ≤ 8000 且对方 ≥ 15000，仍多杀",
    en: "Multi-kill while your team's equipment value ≤ 8000 vs enemy ≥ 15000",
  },
  "🔫 ECO特种兵": {
    zh: "对方 ECO 局完成的多杀",
    en: "Multi-kill against an enemy ECO round",
  },
  "👢 光脚干皮鞋": {
    zh: "本方装备 ≤ 3000 且对方 ≥ 12000 时空出装杀敌",
    en: "Kill while your team has equipment ≤ 3000 vs enemy ≥ 12000 (bare-buy vs full-buy)",
  },

  // ── 比分 / 残局 ──
  "⛰️ 天王山之战": {
    zh: "双方均 ≥10 分且比分相同",
    en: "Both teams ≥ 10 points with equal score (pivotal round)",
  },
  "🛡️ 赛点救世主": {
    zh: "对方赛点回合赢下该回合",
    en: "Won the round when the enemy was at match point",
  },
  "命悬一线": {
    zh: "赛点回合守住",
    en: "Held the round at match point",
  },
  "📈 绝地追分": {
    zh: "落后较多时拿下关键一回合",
    en: "Won a key round while significantly behind on score",
  },
  "拒绝下班": {
    zh: "即将被 0：X 局点时阻止对方收官",
    en: "Prevented the enemy from closing out the match when facing elimination",
  },
  "🗡️ 赛点终结者": {
    zh: "己方赛点回合直接结束比赛",
    en: "Won the match in your team's match-point round",
  },
  "一锤定音": {
    zh: "赛点终结的补充语义",
    en: "Accompanies a match-point closing round win",
  },
  "⚔️ 加时生死战": {
    zh: "OT 加时阶段完成多杀",
    en: "Multi-kill during overtime",
  },
  "大心脏": {
    zh: "OT 加时中的稳定发挥",
    en: "Steady performance during overtime",
  },
  "🔥 顺风局战神": {
    zh: "领先对方较多分差时仍输出炸裂",
    en: "Strong output while your team has a large lead",
  },
  "无情碾压": {
    zh: "顺风局的同义补充",
    en: "Accompanies a dominant performance while ahead",
  },
  "🔥 3v5 绝地反击": {
    zh: "回合开局 3 对 5 人数劣势下赢下",
    en: "Won the round starting 3 vs 5 (outnumbered)",
  },
  "❤️ 极限锁血战神": {
    zh: "多杀起始时 HP 很低却完成翻盘",
    en: "Multi-kill started with very low HP",
  },

  // ── 新增 CS 黑话 ──
  "🔙 背刺": {
    zh: "刀杀时攻击者与受害者朝向夹角 < 45°（从背后捅）",
    en: "Knife kill from behind (attacker facing same direction as victim, angle < 45°)",
  },
  "🔔 极限操作": {
    zh: "某次击杀距回合结束 ≤5s，或在 C4 爆炸后完成击杀",
    en: "Kill within 5s of round end, or after C4 detonation",
  },
  "🧾 上回合的债": {
    zh: "本回合击杀的敌人，上一回合杀过你（复仇）",
    en: "Killed an enemy who killed you last round (revenge)",
  },
  "⚰️ 补枪": {
    zh: "击杀对象在过去 ≤2.5s 被队友打过（收人头）",
    en: "Kill steal: target was hit by a teammate in the past 2.5s",
  },
  "🧹 清盘": {
    zh: "本回合 5 杀且队友 0 杀（一个人打完全部）",
    en: "5 kills this round with 0 kills from teammates (solo round)",
  },
  "🔫 一弹双穿": {
    zh: "同一 tick 两杀且至少一杀为穿墙",
    en: "Two kills in the same tick, at least one through a wall",
  },
  "❤️‍🩹 残血绝地反击": {
    zh: "多杀起始时 HP ≤ 20",
    en: "Multi-kill started with HP ≤ 20",
  },
  "🪨 挨揍王": {
    zh: "本回合非道具命中 ≥4 次、累计伤害 ≥95，仍完成击杀",
    en: "Completed a kill after taking ≥ 4 hits and ≥ 95 total damage this round",
  },
  "💣 拆包开光": {
    zh: "开始拆包到拆包完成之间完成击杀",
    en: "Kill made while actively defusing the bomb",
  },
  "🍡 一石二鸟": {
    zh: "同一 tick 两杀（不限穿墙）",
    en: "Two kills in the same tick",
  },

  // ── 空间深度 ──
  "🔭 百步穿杨": {
    zh: "距离 > 1500 units 的远距离 AWP / R8 / 沙鹰击杀",
    en: "Long-range AWP / R8 / Deagle kill at distance > 1500 units",
  },
  "🪂 跳杀": {
    zh: "击杀瞬间处于空中（vel_z 特征命中）",
    en: "Kill while in the air (airborne at moment of kill)",
  },
  "🔀 连穿": {
    zh: "子弹穿透 ≥2 个实体后击杀（连续穿墙/穿人）",
    en: "Kill after bullet penetrated ≥ 2 entities consecutively",
  },
  "🪂 空中遇难": {
    zh: "受害者腾空时被击杀（非刀/道具/自爆）",
    en: "Enemy killed while airborne (not knife/grenade/self-inflicted)",
  },
  "🥷 智斗": {
    zh: "敌人早已在你射程内，你耐心等待后再开枪",
    en: "Enemy was in your sightline for a while before you took the shot",
  },

  // ── 虽败犹荣（输掉回合时的镜像）──
  "😤 1v2 饮恨": {
    zh: "独面 2 人干掉 1 人，仍输了回合",
    en: "Killed 1 of 2 enemies in a 1v2, but lost the round",
  },
  "💸 ECO反击": {
    zh: "ECO 局多杀但输掉回合",
    en: "Multi-kill on an ECO round but still lost",
  },
  "🛡️ 赛点失守": {
    zh: "对方赛点回合本方没守住",
    en: "Failed to hold the round when the enemy was at match point",
  },
  "📉 绝地追分未果": {
    zh: "落后情况下奋力输出仍无力回天",
    en: "Fought hard while behind but could not turn the round around",
  },
  "⛰️ 天王山饮恨": {
    zh: "双方均势关键局失利",
    en: "Lost the pivotal equal-score round",
  },

  // ── 拆包 ──
  "⏱️ 极限拆包": {
    zh: "C4 引爆时间过去 ≥ 39s 才拆掉",
    en: "Bomb defused with ≥ 39s of the fuse elapsed",
  },
  "⏱️ 零秒拆包": {
    zh: "拆包完成时 C4 剩余 ≤ 1s",
    en: "Bomb defused with ≤ 1s remaining on the timer",
  },
  "🥷 忍者偷包": {
    zh: "拆包瞬间最近存活敌人 ≥ 1000 units",
    en: "Bomb defused while nearest living enemy was ≥ 1000 units away (stealth defuse)",
  },

  // ── 同框 ──
  "🧍 肩并肩": {
    zh: "你与存活敌人距离 ≤ 60 units 持续 ≥ 2s（同框贴脸）",
    en: "You and a living enemy stayed within 60 units for ≥ 2s without engaging",
  },
  "🙈 视而不见": {
    zh: "肩并肩期间双方都没有意识到对方",
    en: "Both players were unaware of each other during a close-proximity moment",
  },

  // ── 下饭基础 ──
  "💣 惨遭C4洗礼": {
    zh: "被引爆的 C4 炸死",
    en: "Killed by a detonated C4 bomb",
  },
  "电击处刑": {
    zh: "被 Zeus 电击枪击杀",
    en: "Killed by a Zeus taser",
  },
  "沙鹰爆头": {
    zh: "被沙鹰 / 左轮爆头",
    en: "Headshot by a Deagle or R8 Revolver",
  },
  "被刀取辱": {
    zh: "被刀类武器击杀",
    en: "Killed by a knife",
  },
  "自杀": {
    zh: "用自己的武器意外干掉自己",
    en: "Killed by your own weapon accidentally",
  },
  "道具击杀": {
    zh: "被手雷 / 燃烧瓶 / 燃烧弹击杀",
    en: "Killed by a grenade, Molotov, or incendiary",
  },
  "摔死": {
    zh: "摔落 / 世界伤害致死",
    en: "Killed by fall damage or world hazard",
  },
  "痛击队友": {
    zh: "被队友误杀",
    en: "Killed by a teammate (team kill)",
  },

  // ── 下饭高级 ──
  "CS定律": {
    zh: "架枪 ≥10s → 切刀或投掷物 → 1.5s 内被杀",
    en: "Held an angle for ≥ 10s, switched to knife or utility, then died within 1.5s",
  },
  "切刀必死": {
    zh: "CS 定律的语义补充",
    en: "Accompanies the CS Law: died right after switching away from your gun",
  },
  "人肉吸铁石": {
    zh: "爆头死亡且至少 2 个队友比你更靠近击杀者",
    en: "Died by headshot while at least 2 teammates were closer to the attacker",
  },
  "保镖无用": {
    zh: "人肉吸铁石的补充",
    en: "Accompanies a death where nearby teammates offered no protection",
  },
  "人体描边": {
    zh: "死前 3s 内 ≥5 发，未秒杀手，无背向要求",
    en: "Took ≥ 5 hits in the 3s before death without killing the attacker",
  },
  "反向锁头": {
    zh: "人体描边补充：描得越狠死得越快",
    en: "Accompanies a death after absorbing many hits quickly",
  },
  "NiKo Play": {
    zh: "背对杀手，死前 3s 内 ≥1 发，未秒杀手，被反杀",
    en: "Killed from behind after landing hits but failing to finish the attacker",
  },

  // ── 新增下饭 ──
  "🗿 僵尸步": {
    zh: "死前 3s 位移 < 20 units 且被爆头（站桩被秒）",
    en: "Headshot while barely moving in the 3s before death (stationary target)",
  },
  "🐢 散步流": {
    zh: "死前 1s 平均水平速度 ≥ 150 且被爆头（边走边吃头）",
    en: "Headshot while walking at speed ≥ 150 in the 1s before death",
  },
  "🧲 吸铁石": {
    zh: "死于雷/火，且死前 5s 你在主动靠近爆点",
    en: "Killed by a grenade or fire while walking toward the explosion in the 5s before death",
  },
  "🚪 闪送": {
    zh: "开局 8 秒内就死（仓促送死）",
    en: "Died within 8 seconds of round start",
  },

  // ── 合集 ──
  "🥩 亲儿子喂饭": {
    zh: "本局击杀同一敌人 ≥ 8 次（把他当亲儿子喂饭）",
    en: "Killed the same enemy ≥ 8 times in the match",
  },
  "☠️ 本命苦主": {
    zh: "本局被同一敌人击杀 ≥ 3 次（他是你的本命苦主）",
    en: "Killed by the same enemy ≥ 3 times in the match",
  },

  // ── meme ──
  "坐牢集锦": {
    zh: "全局表现惨烈，死亡合集慢慢欣赏",
    en: "Death montage: extremely poor performance throughout the match",
  },
  "🎓 211高材生": {
    zh: "本局 0 杀，坐牢专业 211 毕业",
    en: "Zero kills for the entire match",
  },
};

// English display labels for tags with Chinese characters (emoji preserved).
// Tags that are pure emoji/symbols with no Chinese fall back to the raw tag string.
const LABELS_EN = {
  // ── 动作子标 ──
  "🙈 盲狙": "🙈 Noscope",
  "🧱 穿墙杀": "🧱 Wallbang Kill",
  "🌫️ 混烟": "🌫️ Through Smoke",
  "😎 全白反杀": "😎 Blinded Kill",
  "🤝 好闪配好人": "🤝 Flash Assist Kill",
  "🔙 偷背身": "🔙 Back-turned Kill",
  "爆头": "Headshot",
  "🔫 手枪哥": "🔫 Pistol Headshot",
  "👃 零距离": "👃 Point-blank Headshot",
  "🫵 贴脸超度": "🫵 Close-range Kill",
  "🎯 超远穿墙": "🎯 Long-range Wallbang",
  "🚀 上去就是干": "🚀 Full-sprint Kill",
  "🏃‍♂️ 跑打": "🏃‍♂️ Moving Kill",
  "🎿 一个大拉": "🎿 Strafe Kill",
  "🛸 乌鸦坐飞机": "🛸 Airborne Kill",
  "🌪️ 甩狙": "🌪️ Flick Shot",
  "✈️ 飞天盲狙": "✈️ Jumping Noscope",
  "冷神附体": "Calm Noscope",
  "💥 颗秒": "💥 First-bullet Headshot",
  "🔪 手撕大狙": "🔪 AWP Counter-kill",
  "🔪 刀杀": "🔪 Knife Kill",

  // ── 回合级高光 ──
  "双杀": "Double Kill",
  "三杀": "Triple Kill",
  "四杀": "Quad Kill",
  "五杀 (ACE)": "5-Kill (ACE)",
  "爆发刷屏": "Rapid Multi-kill",
  "枪枪爆头": "All Headshots",
  "⚔️ 首杀": "⚔️ First Kill",

  // ── 经济 / 装备 ──
  "🔫 手枪局专家": "🔫 Pistol Round Expert",
  "💸 ECO翻盘": "💸 ECO Win",
  "🔫 ECO特种兵": "🔫 Anti-ECO Multi-kill",
  "👢 光脚干皮鞋": "👢 Force-buy vs Full-buy Kill",

  // ── 比分 / 残局 ──
  "⛰️ 天王山之战": "⛰️ Pivotal Round",
  "🛡️ 赛点救世主": "🛡️ Match-point Save",
  "命悬一线": "Clutch Hold",
  "📈 绝地追分": "📈 Comeback Round",
  "拒绝下班": "Prevented Match Closure",
  "🗡️ 赛点终结者": "🗡️ Match Closer",
  "一锤定音": "Decisive Win",
  "⚔️ 加时生死战": "⚔️ Overtime Multi-kill",
  "大心脏": "Clutch Overtime",
  "🔥 顺风局战神": "🔥 Dominant Lead Output",
  "无情碾压": "Overwhelming",
  "🔥 3v5 绝地反击": "🔥 3v5 Comeback Win",
  "❤️ 极限锁血战神": "❤️ Low-HP Multi-kill",

  // ── 新增 CS 黑话 ──
  "🔙 背刺": "🔙 Backstab",
  "🔔 极限操作": "🔔 Last-second Play",
  "🧾 上回合的债": "🧾 Revenge Kill",
  "⚰️ 补枪": "⚰️ Kill Steal",
  "🧹 清盘": "🧹 Solo Round Wipe",
  "🔫 一弹双穿": "🔫 Double Wallbang",
  "❤️‍🩹 残血绝地反击": "❤️‍🩹 Low-HP Comeback Kill",
  "🪨 挨揍王": "🪨 Tanked Damage Kill",
  "💣 拆包开光": "💣 Kill While Defusing",
  "🍡 一石二鸟": "🍡 Simultaneous Double Kill",

  // ── 空间深度 ──
  "🔭 百步穿杨": "🔭 Extreme Long-range Kill",
  "🪂 跳杀": "🪂 Airborne Kill",
  "🔀 连穿": "🔀 Multi-penetration Kill",
  "🪂 空中遇难": "🪂 Airborne Enemy Kill",
  "🥷 智斗": "🥷 Patient Wait-and-shoot",

  // ── 虽败犹荣 ──
  "😤 1v2 饮恨": "😤 1v2 Partial Clutch (Lost)",
  "💸 ECO反击": "💸 ECO Multi-kill (Round Lost)",
  "🛡️ 赛点失守": "🛡️ Match-point Round Lost",
  "📉 绝地追分未果": "📉 Comeback Attempt Failed",
  "⛰️ 天王山饮恨": "⛰️ Pivotal Round Lost",

  // ── 拆包 ──
  "⏱️ 极限拆包": "⏱️ Last-minute Defuse",
  "⏱️ 零秒拆包": "⏱️ Zero-second Defuse",
  "🥷 忍者偷包": "🥷 Stealth Defuse",

  // ── 同框 ──
  "🧍 肩并肩": "🧍 Side-by-side",
  "🙈 视而不见": "🙈 Undetected Proximity",

  // ── 下饭基础 ──
  "💣 惨遭C4洗礼": "💣 Killed by C4",
  "电击处刑": "Zeus Taser Kill",
  "沙鹰爆头": "Deagle Headshot Death",
  "被刀取辱": "Killed by Knife",
  "自杀": "Self-kill",
  "道具击杀": "Grenade/Fire Death",
  "摔死": "Fall Damage Death",
  "痛击队友": "Team Kill",

  // ── 下饭高级 ──
  "CS定律": "CS Law",
  "切刀必死": "Knife Switch Death",
  "人肉吸铁石": "Magnet for Bullets",
  "保镖无用": "Useless Cover",
  "人体描边": "Bullet Sponge",
  "反向锁头": "Absorbed All Shots",
  "NiKo Play": "NiKo Play",

  // ── 新增下饭 ──
  "🗿 僵尸步": "🗿 Stationary Headshot",
  "🐢 散步流": "🐢 Walking Headshot",
  "🧲 吸铁石": "🧲 Ran into Grenade/Fire",
  "🚪 闪送": "🚪 Early Rush Death",

  // ── 合集 ──
  "🥩 亲儿子喂饭": "🥩 Repeated Target (Attacker)",
  "☠️ 本命苦主": "☠️ Repeated Target (Victim)",

  // ── meme ──
  "坐牢集锦": "Death Montage",
  "🎓 211高材生": "🎓 Zero-kill Match",
  "👨‍🔬 首席研发工程师": "👨‍🔬 Chief R&D Engineer",
};

const PREFIX = [
  [
    "🔥 1v",
    {
      zh: "回合开局 1 vN 人数劣势下完成多杀（史诗残局）",
      en: "Multi-kill clutch starting 1 vs N players (epic clutch round)",
    },
  ],
  [
    "🔥 2v",
    {
      zh: "回合开局 2 vN 人数劣势下完成多杀",
      en: "Multi-kill clutch starting 2 vs N players",
    },
  ],
  [
    "💀 1v",
    {
      zh: "1 vN 残局差一人封神未遂",
      en: "1 vs N clutch attempt: fell one kill short",
    },
  ],
  [
    "👉 ",
    {
      zh: "合集：被反复喂饭的苦主 × 次数",
      en: "Compilation: repeatedly killed the same enemy × times",
    },
  ],
  [
    "💀 ",
    {
      zh: "合集：本命苦主 × 次数",
      en: "Compilation: killed by the same enemy × times",
    },
  ],
  [
    "👫 同框",
    {
      zh: "你和对面长时间贴身（肩并肩同框）",
      en: "You and an enemy stayed in close proximity for an extended time",
    },
  ],
  [
    "⏳ 持续",
    {
      zh: "同框持续时长",
      en: "Duration of the close-proximity encounter",
    },
  ],
];

const SUFFIX_KILL_COUNT = /^\d+杀\d+死$/;

const SUFFIX_KILL_COUNT_DESC = {
  zh: "全局 K/D 数据徽章",
  en: "Overall K/D badge",
};

function pick(entry, locale) {
  if (!entry) return "";
  return entry[locale] ?? entry.zh ?? "";
}

/** 返回 tag 的说明（默认中文），找不到返回空字符串。 */
export function describeTag(tag, locale = "zh") {
  if (!tag) return "";
  const t = String(tag).trim();
  if (EXACT[t]) return pick(EXACT[t], locale);
  if (SUFFIX_KILL_COUNT.test(t)) return pick(SUFFIX_KILL_COUNT_DESC, locale);
  for (const [p, desc] of PREFIX) {
    if (t.startsWith(p)) return pick(desc, locale);
  }
  return "";
}

/**
 * 返回 tag 的显示名称。
 * 中文 locale 直接返回原 tag 字符串；
 * 英文 locale 返回 LABELS_EN 中的译名（若无则回退到原 tag）。
 */
export function labelTag(tag, locale = "zh") {
  if (!tag) return "";
  const t = String(tag).trim();
  if (locale === "en" && LABELS_EN[t]) return LABELS_EN[t];
  return t;
}
