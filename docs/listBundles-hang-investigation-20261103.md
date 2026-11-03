# /api/pluginManager/listBundles 挂起问题排查报告（cybernetics 本轮，只读调研）

日期：2026-11-03（本地 23:39–00:02）
执行者：task agent（dsh-cybernetics 会话，宿主 checkout 只读）

## 结论（一句话）

`/api/pluginManager/listBundles` 挂起**不是** listBundles 实现慢或死锁，也**不是**插件页重复调用导致宿主扫描过重；
它是**浏览器对 HTTP/1.1 同一 host 的连接池（约 6 条）被大量常驻长连接（WS 之外的 SSE/事件流 + 轮询）占满后，
新请求在浏览器侧排队、永远等不到 socket** 的现象。宿主进程主线程空闲、从未收到/处理这些请求。
多标签页打开 GUI 时每个标签都会新增一条 `/api/remote.mux` WebSocket + 多条事件流，迅速耗尽 6 条池连接——
这正是"多标签页导致浏览器失去响应"和"插件页卡片链路（listBundles/listPlugins）被阻塞"的共同根源。

## 复现（真实环境，证据）

- 三次独立复现（三个全新浏览器会话，23:41 / 23:48 / 23:55）：带登录态 `POST /api/pluginManager/listBundles`
  7.6s/15.6s/8.3s 超时，`net::ERR_ABORTED`，**从未收到响应头**（CDP 网络捕获：request state=failed/pending，
  response_body unavailable）。同法 `pluginManager/listPlugins`、`listVersionExemptions`、`schedule/list` 同样挂起。
- 未登录 `curl -X POST http://127.0.0.1:3080/api/...` → **401，1ms 内返回**（说明 HTTP 服务、路由、admit 全部正常）。
- 宿主进程 `sample 39225`（端口 3080 监听者）：主线程 2260 个采样中 2121 个停在 `kevent`（事件循环空闲等待），
  **没有阻塞**；常驻内存 1.1GB（另一个值得关注的独立问题）。
- 用户实际打开插件页（/plugins/??…）时，整页请求全部 pending：`/farm/services`（×6，5 秒重试堆积）、
  `/api/pluginManager/listPlugins`、`/api/pluginManager/listBundles`、`/api/schedule/list`、`/api/commands/list`、
  `/api/skills/list`、`/api/credentials/describe`（×3）、`/api/pet/*`、`/api/skin-center/*`、
  `/api/dsh-usage/overview`（20 秒后被页面自身超时中止）——见 CDP capture `listBundles-hang`（116 条请求，~25 条 pending）。
- `lsof -nP -iTCP:3080`：Chrome 持有 **17 条** ESTABLISHED 连接；`curl -I` 确认服务器为 **HTTP/1.1**（无 h2）。
  Chromium 对 HTTP/1.1 同一 host 的并发连接上限为 6；WS 不占该池，SSE/普通 fetch 占用。

## 代码证据（文件+行，均为只读引用）

1. listBundles 本身是**全同步**方法，不可能自行挂起：
   - `@deepseek-ai/dsh-plugin-manager/lib/index.js:1681`（`listBundles()`，profile 与全局安装 diff 为 SAME）
   - 实现内只有 `readFileSync`/YAML 解析（`lib/index.js:1766-1799` 收尾 `return Promise.resolve(bundles)`）；
     实测量级：80 个依赖的 package.json 共 223KB + 57 个 patch 文件 15KB，单次调用远小于 100ms。
2. 分发链路也没有异步等待点（profile 与全局 SAME）：
   - `@deepseek-ai/dsh-client-connection/lib/index.js:1045-1062`：`/api` 路由 admit（401 快路径）→ `bridge` →
     `rpcFetchHandler.fetch`（:871-913）→ gateway `dispatchRpc`。
   - `@deepseek-ai/dsh-api-gateway/lib/index.js:961-978`（dispatchRpc/invokeRpc）、`:1190-1230`（prepareInvocation，
     strict 描述符 `invocation:{kind:'direct'}`，见 `dsh-plugin-manager/lib/typert.host.js:580-604`）→ 同步调用业务方法。
3. 浏览器侧传输（挂起真正发生的地方）：
   - `@deepseek-ai/dsh-client-connection/lib/client.browser.js:1209-1237`（`createWebConnectionRpc.call`）：
     普通 `fetch(POST /api/<endpoint>)`，**无超时**；请求发不出去（池排队）时 promise 永远 pending。
   - WS 通道 `/api/remote.mux` 定义于 `dsh-api-gateway/lib/index.js:133`；浏览器每页一条
     （`dsh-api-gateway/lib/client.browser.js:1630`），WS 不占 HTTP 池，但每个标签的 SSE/事件流占用。
