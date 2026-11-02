# Cybernetics 工作协议 v0.2

目标-行动-测量-校准的迭代回路，构建在 DSH 的 `dsh-workflow` 编排与 `dsh-goal` 持久目标之上。

## v0.2 变化：goal 回到 session

- **goal 是 session agent 的思考产物**，通过 dsh-goal 服务持久化（create/edit 是模型动词）。
  用户不精确编辑任何目标文件——**用户通过对话校准 agent，agent 修订 goal**。
- 同一工作区的每个 session 可有自己的 goal（dsh-goal 每 session 单槽）。
- 未来多 goal：按 super-agent 模式（DeepSeek Harness《Super-agent 设计探索》，2026-11-01，
  开源原型 dsh-superagent-prototype），super agent session 持有各 sub agent 的 goal 并据此调度；
  每条 sub goal 下沉到 sub session 各自的 dsh-goal。v0.2 先做单 session 单 goal。

## 角色

| 角色 | 实现 | 职责 |
|---|---|---|
| Session Agent | 调用方 | 持有 goal（模型动词维护），隐式触发回路，向用户转述 |
| Controller | `src/controller.ts` | 轮间状态机：推进/暂停/终止回路，维护轮审计日志 |
| Task Agent | workflow `agent()` | 面向当轮子目标执行，产出结构化交付报告 |
| Verify Agent | workflow `agent()` | 把总目标拆成可判定方面逐条验收，产出结构化 verdict |
| Triage Agent | workflow `agent()` | 对后续线索四分拣：auto / defer / reject / human |
| 用户 | 外环 | 对话校准（goal 修订由 session agent 执行）、裁定 human 类目、确认完成 |

## 隐式触发

插件注入 system prompt 段（`implicitTrigger: false` 可关）：实质性任务先建 session goal；
goal 存续期间模型应**不等显式要求**调用 `cybernetics` 推进回路。无 goal 时调用工具会报错并提示先建 goal。

## 结构化判定

- Task 报告：`{summary, done, artifacts, evidence, nextStepThoughts}`
- Verdict：`{met, criteria:[{criterion,pass,evidence}], gaps, goalItselfQuestionable}` —
  `goalItselfQuestionable=true` 时回路禁止自动迭代，回对话重新校准（session agent 修订 goal）。
- Triage：`{auto, defer, reject, human:[{step,rationale,question}]}` — 方向性改动宁可多给 human。

## 回路终止条件

1. `met=true` → 报告完成，**等用户确认**；controller 不自行宣告、不代改 goal phase。
2. `goalItselfQuestionable=true` 或存在 human 类目 → 暂停，回对话。
3. 连续迭代上限（默认 3 轮/子目标，总轮数由 dsh-goal round cap 兜底）→ 暂停并汇报。

## 角色化 sub agent

Config `roles` 表把角色名映射到 `{provider, model}` 覆盖，round 脚本按 `role` 参数取用：
`default`/`verify`/`triage` 固定槽位 + 任意命名任务角色（如 `frontend`/`backend`/`writer`）。

```yaml
- id: dsh-cybernetics
  config:
    roles:
      default: { provider: zai-coding-cn, model: glm-5.3 }
      verify:  { provider: zai-coding-cn, model: glm-5.3 }
      frontend: { provider: zai-coding-cn, model: glm-5.3 }
      writer:  { provider: zai-coding-cn, model: glm-5-turbo }
```

## 审计与可视化

- 每轮结构化结果落 `<workspace>/.cybernetics/round-<N>.json`（追加式审计日志）。
- goal 状态由 dsh-goal 的 session projection（`goal` 投影）承载，客户端「目标 / Goal」页签
  （`lib/client.js`，conversation.view slot）实时读取渲染：objective 文本 + phase + rounds。
  v0.2 为纯文本渲染；后续演进：任务分解、状态跟踪、verdict 历史可视化（参照 dsh-context 范式）。
