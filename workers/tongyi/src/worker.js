// ====================================================================
// 抢座管理中枢 — Cloudflare Worker
// ====================================================================
// 功能:
//   1. scheduled()  每分钟轮询, 到 trigger_time 时为每个活跃用户发 dispatch
//   2. fetch()      REST API + 内嵌 Web 管理面板
//
// KV Schema (binding: SEAT_KV):
//   config                → 学校级配置 (trigger_time, endtime, repo, strategy)
//   users                 → 用户 ID 列表 JSON array
//   user:{id}             → 单用户完整配置
//
// Secrets: GH_TOKEN, API_KEY
// ====================================================================

// ─── AES-CBC 加密 (与 Python 端 key/iv = "u2oh6Vu^HWe4_AES" 一致) ───

const AES_KEY_RAW = "u2oh6Vu^HWe4_AES";

async function getAesKey() {
  const raw = new TextEncoder().encode(AES_KEY_RAW);
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function pkcs7Pad(data) {
  const bs = 16;
  const pad = bs - (data.length % bs);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

async function aesEncrypt(plaintext) {
  const key = await getAesKey();
  const iv = new TextEncoder().encode(AES_KEY_RAW);
  const padded = pkcs7Pad(new TextEncoder().encode(plaintext));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    padded
  );
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// ─── 辅助函数 ───

function beijingNow() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 3600 * 1000);
}

