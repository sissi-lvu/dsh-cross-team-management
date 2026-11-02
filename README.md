# cross-team-management · 跨团队管理

**用途：把团队周报变成模型每轮自带的上下文。**

它是「上下文管理」在跨团队周报这个场景上的落地，五段固定，材料可换：

- **采集**：扫共享目录里的 docx/pptx，`fs.watch` 感知补交
- **过滤**：分句去掉计划句与低信息流水账，只留卡点、进展、计划
- **组织**：六个视图（全景 / 下钻 / 拟稿 / 通报 / 升级 / 事件）
- **注入**：每轮 system prompt 里 5 行看板，模型不用问就知道大盘
- **反馈**：催办台账、已读标记、逾期升级（复盘回写还没做）

产出四样：红黄绿灯大盘、拟稿要素、催办/升级函、邮件草稿。
换一种材料（邮件、日志、会议纪要）只换采集器与模板，组装与注入不变。

## 安装

```bash
dsh plugin --profile web add /Users/sissi/Documents/deepseek-harness/default-workspace/cross-team-management
```

或在插件管理里 `install_bundle` 指向这个目录。profile 用 `link:` 关联，改代码后重新挂载即可生效。

## 配置

`config.json`（与本目录同级，改了下次扫描自动生效）：

```json
{
  "rootDir": "<共享目录绝对路径，子目录名 = 团队 id>",
  "label": "2026-W44",
  "deadline": "2026-10-29T18:00:00+08:00",
  "adviceMode": "hint",
  "teams": [{ "id": "A_group", "name": "产品A组", "focus": "拉新增长" }]
}
```

- `adviceMode`：`hint` 给规则候选建议；`off` 只给事实
- 其余可选项：`escalateHours`(24) / `digest.weekday`(5) / `digest.hour`(17) /
  `autoRemind` / `autoEscalate` / `autoDigest` / `injectPrompt` / `watch` / `scheduler` / `tickSeconds`(60)

插件行 `config`（`cordis.patch.yml`）作为默认值，`config.json` 覆盖它。

## Web 面板（只读，不花 token）

侧栏「跨团队管理」面板显示大盘、团队红黄绿灯、卡点摘要、**最近动作（含已读/未读）**与更新时间，每 10 秒轮询一次。
未读事件旁边有「全部标为已读」按钮（POST `/cross-team-management/ack`，仅本机、仅 JSON），
已读事件仍保留在列表里，只是变成灰点。

- 数据来自 Host 路由 `GET /cross-team-management/board`（仅本机回环，无 CORS，`no-store`）
- 面板拉的是插件发布的内存快照，**不会触发模型调用，也不触发扫描**
- 面板侧代码在 `client.js`，需要重启 dsh 一次才会加载（host 模块与 client 图都在启动时构建）

## 邮件草稿（不直接发信）

`weekly_mail_draft(kind, target, subject?, body?)` 只负责**组装**：

- 解析收件人（团队 `email` 或 `email.digestTo`）
- 生成主题与正文（不传 `body` 时用规则草稿）
- 落盘 `.eml` 到 `<rootDir>/_mail/`（RFC 2047 主题 + base64 正文）
- 返回明确的下一步：调用 `email_send`，附 `to / subject / text` 三个参数

**插件不会投递**。是否发送由模型在下一轮决定，用户会在 `email_send` 的确认里选择发送或拒绝。

`email.signature` 为空时不加落款；填 `"—— 张三"` 才会出现在正文末尾。
截止时间已经过去时，正文不再写「本周截止」，避免给团队一个过期时间点。

周五 17:00 生成全员通报时，会自动多生成一份通报邮件草稿（`_mail/<日期>-digest-all-auto.eml`），
仍然不发送；`weekly_context(view="digest")` 会带上草稿路径。
这样分工是：控制层组装 → 模型决策 → dsh-email 执行并让用户确认。

配置：

```json
{
  "email": {
    "enabled": true,
    "from": "pm@example.com",
    "fromName": "跨团队管理",
    "digestTo": ["boss@example.com"],
    "subjectPrefix": "[周报台]",
    "signature": ""
  },
  "teams": [{ "id": "A_group", "name": "产品A组", "email": "a-team@example.com" }]
}
```

## 数据

- 台账：`$DSH_HOME/state/cross-team-management/ledger.json`（首次启动会从旧 evolve 台账迁移一次）
- 催办 / 升级函：`<rootDir>/_dispatch/<日期>-<团队>-<类型>.md`
- 每个团队每天只催办一次；按文件存在性去重，多实例也不会重复发

## 工具

| 工具 | 用途 |
|---|---|
| `weekly_context(view, target, instruction)` | overview / detail（含进展、卡点、下周计划、原文）/ draft / digest / escalate / updates |
| `weekly_ops(action, target, at, scope)` | scan / remind / tick / digest / prompt / reset |

`tick` 支持 `at` 模拟时间，用于演示超时升级与周五通报。

## 边界

- 只抽 docx/pptx 的正文文字；图片不解析，表格文字会被压成一行
- 没有 IM 通道：催办写到 `_dispatch/`，接企业微信只换 `domain.mjs` 里的 `dispatchTo()`
- 非递归监听平台会退回 60 秒轮询

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | Harness 适配层：工具注册、状态目录、台账迁移 |
| `domain.mjs` | 领域逻辑：扫描、抽取、分类、台账、六个视图 |
| `config.json` | 共享目录与团队表 |
| `cordis.patch.yml` | bundle 行与默认 config |
| `locale/{zh,en}.json` | 插件标题与描述 |
| `icon.svg` | 插件图标 |
