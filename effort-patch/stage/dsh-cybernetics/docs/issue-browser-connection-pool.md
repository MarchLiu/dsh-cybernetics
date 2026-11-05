# Issue 草稿 / Issue Draft

> 本文件为可直接提交至上游仓库 DeepSeek-AI/deepseek-harness 的 issue 草稿。
> Title（英文）见下；正文以中文为主，附英文摘要。

---

## Title / 标题

**[EN]** Bug: Persistent SSE/long-polling event streams from client plugins exhaust the browser's per-host HTTP/1.1 connection pool (~6 connections), leaving new API requests (e.g. `/api/pluginManager/listBundles`) queued indefinitely and the page unresponsive

**[ZH]** 各插件常驻 SSE/长轮询事件流占满浏览器对同一 host 的 HTTP/1.1 连接池（约 6 条），导致新请求（如 `/api/pluginManager/listBundles`）无限排队、页面假死

---

## Summary / 摘要（EN）

When multiple DSH web tabs are open against the same host, the browser's per-origin HTTP/1.1 connection limit (~6 sockets in Chrome) is saturated by resident SSE / long-polling event streams opened by client plugins (plus dsh-farm's 5s polling). New requests — e.g. `POST /api/pluginManager/listBundles`, `listPlugins`, `listVersionExemptions`, `schedule/list`, `GET /farm/services` — stay *pending* for 15s+ and end with `net::ERR_ABORTED`, while requests from already-established tabs still return 200. The page appears frozen. Server-side investigation rules out a slow host: `listBundles` is fully synchronous and millisecond-scale, and the host main thread is idle (94% in `kevent`).

---

## 正文 / Body（ZH）

### Environment / 环境

- dsh `0.2.1-rc.3`
- OS: macOS
- Browser: Chrome（HTTP/1.1；宿主 server 当前仅支持 HTTP/1.1，未启用 h2）
- profile 挂载了大量客户端插件（含多个带常驻 SSE/长轮询事件流的插件，以及 dsh-farm 服务）
- 同一 host 下多标签页使用

### Steps to Reproduce / 复现步骤

1. 启动 DSH web profile，浏览器打开 DSH web 页面（标签页 A），登录。
2. 再开 1–2 个同 host 的 DSH web 标签页（标签页 B、C），保持打开（各标签页的插件事件流与轮询即开始占用连接）。
3. 在新标签页中打开插件页（如 plugin manager UI）。
4. 打开 DevTools → Network 面板，观察：
   - `POST /api/pluginManager/listBundles`
   - `POST /api/pluginManager/listPlugins`
   - `POST /api/pluginManager/listVersionExemptions`
   - `POST /api/schedule/list`
   - `GET /farm/services`

### Expected vs Actual / 预期与实际

- **Expected**：上述 API 在毫秒~秒级返回 200，页面正常渲染、可交互。
- **Actual**：新标签页中上述请求全部 **pending 15s+** 后以 `net::ERR_ABORTED` 失败；与此同时老标签页对同一批 API 的请求仍正常返回 **200**。页面交互假死（点击、渲染均无响应）。独立复现 3 次现象一致。

### Analysis / 根因分析（附证据）

**已排除服务端问题：**

1. 宿主 `listBundles` 实现为全同步逻辑，单次调用仅毫秒级 —— 证据：`dsh-plugin-manager/lib/index.js:1681-1799`。
2. macOS `sample` 抓栈显示宿主进程主线程空闲，94% 时间停留在 `kevent`（事件循环等待），不存在主线程阻塞。
3. 未登录状态下直接 curl 该接口，**1ms 返回 401** —— 请求根本没被服务端排队，排除网关/路由层阻塞。

**真实机制：**

- 宿主 server 仅支持 HTTP/1.1（无 h2 多路复用），Chrome 对同一 host 默认仅约 6 条并发 TCP 连接。
- 每个标签页除 1 条 `/api/remote.mux` WebSocket（WS 不占用 HTTP 连接池）外，各客户端插件还各自打开常驻 **SSE / 长轮询事件流**；dsh-farm 另有**每 5 秒一次**的轮询请求。这些常驻流把 6 条连接持续占满。
- 于是新标签页发起的普通 API 请求只能在浏览器 socket 池中**无限排队**，直到超时被浏览器 abort（15s+ 后 `net::ERR_ABORTED`），表现为页面假死。这也一并解释了「多标签页导致浏览器失响应」的现象。

### Suggested Fixes / 修复建议（分层）

**宿主 / 上游侧：**

1. **事件通道合并**：将各插件独立的 SSE/长轮询事件流迁移到已存在的 `/api/remote.mux` WebSocket 上复用单一条连接（每标签页一条 WS，多路复用所有插件事件），从根本上消除连接池占用。
2. **client RPC 加固**：client RPC 增加请求超时与失败重试，避免排队超时后页面无限等待、无恢复路径。
3. **dsh-farm 轮询降频**：dsh-farm 的 5 秒轮询改为指数退避，或迁移为 WS 推送。
4. **评估启用 HTTP/2**：宿主 server 评估支持 h2，使浏览器对同一 host 多路复用，绕开 HTTP/1.1 的 6 连接限制。

**用户侧临时缓解：**

- 减少同一 host 下打开的 DSH web 标签页数量；
- 停用带常驻 SSE/长轮询事件流的插件。

### Additional Context / 补充

以上结论来自对 `0.2.1-rc.3` 的排查：服务端同步实现（`dsh-plugin-manager/lib/index.js:1681-1799`）+ `sample` 主线程空闲证据 + 401 快速返回，三点共同将问题定位在浏览器连接池耗尽，而非宿主处理能力。如需完整排查记录可进一步提供。