4. 放大器（插件侧）：
   - `dsh-farm/client.js:209`：`setInterval(refresh, 5000)` —— 每个挂载了 farm 面板的标签每 5 秒打一次
     `/farm/services`；请求排队后，每个 tick 再堆一条 pending（捕获中同一 tab 堆了 6 条）。
   - 插件页自身的读组逻辑 `@linxin666/dsh-client-ui-plugin-manager/lib/client.js:635`（readGroup 并发调
     listPlugins + listBundles）本身频率合理，不是问题源头。

## 与委托书预期的偏差

- 委托书假设"listBundles 读多少文件/扫多少目录/等待锁导致挂起"——已排除：实现同步、量级小、
  宿主主线程空闲、且同时段 `/farm/services` 等非 RPC 路由同样挂起。
- 委托书假设"SSE 资源耗尽"——**方向正确**：耗尽的是浏览器每 host 6 条的 HTTP/1.1 连接池，
  被 GUI 各标签的常驻事件流（以及每标签 1 条 WS 之外的 SSE 类流）占满。
- 与并行 goal cyb-30cba954 的关系：其结论"listBundles 挂起阻塞插件页"成立，但归因（宿主实现）
  需修正为浏览器连接池饥饿；其改动（cordis.patch.yml / lib/client.js，dsh-cybernetics 仓库）不受影响。

## 修复建议分层

### A. 用户侧（立即生效，无需改码）
- 关闭多余的 GUI 标签页（尤其是停留在插件页/看板页的后台标签），挂起的 listBundles 立即恢复返回。

### B. 插件侧（可落地，但不在本轮可写仓库内）
本轮可写仓库为 `/Users/mars/jobs/dsh-cybernetics`（dsh-cybernetics），其 client 不发起任何常驻 HTTP 流
（`lib/client.js` 只使用宿主提供的 faces），**无该问题的可落地修复点** —— 按验收项 2 如实报告"本仓库无可行插件侧方案"。
真正值得改的插件（均在只读 profile 内，属下一轮或对应仓库任务）：
- `dsh-farm/client.js:209`：把固定 5s 轮询改为事件驱动/指数退避 + `document.visibilityState==='hidden'` 时暂停；
- 各自维护 SSE/长轮询的插件（taskboard events、convmap、pet 等）合并为共享一条流或迁移到 `/api/remote.mux` WS 复用；
- `@linxin666/dsh-client-ui-plugin-manager`：对 readGroup 结果做 30-60s 内存缓存，失败重试加退避，
  避免排队期间反复堆叠请求。

### C. 宿主/上游侧（建议补丁位置，未修改）
- 核心：减少长连接对浏览器 6-socket 池的占用。`@deepseek-ai/dsh-api-gateway/lib/index.js:133`
  已有 WS mux（`/api/remote.mux`）承载 Typert 流；建议上游把插件自定义事件通道统一迁移到该 mux
  的逻辑流（open/item/end/cancel 帧协议已在 `stream-protocol` 实现），或提供官方 SSE→WS 复用桥。
- 次要：`@deepseek-ai/dsh-client-connection/lib/client.browser.js:1209` 的 `createWebConnectionRpc.call`
  增加可配置超时（如 AbortSignal.timeout(30s)），把"永远 pending"变成可见错误；
  `dsh-host-webserver` 可考虑响应头提示或文档说明 HTTP/1.1 单 host 限制。
- 观察项：宿主进程 RSS 1.1GB（sample 输出 Physical footprint），建议上游加内存基线告警（独立问题）。

## 验证方式（可复现命令）
1. `curl -o /dev/null -w '%{http_code} %{time_total}\n' -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3080/api/pluginManager/listBundles` → `401 0.001`（服务正常）。
2. `sample <node-pid> 3` → 主线程 kevent 空闲（服务未阻塞）。
3. 登录态浏览器 `fetch('/api/pluginManager/listBundles', {method:'POST', ...})` + AbortController(8s) → 挂起；
   同时 `lsof -nP -iTCP:3080` 数 Chrome ESTABLISHED ≈17（HTTP/1.1，池 6）。
4. CDP 网络捕获：新开插件页后 `/api/pluginManager/listBundles`、`/api/schedule/list`、`/farm/services` 全部 pending。

## 风险与残余不确定
- "池排队"是从浏览器外部可观测行为（请求未送达 + 服务空闲 + 旧连接正常 + HTTP/1.1 + 连接数）反推的最优解释；
  如需 100% 确证，可用 chrome://net-export 抓一次 net-log（需要用户配合，本轮未做）。
- 未修改任何文件；未运行测试（纯只读调研轮，无代码变更故无测试项）。
