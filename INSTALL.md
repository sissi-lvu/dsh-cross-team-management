# 安装与配置（给别人用）

## 0. 前置

- 已安装 DSH（`dsh` 在 PATH 里），Node 20+
- 想发邮件的话，另装 `dsh-email` 并在「设置 → 邮件」配好账号（IMAP/SMTP/授权码）；不发邮件可以跳过

## 1. 安装插件

任选一种：

```bash
# A. 从 GitHub 直接装
dsh plugin --profile <你的 profile> add github:sissi-lvu/cross-team-management

# B. 从 Release 里的压缩包
dsh plugin --profile <你的 profile> add /path/to/cross-team-management-1.5.1.tgz

# C. 从 clone 下来的目录
dsh plugin --profile <你的 profile> add ./cross-team-management
```

也可以在 DSH 的插件管理里选「安装 bundle」，指向目录或 tgz。
安装后**重启一次** `dsh web`（Host 代码与 Web 面板在启动时加载），刷新页面。

## 2. 建共享目录

目录名就是团队 id，团队 id 在配置里指定。每个团队一个子目录，放 `.docx` / `.pptx` / `.md` / `.txt`：

```
/reports/2026-W44/
├── A_group/weekly.docx
├── B_group/weekly.docx
├── C_group/weekly.pptx
└── D_group/            ← 空目录 = 未提交
```

## 3. 写配置

```bash
cp config.example.json config.json
```

改这四个地方：

| 字段 | 说明 |
|---|---|
| `rootDir` | 共享目录绝对路径（网络盘要先挂载） |
| `teams[].id` | **必须等于子目录名** |
| `deadline` | 本轮截止时间，ISO 带时区 |
| `email` | 发件人、通报收件人；`teams[].email` 填各团队地址 |

`config.json` 改了下次扫描自动生效，不用重装。没有这个文件时插件会报「需要 config.rootDir」。

## 4. 验证

对话里说「把各团队的周报理一下」，应得到红黄绿灯和未提交名单；
右侧栏出现「跨团队管理」面板；`curl -s http://127.0.0.1:3080/cross-team-management/board` 返回 JSON。

## 5. 常用命令

| 想做什么 | 说 / 调什么 |
|---|---|
| 看全景 | 「把各团队的周报理一下」→ `weekly_context(view="overview")` |
| 看某队卡点 | 「A 组的预算怎么回事」→ `weekly_context(view="detail", target="A_group")` |
| 拟反馈 | `weekly_context(view="draft", target="A_group", instruction="预算我批了")` |
| 生成反馈邮件草稿 | `weekly_mail_draft(kind="feedback", target="A_group")`，返回后由模型调 `email_send` 发送 |
| 全员通报 | `weekly_context(view="digest")`；周五 17:00 自动生成通报邮件草稿（不发送） |
| 催办 / 升级 | 自动；手动 `weekly_ops(action="remind")` / `weekly_context(view="escalate", target="D_group")` |
| 换一周 | 改 `config.json` 的 `rootDir` / `label` / `deadline` |
| 重置演示状态 | `weekly_ops(action="reset", scope="all")` |

## 6. 已知边界

- 只抽 docx/pptx 的正文文字，图片不解析，表格文字会压成一行
- 插件只生成邮件草稿，不投递；发送由模型调 `email_send`，依赖 dsh-email 的账号配置与它的确认弹窗
- 非 macOS/Windows 的递归监听会退回 60 秒轮询
- 面板是只读的，催办与发送都在对话里触发
