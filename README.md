# DSH 会话保温 / Session Keep-alive

版本 1.1.2，适配 DSH 0.2.1-rc.3 / 0.2.1-rc.4。

在每个浏览器标签页保留已成功打开会话的原生 session retain 引用，减少左右切换时反复释放、重新加载历史。默认最多 **8 个会话（含当前）**，最后一个显示视图离开后闲置 **30 分钟**释放。只保温实际打开过的会话，不预取未打开的会话。

## 下载与安装

**[下载插件包 v1.1.2（.tgz）](https://github.com/edgora-ai/dsh-session-keepalive/releases/download/v1.1.2/local-dsh-session-keepalive-1.1.2.tgz)** · [SHA256 校验文件](https://github.com/edgora-ai/dsh-session-keepalive/releases/download/v1.1.2/SHA256SUMS.txt) · [Release 与源码](https://github.com/edgora-ai/dsh-session-keepalive/releases/tag/v1.1.2)

需要 DSH **0.2.1-rc.3 或 0.2.1-rc.4**；其他版本不保证兼容。插件包已包含构建后的 `client.js`、Host 入口、bundle patch、语言和图标资源，**无需克隆仓库、手动安装依赖或构建**。插件管理器会安装包所声明的依赖，本包没有安装期生命周期脚本，安装时不执行构建。

### 推荐：直接安装预构建包

在命令行使用 DSH 官方的 `dsh plugin add`；将 `web` 换成你的目标 profile 名称：

```sh
dsh plugin --profile web add 'https://github.com/edgora-ai/dsh-session-keepalive/releases/download/v1.1.2/local-dsh-session-keepalive-1.1.2.tgz'
```

也可以把同一个下载 URL 粘贴到 DSH **插件**页的安装入口，或让 DSH Agent 用 **Plugin Manager** 的 `install_bundle` 将该 URL 作为 `target` 安装。若已下载 `.tgz` 文件，也可执行 `dsh plugin --profile web add /absolute/path/local-dsh-session-keepalive-1.1.2.tgz`，无需解压。

安装需要 Full access 或相应批准，会影响目标 profile 的所有会话。安装后按管理器返回的应用状态操作，并刷新现有 DSH 网页，在聊天输入区附近找到「会话保温」。不要直接编辑 DSH profile 的 `package.json` 或 patch，也不要在 profile 目录手动安装依赖。

### 从源码开发安装

建议使用 Node.js 22 或更新版本：

```sh
git clone https://github.com/edgora-ai/dsh-session-keepalive.git
cd dsh-session-keepalive
git checkout v1.1.2
npm ci --ignore-scripts
npm run build
```

然后用 Plugin Manager 安装目录的绝对路径，例如 `link:/absolute/path/dsh-session-keepalive`。本地目录安装会链接此目录，安装后请保留目录。开发时应修改 `src/`，再执行构建，不要直接修改生成文件。

### 分发与发现

预构建包通过 **GitHub Release 附件**分发，不是 GitHub Packages 或 npm 注册表；`package.json` 的 `private: true` 仅用于防止误发 npm，不影响 MIT 开源或通过 tarball 安装。这与 [DSH 官方打包说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md#从-github-安装构建脚本这道坎)中的 tarball 分发方式一致。

仓库已添加官方 [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md#community-and-support) 建议的 **[`dsh-plugin` GitHub Topic](https://github.com/topics/dsh-plugin)**，用于社区发现。它是仓库主题标签，与版本标签 `v1.1.2` 不同，也不代表官方认证或自动收录到用户配置的自定义插件市场。

## 设置入口

在聊天输入区附近展开 **「会话保温」→「保温设置」**：

- **保温会话数量**：1–32 的整数，默认 8，包含当前会话。
- **闲置释放分钟数**：1–240 的整数，默认 30。
- 点击 **保存设置**；成功时显示「已保存并应用」。
- **恢复继承默认值**：删除这两个用户覆盖值，回到 profile 组合配置；没有组合自定义时为 8 / 30。
- **重新读取已保存值**：丢弃当前输入草稿，重新载入已保存值。

数字通过 DSH 原生 `configForms` → `settings.mutate` 校验并持久保存到当前 profile 的配置文档，不使用 localStorage 保存偏好或聊天。连接同一 Host/profile 的已认证浏览器共享设置；每个标签页仍独立持有缓存。不同浏览器同时编辑时，修订号冲突会拒绝写入并保留输入草稿，不静默覆盖。

设置接受后动态生效：增加上限不丢失已有保温引用；降低上限优先释放闲置的最久未访问项。缩短闲置时限按已闲置时长计算，可能立即释放到期项。原生可见视图拥有自己的引用，不会被插件关闭。设置为只读、不可用或保存失败时会提示，不假装已保存。

多个可见视图占满保温名额时，超额视图只登记当前显示需求，不新增保温引用；名额释放或增加上限后，才为仍显示、仍是同一已打开实例的视图补上保温。降限不丢失这些视图的登记；最后一个视图离开、原生会话失效、暂停或卸载时清理登记。修改数量上限不会重绑所有视图或重置闲置起点。

## 临时控制和限制

- **本标签页暂停 / 恢复**：释放 / 重新允许插件保温，不改变持久设置。
- **释放未显示的会话**：仅清除本插件闲置引用。
- 永久关闭：在插件管理禁用 `@local/dsh-session-keepalive`。
- 刷新页面会清空当前标签页内存缓存，但保留设置。
- 数值越大，内存与实时订阅流量越高。不创建独立 WebSocket，不改网络配置，不启动代理任务，不持久复制聊天记录。
- 无法修复真实断网、反向代理超时或服务重启；真实断线仍由 DSH 原生恢复。连接事件计数包括初次建立。

## 缓存为什么消失：诊断记录

在 **「会话保温」→「缓存诊断（不含聊天内容）」** 查看最多 20 条近期元数据记录，按新到旧排列。连接事件只保留最新一条，连接计数仍累计，避免重复连接记录挤掉释放原因：

- 区分正常到期、数量上限、缩短设置、手动释放、暂停、会话移除、原生实例替换、会话流错误、保温就绪失败、插件卸载。
- 页面重新加载、浏览器明确标记的标签页回收、新页面文档、同一页面内的插件重新加载分别标记；同时记录前后台、网络在线状态及原生连接建立事件。
- 每次释放记录当时实际生效的闲置分钟数、已闲置时长、剩余引用数量。会话流错误现在也计入「保温失败次数」，不再静默显示为零。
- 只把这些有界元数据保存到 **本标签页的 sessionStorage**，允许刷新后继续查看原因；**不保存聊天、会话 ID、页面地址或错误消息**。诊断不能恢复页面内存缓存。关闭标签页、清除站点数据或浏览器禁止存储时，记录可能不可保留；浏览器不能提供的历史原因不会被推断为已确认。
- 普通诊断变化共享一个固定 100 毫秒批次，合并存储写入和订阅通知；持续变化不会延长这一等待窗口。转入后台、pagehide、插件停止时立即保存最后状态并清理定时器。浏览器强制终止且未发出生命周期事件时，最后一个尚未落盘的批次仍可能丢失。
- 更新前的丢失原因无法追溯。本版本没有把已发生的丢失认定为正常到期，也不擅自延长时限、增加数量、重试失败流或修改网络配置。

## Agent 工具

`session_keepalive_settings` 支持 `get`、`set`、`reset`，固定操作本插件两个字段，使用与 UI 相同的原生 `settings.mutate`。可用 `expectedRevision` 防止覆盖并发修改。写入为 profile 共享配置，要求当前会话 **Full access**；其他模式拒绝写入，可由用户在设置 UI 操作。工具不会自行申请提权。

## 1.1.2 审查优化

- 修复满额/降限后仍显示视图丢失保温机会，以及同步订阅清理、旧引用异步回调和重入释放的引用所有权问题。
- 隔离诊断订阅者和错误处理器异常，防止干扰原生引用管理；没有变化的快照不通知，未改变的最近闲置期限不重建计时器。
- 合并诊断写入，保留有用的释放记录和上次已观测摘要；卸载保存实际剩余引用数为零的最终状态。
- 保持默认值、原生设置入口、120 分钟精确闲置到期语义及“不复制聊天、不预取、不自行重试网络”的边界。这些改进不等于确认了某次缓存消失的根因。

## 开发、验证与更新

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check
git diff --exit-code -- client.js
```

Host schema 唯一直接依赖 `@deepseek-ai/schemastery`。Client 不打包 React，复用 DSH 的 React、sessions、slots、locale、configForms 服务。开发目录通过 Plugin Manager 安装；不要直接改 profile 的 package.json 或 patch。

替换已经加载的 Host JavaScript 可能需要重启 DSH 才能载入新模块（尤其从旧版无 Config 升级至 1.1.0）。若设置提示暂不可用，请在当前任务结束后重启现有 DSH 实例，再刷新原来的 GUI 地址；不要另启服务。以后只改这两个设置不需重启、重新安装或改代码。

当前版本包含 103 项测试，包括引用上限、120 分钟闲置边界（虚拟时钟）、视图与原生实例生命周期、诊断隐私与批处理、配置并发冲突，以及 5,100 次确定性混合状态操作。逻辑测试不代表浏览器渲染或所有网络场景均已验证。GitHub Actions 会检查构建结果与提交的 `client.js` 一致。

## 许可证

[MIT](./LICENSE) · Copyright (c) 2026 edgora-ai
