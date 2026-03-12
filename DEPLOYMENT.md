# 多用户座位预约系统 - Cloudflare Workers 部署指南

## 架构概述

系统采用 **Cloudflare Worker + KV 存储 + GitHub Actions** 的组合：

- **Worker**：每分钟检查 KV 中的触发时间，到点后为每个活跃用户分别触发 GitHub Actions
- **KV 存储**：存储用户配置（AES-CBC 加密的密码）、触发时间、学校策略等
- **GitHub Actions**：接收 Worker dispatch 事件，使用 Python 执行座位预约
- **Web 管理面板**：内嵌在 Worker 中的单页应用，用于配置用户、策略、查看日志

## 部署步骤

### 1. 部署 Worker

```bash
cd workers/tongyi

# 安装依赖（可选，wrangler 通常全局安装）
npm install

# 部署到 Cloudflare
npx wrangler deploy
```

部署成功后，记录 Worker URL，例如：`https://seat-manager-xxx.username.workers.dev`

### 2. 配置 KV 命名空间

确保 Cloudflare 账户中存在名称为 `SEAT_KV` 的 KV 命名空间，ID 为 `855ed3d52d7b47c9bbf76681d69de5b5`（见 `wrangler.toml`）。

### 3. 初始化学校配置

1. 浏览 Worker URL，进入管理面板
2. 在 **API_KEY** 输入框中输入一个安全的密钥（如 `my-secure-key`）
3. 点击 **登录**
4. 在 **配置管理** 标签中设置学校级别参数：
   - `trigger_time`：预约触发时间（HH:MM 格式）
   - `endtime`：预约截止时间（HH:MM:SS 格式）
   - `repo`：GitHub 仓库名（格式 `owner/repo`）
   - `strategy`：座位预约策略参数（可选）

### 4. 配置 GitHub Secrets

登录 GitHub，进入本仓库设置，添加以下 Secrets：

- `CX_USERNAME`：学校超星账号（可选，dispatch 时使用 Worker 中的密码）
- `CX_PASSWORD`：学校超星密码（可选）
- `GH_TOKEN`：GitHub 个人访问令牌，用于 Worker 调用 GitHub API dispatch（需要 `repo` 权限）
- `TULINGCLOUD_USERNAME`：图灵云打码平台用户名（可选）
- `TULINGCLOUD_PASSWORD`：图灵云打码平台密码（可选）
- `TULINGCLOUD_MODEL_ID`：图灵云模型 ID（可选）

### 5. 添加用户

使用 Worker Web 面板：

1. 进入 **用户管理** 标签
2. 点击 **添加新用户**
3. 填写用户信息：
   - **用户名**：超星账号
   - **密码**：超星密码（自动 AES-CBC 加密存储）
   - **备注**：用户标识（显示在 Actions 运行名称）
   - **房间 ID**：需通过 `config.json` get_roomid 获取
   - **座位号**（可多选）：预约座位编号
   - **预约时间**：每个座位的预约时间段
   - **周计划**：选择每周哪些日期参与预约

4. 在 **座位冲突检测** 中查看警告（同一时间同一房间多人不能预约同一座位）

## 工作流

### 触发流程

1. **定时检查**：Worker 每分钟在 `handleScheduled()` 中执行
2. **时间比对**：对比当前 HH:MM 与 KV 中的 `trigger_time`
3. **用户遍历**：找出状态为 `"active"` 且今日在计划中的所有用户
4. **独立 Dispatch**：为每个用户调用 GitHub API `POST /repos/{owner}/{repo}/dispatches`，传递 payload

### Payload 结构

Worker 发送给 GitHub Actions 的 payload 包含：

```json
{
  "username": "student_id",
  "password": "<AES-CBC 加密的密码>",
  "roomid": "12345",
  "seatid": ["043"],
  "times": "09:00-11:00",
  "seatPageId": "",
  "fidEnc": "",
  "remark": "用户备注",
  "strategy": { /* 学校策略参数 */ }
}
```

### GitHub Actions 执行

1. **接收事件**：`reserve.yml` 监听 `repository_dispatch` 事件，类型为 `reserve`
2. **解密密码**：调用 `main.py --action --dispatch`，读取 `DISPATCH_PAYLOAD` 环境变量
3. **AES 解密**：`AES_Decrypt()` 还原明文密码
4. **单用户预约**：执行座位预约逻辑（使用该用户的房间、座位、时间）
5. **完成退出**：执行完毕后返回，等待 Worker 下一分钟的检查

## 本地调试

### 仅用 config.json 运行（不借助 Worker）

```bash
# 编辑 config.json（参考格式见文件注释）
python main.py  # 使用 config.json 中的所有用户

# 指定调试模式
python main.py --method debug
```

### Worker 本地测试

```bash
cd workers/tongyi
npx wrangler dev

# 在浏览器访问 http://localhost:8787
```

### GitHub Actions 手动触发

在 GitHub 网页端进入 **Actions** → **Reserve** 工作流，点击 **Run workflow**（这会使用 `workflow_dispatch` 触发，走本地 `config.json`，不走 dispatch 路径）。

## 常见问题

### 1. Worker 中的用户更新不生效

- KV 数据有 1 分钟缓存，修改后需要等待下一个 cron 周期
- 检查 KV 中的实际数据：使用 Cloudflare Workers KV 控制面板

### 2. Actions 运行单次结束

- dispatch 设计是：Worker 每分钟到点时触发一次，完成后即退出
- 如需多轮重试，在 `config.json` 中配置策略参数 `mode` 和 `submit_mode`

### 3. 密码解密失败

- 确保 AES 密钥一致：Worker 和 Python 都使用 `u2oh6Vu^HWe4_AES`
- 检查 Worker `aesEncrypt()` 和 Python `AES_Decrypt()` 的密钥、IV、padding 参数

### 4. GitHub API 调用限制

- 确保 `GH_TOKEN` 拥有 `repo` 权限
- Worker 调用频率（每分钟最多 60 次 dispatch）一般不会触底限

## 文件说明

| 文件/目录 | 用途 |
|----------|------|
| `workers/tongyi/src/worker.js` | Cloudflare Worker 主程序（定时器 + REST API + Web UI）|
| `workers/tongyi/wrangler.toml` | Wrangler 配置（cron、KV 绑定）|
| `.github/workflows/reserve.yml` | GitHub Actions 工作流定义 |
| `main.py` | 座位预约主程序（支持 --dispatch 单用户模式）|
| `utils/encrypt.py` | AES-CBC 加解密工具函数 |
| `config.json` | 本地调试配置（多用户）|
| `requirements.txt` | Python 依赖 |

## 更新日志

### v1.0.0 (2026-03-13)

- ✅ Cloudflare Worker 完整实现（定时调度、REST API、Web 管理面板）
- ✅ 座位冲突检测
- ✅ AES-CBC 密码加密存储
- ✅ GitHub Actions dispatch 集成
- ✅ 支持每用户独立的周计划和策略参数
