# 传统技艺内容依据管理

文化短视频团队复原传统技艺时，会同时使用古籍摘录、官方纪录片、传承人口述和反复试做记录。本服务把每个**可核查主张**拆到具体依据片段，记录来源版本、使用许可、传承人确认、试做条件、编辑取舍和下游发布物；当来源被更正或被证明只适用于某个地域时，系统沿依据链计算受影响范围并驱动撤回 / 追加说明。

## 领域线索

```
来源 source
  └─ 来源版本 sourceVersion（只追加；current / superseded / retracted）
       ├─ 使用许可 license（internal / public，含有效期与吊销）
       └─ 依据片段 evidence（古籍 / 纪录片 / 口述 / 试做；supports / contradicts；适用地域）
             └─ 主张 claim（可核查表述 + 声称地域）
                  └─ 发布版本 release（public 公开 / draft 内部草稿；版本谱系只追加）
                       └─ 片段 snippet（乐观并发剪辑 clipVersion + 限制闸门）
                            └─ 发布物 usage（旧视频 / 字幕切片 / 品牌稿，落在 channel 上）

来源更正 correction（retract / qualify / erratum）
  → 影响面分析 impactAnalysis（按发布物去重，分级 withdraw / annotate / none）
  → 处置单 ticket（撤回 / 追加说明，期限 = 渠道回执时限）
  → 片段限制 restriction（block / annotation_required，立即生效）
  → 渠道回执 receipt（acknowledged / done，逾期标 overdue）
```

## 核心规则

- **证据不足只能进草稿**：公开发布要求至少一条支持性依据、引用的来源版本具备有效公开许可、口述依据经传承人确认、试做类依据关联成功的试做记录。任一不满足时 `publishClaim(target=public)` 被拒，`target=draft` 仍允许并标记 `internalOnly`。
- **矛盾不自动选边**：相反依据作为分歧（`conflicts`）永久保留，主张进入 `blocked`；必须由编辑作出 `qualify`（限定后采用）、`exclude_note`（备注保留、不采用相反说）或 `defer`（搁置）。裁定人、理由、时间全部留痕，裁定后分歧仍随溯源返回。
- **地域不得过度概括**：主张声称的每个地域都必须被依据覆盖；依据仅覆盖局部地域时，普遍适用（`*`）的主张判 `REGION_OVERREACH`。
- **更正影响分级**：
  - `withdraw`：公开表述失去支撑（撤回且无替代依据，或限定后不再成立）→ 处置单撤回，片段立即 `block`。
  - `annotate`：表述在限定范围内仍成立（地域收窄、刊误、撤回但有替代依据）→ 处置单要求追加说明，片段限制为 `annotation_required`。
  - `none`：仅存在于内部草稿或未公开，无需下游处置，但仍记入影响面供审计。
- **并行剪辑不得绕过限制**：剪辑基于检出时的 `clipVersion`，提交时做乐观并发校验（`CLIP_VERSION_CONFLICT`）；提交公开版本必须通过限制闸门——`block` 拒绝（`SNIPPET_BLOCKED`），`annotation_required` 未带注解拒绝（`ANNOTATION_REQUIRED`）。
- **回调重放幂等**：合作方发布回调以 `callbackId` 去重；同一更正只生成一套处置单，重放返回首次结果，不重复成单、不重复回执。
- **溯源可解释**：`explainRelease` 给出公开表述发布当时**为何被允许**（证据、许可、传承人确认、编辑裁定）、当前**是否仍成立**（套用全部更正后重评）、出现在哪些主张版本、以及每个下游渠道的处置单与是否在期限内回执。

## 接口

所有请求经 `src/api.js` 的 `handle(rawJson, service)` 处理，形如：

```json
{ "action": "publishClaim", "payload": { "claimId": "c1", "target": "public", "editorId": "ed-1" } }
```

领域错误返回 `{"error":{"code","message"}}`，不抛异常。

| 动作 | 说明 |
| --- | --- |
| `registerSource` / `addSourceVersion` / `grantLicense` / `revokeLicense` | 来源、只追加版本、公开/内部许可 |
| `recordTrial` | 反复试做记录（条件、结果、迭代次数） |
| `addEvidence` | 依据片段（类型、引用、支持/反对、适用地域） |
| `confirmByBearer` | 传承人对口述依据-主张的确认 |
| `proposeClaim` / `attachEvidence` / `detachEvidence` / `reevaluateClaim` | 主张与依据组装、重评估 |
| `resolveConflict` | 编辑对矛盾分歧的裁定与留痕 |
| `publishClaim` | 编入发布版本（public 走资格闸门，draft 内部保留） |
| `registerSnippet` / `checkoutSnippet` / `commitSnippet` / `imposeRestriction` | 片段、并行剪辑（乐观并发）、限制生效 |
| `registerChannel` / `registerUsage` | 下游渠道与实际发布物 |
| `recordCorrection` / `analyzeCorrectionImpact` | 来源更正与影响面分级 |
| `issueTickets` / `receiveCallback` / `acknowledgeTicket` / `markOverdue` | 处置单、幂等回调、渠道回执、逾期标记 |
| `explainRelease` / `correctionStatus` | 公开表述溯源、渠道回执总览 |

## 模块

- `src/policy.js`：纯领域策略（资格评估、地域覆盖、矛盾保留、更正分级、限制闸门），不依赖存储与时钟，可独立验证。
- `src/service.js`：应用服务，编排登记、评估、发布、剪辑、更正影响与回执流程。
- `src/store.js`：进程内多集合存储，读写均结构化克隆。
- `src/clock.js`：可替换业务时钟（测试中可推进时间以断言回执期限）。
- `src/errors.js`：带稳定错误码的领域错误。
- `src/api.js` / `src/cli.js`：进程内 JSON 边界与标准输入入口。
- `test/`：覆盖资格闸门、矛盾保留、地域过度概括、更正分级、并行剪辑、回调幂等、回执期限与溯源。

## 运行

```bash
npm test     # 运行测试
npm run build # 语法检查
printf '%s' '{"action":"health"}' | npm run cli --silent
```

项目只使用 Node.js 内置能力，运行期间不连接其他服务。