function beijingHHMM() {
  const bj = beijingNow();
  const hh = String(bj.getUTCHours()).padStart(2, "0");
  const mm = String(bj.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function beijingDayOfWeek() {
  const days = [
    "Sunday", "Monday", "Tuesday", "Wednesday",
    "Thursday", "Friday", "Saturday",
  ];
  return days[beijingNow().getUTCDay()];
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── 座位冲突检测 ───

function timeOverlap(a, b) {
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  return a[0] < b[1] && b[0] < a[1];
}

function detectConflicts(newUser, allUsers, excludeId) {
  const warnings = [];
  const schedule = newUser.schedule || {};
  const dayNames = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
  ];
  for (const day of dayNames) {
    const nc = schedule[day];
    if (!nc) continue;
    for (const other of allUsers) {
      if (other.id === excludeId) continue;
      if (other.status === "paused") continue;
      const oc = (other.schedule || {})[day];
      if (!oc) continue;
      if (oc.roomid === nc.roomid) {
        const newSeats = Array.isArray(nc.seatid) ? nc.seatid : [nc.seatid];
        const otherSeats = Array.isArray(oc.seatid) ? oc.seatid : [oc.seatid];
        const overlap = newSeats.filter((s) => otherSeats.includes(s));
        if (overlap.length > 0 && timeOverlap(nc.times, oc.times)) {
          warnings.push(
            `⚠️ ${day}: 座位 ${overlap.join(",")} 与 ${other.remark || other.username}(${other.username}) 冲突`
          );
        }
      }
    }
  }
  return warnings;
}

// ─── KV 辅助 ───

async function getConfig(KV) {
  const raw = await KV.get("config");
  if (!raw)
    return {
      trigger_time: "19:57",
      endtime: "20:00:40",
      repo: "BAOfuZhan/hcd",
      strategy: {
        mode: "C",
        submit_mode: "serial",
        login_lead_seconds: 14,
        slider_lead_seconds: 10,
        pre_fetch_token_ms: 1531,
        first_submit_offset_ms: 9,
        target_offset2_ms: 24,
        target_offset3_ms: 140,
        burst_offsets_ms: [422, 815, 1180],
        token_fetch_delay_ms: 9,
      },
    };
  return JSON.parse(raw);
}

async function getUserIds(KV) {
  const raw = await KV.get("users");
  return raw ? JSON.parse(raw) : [];
}

async function getUser(KV, id) {
  const raw = await KV.get(`user:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function getAllUsers(KV) {
  const ids = await getUserIds(KV);
  const users = [];
  for (const id of ids) {
    const u = await getUser(KV, id);
    if (u) users.push(u);
  }
  return users;
}

async function saveUser(KV, user) {
  await KV.put(`user:${user.id}`, JSON.stringify(user));
}

async function saveUserIds(KV, ids) {
  await KV.put("users", JSON.stringify(ids));
}

// ─── scheduled: 每分钟轮询 ───

async function handleScheduled(env, ctx) {
  const config = await getConfig(env.SEAT_KV);
  const now_hhmm = beijingHHMM();

  // 非触发时间 → 仅 1 次 KV 读即返回
  if (now_hhmm !== config.trigger_time) {
    return;
  }

  console.log(`⏰ Trigger time ${config.trigger_time} reached, dispatching...`);

  const dayOfWeek = beijingDayOfWeek();
  const users = await getAllUsers(env.SEAT_KV);

  for (const user of users) {
    if (user.status === "paused") {
      console.log(`⏸ ${user.remark || user.username} paused, skip`);
      continue;
    }

    const daySchedule = (user.schedule || {})[dayOfWeek];
    if (!daySchedule) {
      console.log(`📅 ${user.remark || user.username} no schedule for ${dayOfWeek}, skip`);
      continue;
    }

    const payload = {
      username: user.username,
      password: user.password,
      remark: user.remark || "",
      roomid: daySchedule.roomid,
      seatid: daySchedule.seatid,
      times: daySchedule.times,
      seatPageId: daySchedule.seatPageId || "",
      fidEnc: daySchedule.fidEnc || "",
      strategy: config.strategy || {},
      endtime: config.endtime || "20:00:40",
    };

    ctx.waitUntil(
      dispatchGitHub(env.GH_TOKEN, config.repo, payload).then((ok) => {
        if (ok) console.log(`✅ Dispatched: ${user.remark || user.username}`);
        else console.error(`❌ Failed: ${user.remark || user.username}`);
      })
    );
  }
}

async function dispatchGitHub(token, repo, payload) {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "seat-manager-worker",
        },
        body: JSON.stringify({
          event_type: "reserve",
          client_payload: payload,
        }),
      }
    );
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`GitHub ${resp.status}: ${text}`);
    }
    return resp.ok || resp.status === 204;
  } catch (err) {
    console.error("dispatch error:", err);
    return false;
  }
}

// ─── fetch: API 路由 ───

async function handleFetch(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-API-Key",
      },
    });
  }

  // 管理面板: GET /
  if (path === "/" && method === "GET") {
    return new Response(ADMIN_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // API: 需要鉴权
  if (path.startsWith("/api/")) {
    const apiKey = req.headers.get("X-API-Key") || url.searchParams.get("key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return jsonResp({ ok: false, error: "Unauthorized" }, 401);
    }
    return handleAPI(path, method, req, env);
  }

  return jsonResp({ ok: false, error: "Not Found" }, 404);
}

async function handleAPI(path, method, req, env) {
  const KV = env.SEAT_KV;

  // ── 学校配置 ──
  if (path === "/api/config" && method === "GET") {
    return jsonResp({ ok: true, config: await getConfig(KV) });
  }
  if (path === "/api/config" && method === "PUT") {
    const body = await req.json();
    await KV.put("config", JSON.stringify(body));
    return jsonResp({ ok: true });
  }

  // ── 用户列表 ──
  if (path === "/api/users" && method === "GET") {
    const users = await getAllUsers(KV);
    const safe = users.map((u) => ({
      ...u,
      password: u.password ? "***" : "",
      hasPassword: !!u.password,
    }));
    return jsonResp({ ok: true, users: safe });
  }

  // ── 添加用户 ──
  if (path === "/api/user" && method === "POST") {
    const body = await req.json();
    const { username, password, remark, schedule } = body;
    if (!username) return jsonResp({ ok: false, error: "username required" }, 400);

    const id = `u_${username}`;
    const ids = await getUserIds(KV);
    if (ids.includes(id)) {
      return jsonResp({ ok: false, error: `用户 ${username} 已存在` }, 409);
    }

    const encPwd = password ? await aesEncrypt(password) : "";
    const newUser = {
      id,
      username,
      password: encPwd,
      remark: remark || "",
      status: "active",
      schedule: schedule || {},
    };

    const allUsers = await getAllUsers(KV);
    const warnings = detectConflicts(newUser, allUsers, id);

    ids.push(id);
    await saveUserIds(KV, ids);
    await saveUser(KV, newUser);
    return jsonResp({ ok: true, id, warnings });
  }

  // ── /api/user/:id 路由 ──
  const userMatch = path.match(/^\/api\/user\/([^/]+)(?:\/(.*))?$/);
  if (userMatch) {
    const userId = decodeURIComponent(userMatch[1]);
    const subPath = userMatch[2] || "";

    if (method === "GET" && !subPath) {
      const user = await getUser(KV, userId);
      if (!user) return jsonResp({ ok: false, error: "用户不存在" }, 404);
      return jsonResp({
        ok: true,
        user: { ...user, password: "***", hasPassword: !!user.password },
      });
    }

    if (method === "PUT" && !subPath) {
      const existing = await getUser(KV, userId);
      if (!existing) return jsonResp({ ok: false, error: "用户不存在" }, 404);

      const body = await req.json();
      if (body.password && body.password !== "***") {
        existing.password = await aesEncrypt(body.password);
      }
      if (body.remark !== undefined) existing.remark = body.remark;
      if (body.schedule !== undefined) existing.schedule = body.schedule;
      if (body.username && body.username !== existing.username) {
        existing.username = body.username;
      }

      const allUsers = await getAllUsers(KV);
      const warnings = detectConflicts(existing, allUsers, userId);
      await saveUser(KV, existing);
      return jsonResp({ ok: true, warnings });
    }

    if (method === "DELETE" && !subPath) {
      const ids = await getUserIds(KV);
      const filtered = ids.filter((i) => i !== userId);
      await saveUserIds(KV, filtered);
      await KV.delete(`user:${userId}`);
      return jsonResp({ ok: true });
    }

    if (method === "POST" && subPath === "pause") {
      const user = await getUser(KV, userId);
      if (!user) return jsonResp({ ok: false, error: "用户不存在" }, 404);
      user.status = "paused";
      await saveUser(KV, user);
      return jsonResp({ ok: true, status: "paused" });
    }

    if (method === "POST" && subPath === "resume") {
      const user = await getUser(KV, userId);
      if (!user) return jsonResp({ ok: false, error: "用户不存在" }, 404);
      user.status = "active";
      await saveUser(KV, user);
      return jsonResp({ ok: true, status: "active" });
    }
  }

  // ── 手动触发全部 ──
  if (path === "/api/trigger" && method === "POST") {
    const config = await getConfig(KV);
    const dayOfWeek = beijingDayOfWeek();
    const users = await getAllUsers(KV);
    const results = [];

    for (const user of users) {
      if (user.status === "paused") {
        results.push({ username: user.username, result: "paused_skip" });
        continue;
      }
      const daySchedule = (user.schedule || {})[dayOfWeek];
      if (!daySchedule) {
        results.push({ username: user.username, result: "no_schedule" });
        continue;
      }
      const payload = {
        username: user.username,
        password: user.password,
        remark: user.remark || "",
        roomid: daySchedule.roomid,
        seatid: daySchedule.seatid,
        times: daySchedule.times,
        seatPageId: daySchedule.seatPageId || "",
        fidEnc: daySchedule.fidEnc || "",
        strategy: config.strategy || {},
        endtime: config.endtime || "20:00:40",
      };
      const ok = await dispatchGitHub(env.GH_TOKEN, config.repo, payload);
      results.push({ username: user.username, result: ok ? "dispatched" : "failed" });
    }
    return jsonResp({ ok: true, results });
  }

  // ── 手动触发单个 ──
  const triggerMatch = path.match(/^\/api\/trigger\/([^/]+)$/);
  if (triggerMatch && method === "POST") {
    const userId = decodeURIComponent(triggerMatch[1]);
    const user = await getUser(KV, userId);
    if (!user) return jsonResp({ ok: false, error: "用户不存在" }, 404);

    const config = await getConfig(KV);
    const dayOfWeek = beijingDayOfWeek();
    const daySchedule = (user.schedule || {})[dayOfWeek];
    if (!daySchedule)
      return jsonResp({ ok: false, error: `今天 ${dayOfWeek} 无配置` });

    const payload = {
      username: user.username,
      password: user.password,
      remark: user.remark || "",
      roomid: daySchedule.roomid,
      seatid: daySchedule.seatid,
      times: daySchedule.times,
      seatPageId: daySchedule.seatPageId || "",
      fidEnc: daySchedule.fidEnc || "",
      strategy: config.strategy || {},
      endtime: config.endtime || "20:00:40",
    };
    const ok = await dispatchGitHub(env.GH_TOKEN, config.repo, payload);
    return jsonResp({ ok, result: ok ? "dispatched" : "failed" });
  }

  // ── 密码加密工具 ──
  if (path === "/api/encrypt" && method === "POST") {
    const body = await req.json();
    if (!body.password)
      return jsonResp({ ok: false, error: "password required" }, 400);
    const encrypted = await aesEncrypt(body.password);
    return jsonResp({ ok: true, encrypted });
  }

  return jsonResp({ ok: false, error: "Not Found" }, 404);
}

// ─── 管理面板 HTML ───

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🎓 抢座管理面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#333;min-height:100vh}
.login-wrap{display:flex;justify-content:center;align-items:center;min-height:100vh}
.login-box{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);width:320px}
.login-box h2{text-align:center;margin-bottom:1.5rem;font-size:1.3rem}
.login-box input{width:100%;padding:.7rem;border:1px solid #ddd;border-radius:8px;font-size:1rem;margin-bottom:1rem}
.login-box button{width:100%;padding:.7rem;background:#1677ff;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
.login-box button:hover{background:#0958d9}
.app{display:none;max-width:900px;margin:0 auto;padding:1rem}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem}
.header h1{font-size:1.4rem}
.header-btns{display:flex;gap:.5rem;flex-wrap:wrap}
.btn{padding:.45rem .9rem;border:none;border-radius:6px;cursor:pointer;font-size:.85rem;transition:all .15s}
.btn-primary{background:#1677ff;color:#fff}.btn-primary:hover{background:#0958d9}
.btn-success{background:#52c41a;color:#fff}.btn-success:hover{background:#389e0d}
.btn-warning{background:#faad14;color:#fff}.btn-warning:hover{background:#d48806}
.btn-danger{background:#ff4d4f;color:#fff}.btn-danger:hover{background:#cf1322}
.btn-ghost{background:#f5f5f5;color:#333;border:1px solid #d9d9d9}.btn-ghost:hover{border-color:#1677ff;color:#1677ff}
.card{background:#fff;border-radius:10px;padding:1rem;margin-bottom:.75rem;box-shadow:0 1px 4px rgba(0,0,0,.06);transition:box-shadow .2s}
.card:hover{box-shadow:0 2px 12px rgba(0,0,0,.1)}
.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;flex-wrap:wrap;gap:.5rem}
.card-head .name{font-weight:600;font-size:1.05rem}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:10px;font-size:.75rem;font-weight:500}
.badge-active{background:#f6ffed;color:#52c41a;border:1px solid #b7eb8f}
.badge-paused{background:#fff7e6;color:#faad14;border:1px solid #ffd591}
.card-info{font-size:.85rem;color:#666;margin-bottom:.5rem;line-height:1.6}
.card-actions{display:flex;gap:.4rem;flex-wrap:wrap}
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:999;justify-content:center;align-items:flex-start;padding:2rem 1rem;overflow-y:auto}
.modal-overlay.show{display:flex}
.modal{background:#fff;border-radius:12px;padding:1.5rem;width:100%;max-width:640px;max-height:90vh;overflow-y:auto}
.modal h2{margin-bottom:1rem;font-size:1.2rem}
.form-row{margin-bottom:.8rem}
.form-row label{display:block;font-weight:500;margin-bottom:.3rem;font-size:.9rem}
.form-row input,.form-row select,.form-row textarea{width:100%;padding:.5rem;border:1px solid #ddd;border-radius:6px;font-size:.9rem}
.schedule-grid{border:1px solid #e8e8e8;border-radius:8px;overflow:hidden}
.schedule-day{display:grid;grid-template-columns:100px 1fr;border-bottom:1px solid #e8e8e8;align-items:start}
.schedule-day:last-child{border-bottom:none}
.schedule-day-label{padding:.6rem;background:#fafafa;font-weight:500;font-size:.85rem;display:flex;align-items:center;gap:.4rem;min-height:40px}
.schedule-day-fields{padding:.5rem;display:none;gap:.4rem;flex-wrap:wrap}
.schedule-day-fields.active{display:flex}
.schedule-day-fields input{width:auto;flex:1;min-width:60px;padding:.35rem .5rem;font-size:.82rem}
.schedule-day-fields .field{display:flex;align-items:center;gap:.2rem;font-size:.82rem}
.warnings{background:#fffbe6;border:1px solid #ffe58f;border-radius:8px;padding:.8rem;margin:.8rem 0;font-size:.85rem;color:#ad6800;line-height:1.6}
.modal-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem}
.config-section{margin-top:1rem}
.config-section h3{margin-bottom:.5rem;font-size:1rem}
.config-grid{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
@media(max-width:600px){.config-grid{grid-template-columns:1fr}.schedule-day{grid-template-columns:80px 1fr}}
.empty{text-align:center;color:#999;padding:3rem 1rem;font-size:.95rem}
.toast{position:fixed;top:1rem;right:1rem;z-index:9999;padding:.7rem 1.2rem;border-radius:8px;color:#fff;font-size:.9rem;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
.toast-ok{background:#52c41a}.toast-err{background:#ff4d4f}.toast-warn{background:#faad14;color:#333}
</style>
</head>
<body>

<!-- 登录 -->
<div class="login-wrap" id="loginWrap">
  <div class="login-box">
    <h2>🔐 管理面板登录</h2>
    <input type="password" id="apiKeyInput" placeholder="输入 API Key" autocomplete="off">
    <button onclick="doLogin()">登录</button>
  </div>
</div>

<!-- 主应用 -->
<div class="app" id="app">
  <div class="header">
    <h1>🎓 抢座管理面板</h1>
    <div class="header-btns">
      <button class="btn btn-ghost" onclick="openConfigModal()">⚙️ 学校配置</button>
      <button class="btn btn-success" onclick="triggerAll()">▶️ 手动触发全部</button>
      <button class="btn btn-primary" onclick="openUserModal()">+ 添加用户</button>
      <button class="btn btn-ghost" onclick="doLogout()">退出</button>
    </div>
  </div>
  <div id="userList"></div>
</div>

<!-- 用户编辑弹窗 -->
<div class="modal-overlay" id="userModal">
  <div class="modal">
    <h2 id="userModalTitle">添加用户</h2>
    <input type="hidden" id="editUserId">
    <div class="form-row"><label>用户名 (手机号)</label><input type="text" id="f_username" placeholder="13800001111"></div>
    <div class="form-row"><label>密码 (留空则不修改)</label><input type="password" id="f_password" placeholder="••••••"></div>
    <div class="form-row"><label>备注</label><input type="text" id="f_remark" placeholder="张三 - 图书馆3楼356座"></div>
    <div class="form-row"><label>一周抢座配置</label></div>
    <div class="schedule-grid" id="scheduleGrid"></div>
    <div class="warnings" id="conflictWarnings" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeUserModal()">取消</button>
      <button class="btn btn-primary" onclick="saveUser()">保存</button>
    </div>
  </div>
</div>

<!-- 学校配置弹窗 -->
<div class="modal-overlay" id="configModal">
  <div class="modal">
    <h2>⚙️ 学校配置</h2>
    <div class="config-grid">
      <div class="form-row"><label>触发时间 (HH:MM)</label><input type="text" id="c_trigger_time" placeholder="19:57"></div>
      <div class="form-row"><label>截止时间 (ENDTIME)</label><input type="text" id="c_endtime" placeholder="20:00:40"></div>
      <div class="form-row"><label>GitHub 仓库</label><input type="text" id="c_repo" placeholder="user/repo"></div>
    </div>
    <div class="config-section">
      <h3>策略参数</h3>
      <div class="config-grid">
        <div class="form-row"><label>mode (A/B/C)</label><input type="text" id="s_mode" placeholder="C"></div>
        <div class="form-row"><label>submit_mode</label><input type="text" id="s_submit_mode" placeholder="serial"></div>
        <div class="form-row"><label>login_lead_seconds</label><input type="number" id="s_login_lead"></div>
        <div class="form-row"><label>slider_lead_seconds</label><input type="number" id="s_slider_lead"></div>
        <div class="form-row"><label>pre_fetch_token_ms</label><input type="number" id="s_pre_fetch"></div>
        <div class="form-row"><label>first_submit_offset_ms</label><input type="number" id="s_first_offset"></div>
        <div class="form-row"><label>target_offset2_ms</label><input type="number" id="s_offset2"></div>
        <div class="form-row"><label>target_offset3_ms</label><input type="number" id="s_offset3"></div>
        <div class="form-row"><label>burst_offsets_ms (逗号分隔)</label><input type="text" id="s_burst" placeholder="422,815,1180"></div>
        <div class="form-row"><label>token_fetch_delay_ms</label><input type="number" id="s_token_delay"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeConfigModal()">取消</button>
      <button class="btn btn-primary" onclick="saveConfig()">保存</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const DAY_CN={Monday:"周一",Tuesday:"周二",Wednesday:"周三",Thursday:"周四",Friday:"周五",Saturday:"周六",Sunday:"周日"};
let API_KEY=localStorage.getItem("seat_api_key")||"";
let usersCache=[];

function doLogin(){API_KEY=document.getElementById("apiKeyInput").value.trim();if(!API_KEY)return;localStorage.setItem("seat_api_key",API_KEY);checkAuth()}
function doLogout(){API_KEY="";localStorage.removeItem("seat_api_key");document.getElementById("app").style.display="none";document.getElementById("loginWrap").style.display="flex"}
async function checkAuth(){try{const r=await api("GET","/api/config");if(r.ok){document.getElementById("loginWrap").style.display="none";document.getElementById("app").style.display="block";loadUsers()}else{doLogout();toast("API Key 无效","err")}}catch(e){doLogout()}}

async function api(method,path,body){const opts={method,headers:{"X-API-Key":API_KEY,"Content-Type":"application/json"}};if(body)opts.body=JSON.stringify(body);const r=await fetch(path,opts);return r.json()}

function toast(msg,type){type=type||"ok";const el=document.getElementById("toast");el.textContent=msg;el.className="toast show toast-"+type;setTimeout(()=>el.className="toast",2500)}

async function loadUsers(){const r=await api("GET","/api/users");if(!r.ok)return toast("加载失败","err");usersCache=r.users;renderUsers()}

function renderUsers(){
  const el=document.getElementById("userList");
  if(!usersCache.length){el.innerHTML='<div class="empty">暂无用户，点击右上角添加</div>';return}
  const bjNow=new Date(Date.now()+8*3600000);
  const today=DAYS[bjNow.getUTCDay()];
  el.innerHTML=usersCache.map(u=>{
    const badge=u.status==="paused"?'<span class="badge badge-paused">⏸ 已暂停</span>':'<span class="badge badge-active">✅ 活跃</span>';
    const sch=(u.schedule||{})[today];
    const todayInfo=sch?DAY_CN[today]+" "+(sch.times||[]).join("-")+" 房间"+(sch.roomid||"?")+" 座位"+(Array.isArray(sch.seatid)?sch.seatid.join(","):(sch.seatid||"?")):DAY_CN[today]+" 不抢座";
    const toggleBtn=u.status==="paused"
      ?'<button class="btn btn-success" onclick="toggleUser(\\''+u.id+'\\',\\'resume\\')">恢复</button>'
      :'<button class="btn btn-warning" onclick="toggleUser(\\''+u.id+'\\',\\'pause\\')">暂停</button>';
    return '<div class="card"><div class="card-head"><span class="name">'+(u.remark||u.username)+" ("+u.username+")"+'</span>'+badge+'</div>'
      +'<div class="card-info">今日: '+todayInfo+'</div>'
      +'<div class="card-actions">'
      +'<button class="btn btn-ghost" onclick="editUser(\\''+u.id+'\\')">编辑</button>'
      +toggleBtn
      +'<button class="btn btn-primary" onclick="triggerOne(\\''+u.id+'\\')">触发</button>'
      +'<button class="btn btn-danger" onclick="deleteUser(\\''+u.id+'\\')">删除</button>'
      +'</div></div>';
  }).join("");
}

async function toggleUser(id,action){const r=await api("POST","/api/user/"+encodeURIComponent(id)+"/"+action);if(r.ok){toast(action==="pause"?"已暂停":"已恢复");loadUsers()}else toast(r.error,"err")}
async function deleteUser(id){if(!confirm("确定删除该用户？"))return;const r=await api("DELETE","/api/user/"+encodeURIComponent(id));if(r.ok){toast("已删除");loadUsers()}else toast(r.error,"err")}
async function triggerOne(id){const r=await api("POST","/api/trigger/"+encodeURIComponent(id));if(r.ok)toast("已触发 dispatch");else toast(r.error||"触发失败","err")}
async function triggerAll(){if(!confirm("确定触发全部活跃用户？"))return;const r=await api("POST","/api/trigger");if(r.ok){toast("触发完成: "+r.results.map(x=>x.username+"→"+x.result).join(", "))}else toast("失败","err")}

// --- 用户弹窗 ---
function buildScheduleGrid(schedule){
  const grid=document.getElementById("scheduleGrid");
  grid.innerHTML=DAYS.map(day=>{
    const s=(schedule||{})[day];const checked=!!s;
    const roomid=s?(s.roomid||""):"";
    const seatid=s?(Array.isArray(s.seatid)?s.seatid.join(","):(s.seatid||"")):"";
    const t0=s?(s.times||[])[0]||"":"";const t1=s?(s.times||[])[1]||"":"";
    const spid=s?(s.seatPageId||""):"";const fid=s?(s.fidEnc||""):"";
    return '<div class="schedule-day">'
      +'<div class="schedule-day-label"><input type="checkbox" data-day="'+day+'" '+(checked?"checked":"")
      +' onchange="toggleDay(this)"> '+DAY_CN[day]+'</div>'
      +'<div class="schedule-day-fields'+(checked?" active":"")+'" id="fields_'+day+'">'
      +'<div class="field">房间<input type="text" data-day="'+day+'" data-f="roomid" value="'+roomid+'" placeholder="13484"></div>'
      +'<div class="field">座位<input type="text" data-day="'+day+'" data-f="seatid" value="'+seatid+'" placeholder="356"></div>'
      +'<div class="field">开始<input type="text" data-day="'+day+'" data-f="t0" value="'+t0+'" placeholder="09:00"></div>'
      +'<div class="field">结束<input type="text" data-day="'+day+'" data-f="t1" value="'+t1+'" placeholder="23:00"></div>'
      +'<div class="field">seatPageId<input type="text" data-day="'+day+'" data-f="seatPageId" value="'+spid+'" placeholder="13484"></div>'
      +'<div class="field">fidEnc<input type="text" data-day="'+day+'" data-f="fidEnc" value="'+fid+'" placeholder="4a18e..."></div>'
      +'</div></div>';
  }).join("");
}

function toggleDay(cb){const day=cb.dataset.day;const f=document.getElementById("fields_"+day);if(cb.checked)f.classList.add("active");else f.classList.remove("active")}

function getScheduleFromForm(){
  const schedule={};
  for(const day of DAYS){
    const cb=document.querySelector('input[type=checkbox][data-day="'+day+'"]');
    if(!cb||!cb.checked){schedule[day]=null;continue}
    const g=f=>(document.querySelector('input[data-day="'+day+'"][data-f="'+f+'"]')||{}).value||"";
    const seatRaw=g("seatid");
    const seatArr=seatRaw.includes(",")?seatRaw.split(",").map(s=>s.trim()):[seatRaw.trim()];
    schedule[day]={roomid:g("roomid"),seatid:seatArr,times:[g("t0"),g("t1")],seatPageId:g("seatPageId"),fidEnc:g("fidEnc")};
  }
  return schedule;
}

function openUserModal(){
  document.getElementById("editUserId").value="";
  document.getElementById("f_username").value="";
  document.getElementById("f_password").value="";
  document.getElementById("f_remark").value="";
  document.getElementById("userModalTitle").textContent="添加用户";
  document.getElementById("conflictWarnings").style.display="none";
  buildScheduleGrid({});
  document.getElementById("userModal").classList.add("show");
}

async function editUser(id){
  const r=await api("GET","/api/user/"+encodeURIComponent(id));
  if(!r.ok)return toast("加载失败","err");
  const u=r.user;
  document.getElementById("editUserId").value=u.id;
  document.getElementById("f_username").value=u.username;
  document.getElementById("f_password").value="";
  document.getElementById("f_remark").value=u.remark||"";
  document.getElementById("userModalTitle").textContent="编辑用户 - "+(u.remark||u.username);
  document.getElementById("conflictWarnings").style.display="none";
  buildScheduleGrid(u.schedule);
  document.getElementById("userModal").classList.add("show");
}

function closeUserModal(){document.getElementById("userModal").classList.remove("show")}

async function saveUser(){
  const id=document.getElementById("editUserId").value;
  const username=document.getElementById("f_username").value.trim();
  const password=document.getElementById("f_password").value;
  const remark=document.getElementById("f_remark").value.trim();
  const schedule=getScheduleFromForm();
  if(!username)return toast("用户名不能为空","err");
  let r;
  if(id){r=await api("PUT","/api/user/"+encodeURIComponent(id),{username,password:password||"***",remark,schedule})}
  else{if(!password)return toast("新用户密码不能为空","err");r=await api("POST","/api/user",{username,password,remark,schedule})}
  if(!r.ok)return toast(r.error||"保存失败","err");
  const warnEl=document.getElementById("conflictWarnings");
  if(r.warnings&&r.warnings.length){warnEl.innerHTML=r.warnings.join("<br>");warnEl.style.display="block";toast("已保存 (有冲突警告)","warn")}
  else{warnEl.style.display="none";toast("已保存");closeUserModal()}
  loadUsers();
}

// --- 配置弹窗 ---
async function openConfigModal(){
  const r=await api("GET","/api/config");if(!r.ok)return toast("加载配置失败","err");
  const c=r.config;const s=c.strategy||{};
  document.getElementById("c_trigger_time").value=c.trigger_time||"";
  document.getElementById("c_endtime").value=c.endtime||"";
  document.getElementById("c_repo").value=c.repo||"";
  document.getElementById("s_mode").value=s.mode||"C";
  document.getElementById("s_submit_mode").value=s.submit_mode||"serial";
  document.getElementById("s_login_lead").value=s.login_lead_seconds||14;
  document.getElementById("s_slider_lead").value=s.slider_lead_seconds||10;
  document.getElementById("s_pre_fetch").value=s.pre_fetch_token_ms||1531;
  document.getElementById("s_first_offset").value=s.first_submit_offset_ms||9;
  document.getElementById("s_offset2").value=s.target_offset2_ms||24;
  document.getElementById("s_offset3").value=s.target_offset3_ms||140;
  document.getElementById("s_burst").value=(s.burst_offsets_ms||[422,815,1180]).join(",");
  document.getElementById("s_token_delay").value=s.token_fetch_delay_ms||9;
  document.getElementById("configModal").classList.add("show");
}

function closeConfigModal(){document.getElementById("configModal").classList.remove("show")}

async function saveConfig(){
  const burstRaw=document.getElementById("s_burst").value;
  const burstArr=burstRaw.split(",").map(s=>parseInt(s.trim())).filter(n=>!isNaN(n));
  const config={
    trigger_time:document.getElementById("c_trigger_time").value.trim(),
    endtime:document.getElementById("c_endtime").value.trim(),
    repo:document.getElementById("c_repo").value.trim(),
    strategy:{
      mode:document.getElementById("s_mode").value.trim(),
      submit_mode:document.getElementById("s_submit_mode").value.trim(),
      login_lead_seconds:parseInt(document.getElementById("s_login_lead").value)||14,
      slider_lead_seconds:parseInt(document.getElementById("s_slider_lead").value)||10,
      pre_fetch_token_ms:parseInt(document.getElementById("s_pre_fetch").value)||1531,
      first_submit_offset_ms:parseInt(document.getElementById("s_first_offset").value)||9,
      target_offset2_ms:parseInt(document.getElementById("s_offset2").value)||24,
      target_offset3_ms:parseInt(document.getElementById("s_offset3").value)||140,
      burst_offsets_ms:burstArr,
      token_fetch_delay_ms:parseInt(document.getElementById("s_token_delay").value)||9
    }
  };
  const r=await api("PUT","/api/config",config);
  if(r.ok){toast("配置已保存");closeConfigModal()}else toast(r.error||"保存失败","err");
}

if(API_KEY)checkAuth();else document.getElementById("loginWrap").style.display="flex";
</script>
</body>
</html>`;

// ─── 导出 ───

export default {
  async scheduled(event, env, ctx) {
    await handleScheduled(env, ctx);
  },
  async fetch(req, env) {
    return handleFetch(req, env);
  },
};
