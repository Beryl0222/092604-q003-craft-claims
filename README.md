# 传统技艺内容依据管理

为文化短视频团队管理传统技艺复原内容中的**可核查主张**与其依据。每个说法被拆到具体片段，
来源版本、使用许可、传承人确认、试做条件、编辑取舍、分歧与下游发布物全部留痕；来源更正时
自动计算影响范围并分级处置；合作方回调幂等，并行剪辑不能绕过已生效的限制。

## 领域模型

| 对象 | 含义 |
| --- | --- |
| 来源 Source | 古籍摘录、官方纪录片、传承人口述、团队试做记录；记录出处标识 `originKey`、版本、许可状态、地域范围 |
| 主张 Claim | 一条可核查的说法（工序类 / 其他），含地域适用范围（通说 / 地域型）、证据清单、传承人确认、试做、编辑取舍 |
| 分歧 Disagreement | 互相矛盾的来源立场，显式保留、可被发布"携带"（并列呈现），系统不自动选边 |
| 版本 Version | 主张每次状态或范围变化的不可变快照 |
| 片段 Clip | 剪辑产物，携带其表述口径（通说 / 地域型）；按主张加锁创建 |
| 发布物 Publication | 成片、字幕切片、品牌合作稿等下游物，由合作方发布回调登记 |
| 限制 Restriction | 来源更正在主张上生效的约束（撤回 / 地域说明 / 更正说明） |
| 处置单 Order | 每份已发布物针对每次更正的处置动作：撤回 `retract`、追加说明 `annotate`、无需处理 `none`，带回执期限 |
| 事件 Event | 合作方回调（发布 / 回执）的幂等登记 |

## 公开一条主张必须同时满足

1. 至少挂接一条依据；
2. 至少两处**不同出处**（`originKey` 不同；同一纪录片与其转述切片只算一处）且许可均为 `granted`；
3. 工序类主张有传承人确认（确认人、时间留痕）；
4. 工序类主张有至少一次在记录条件下复现成功的试做；
5. 地域范围不超出来源支撑：地方性来源不得概括成通说，地域型主张的每个地域都须被来源覆盖；
6. 开放中的分歧已被该发布决定显式"携带"（承诺并列呈现两种说法）；
7. 工序类主张留有编辑取舍说明。

不满足时发布被拒（错误码 `insufficient_evidence`，`reasons` 列出全部缺项），主张只能停留在内部草稿。

## 来源更正与处置分级

`correctSource` 支持三类更正：

- `withdraw`（撤回 / 吊销许可）→ 主张转为 `retracted`，所有已发布物**撤回**；
- `narrow_scope`（仅适用于特定地域）→
  - 通说性发布物：**追加说明**；
  - 限定在适用地域内的地域型发布物：**无需处理**；
  - 声称覆盖适用地域外的发布物：**撤回**；
- `correct_detail`（细节更正）→ 发布物**追加说明**；已就本次更正追加过说明的不再开单。

更正对**草稿主张**不产生对外处置单（它们本就不能公开）。限制生效后，新剪辑与重新发布都会被
门禁拦截：撤回不可复活；地域收窄后只接受适用地域内的地域型片段；细节更正后新片段必须声明
`incorporatesCorrections`。编辑可用 `reviseClaimScope` 把主张收窄到适用地域后重新发布。

处置单有期限（撤回默认 72 小时、追加说明 168 小时，可在构造服务时配置）；渠道通过
`recordOrderReceipt` 回执，系统区分 `pending / receipted / overdue`，并记录是否在期限内。

## 并发与幂等

- 同一主张上的剪辑、发布、更正经 `KeyLock` 按 `claim:<id>` 串行；多主张按固定顺序取锁。
  限制先生效时，排队中的并行剪辑在锁内复检并被拒绝，不能绕过。
- 发布回调与回执回调以 `eventId` 幂等：重放返回原结果，不重复生成处置单、不重复占用片段。
- 同一片段不能进入两个发布物（锁内复检 `publicationId`）。

## 接口动作（JSON，经 stdin/`handle` 调用）

`health`、`register`、`find`（基础脚手架兼容）；

`registerSource`、`correctSource`、`correctionImpact`；
`registerClaim`、`attachEvidence`、`confirmInheritor`、`recordTrial`、`setEditorialNote`、
`openDisagreement`、`addPosition`、`closeDisagreement`、`carryDisagreement`、
`reviseClaimScope`、`publishClaim`、`explainClaim`；
`createClip`、`releasePublication`、`recordOrderReceipt`、`explainPublication`。

可解释性：

- `explainClaim` 返回一条公开表述**为何被允许**：评估结论与缺项、依据的版本/许可/地域、
  分歧立场、出现过的版本、有效限制、决定痕迹（谁在何时发布或更正），以及各渠道处置单回执状态；
- `correctionImpact` 返回一次更正的受影响主张、三类处置清单与渠道回执总览（是否全部按期回执）；
- `explainPublication` 返回单份发布物的处置单与其是否全部结清。

错误统一为 `{"error":{"code",...}}`：`invalid_request / not_found / conflict /
insufficient_evidence / restriction_active / bad_request`。

## 目录

- `src/policy.js` 证据评估与处置分级（纯函数）
- `src/service.js` 领域服务（登记、发布、更正、处置、解释）
- `src/lock.js` 按键串行化互斥队列
- `src/store.js` 进程内实体存储
- `src/errors.js` 领域错误
- `src/api.js` 动作白名单分派（支持同步/异步动作）
- `src/cli.js` 标准输入入口
- `test/` 证据门禁、分歧、更正处置、幂等与并发测试

## 运行

```bash
npm test     # 测试
npm run build # 语法检查
printf '%s' '{"action":"health"}' | npm run cli --silent
```

项目只使用 Node.js 内置能力，运行期间不连接其他服务。
