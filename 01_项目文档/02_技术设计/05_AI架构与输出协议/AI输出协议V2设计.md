# AI 输出协议 V2 设计

> 当前治理说明（2026-09-05）：本文仍是 V3 Frozen 使用的 AI 输出边界设计。“V2”表示协议迭代版本，不表示产品仍处于 V2；具体实现和验收结果以 V3 冻结验收记录为准。

## 1. 当前 V1 输出问题分析

Qwen 与 DeepSeek 的真实测试显示，模型能够识别输入中的风险信号，但倾向于自行输出 `healthScore`、`healthStatus` 和 `riskLevel`，并将这些字段与风险解释混合返回。

V1 的主要问题：

- 健康度和风险等级可能被模型重新计算，导致与规则结果不一致。
- 模型可能把项目状态、任务状态等源数据事实重新表述为“判断结果”。
- Backend 难以区分规则计算结果与 AI 派生解释。
- 不同模型输出字段不稳定，影响结果校验和前端展示。

V2 将“规则事实”和“AI 派生内容”分离：规则引擎负责健康度、风险等级和项目状态事实；AI 只负责解释、影响分析、建议行动和数据限制说明。

## 2. AI 在 Echo Insight 中的职责边界

### AI 负责

- 根据已授权、已结构化的风险信号解释风险原因。
- 说明风险可能影响的任务、时间节点或依赖关系。
- 生成供项目负责人参考的建议行动。
- 指出输入数据不足、证据不足或无法判断的限制。
- 保持输出可追溯，引用输入中的证据标识。

### AI 不负责

- 计算或修改 `healthScore`。
- 计算、升级或降低 `riskLevel`。
- 判定或改写项目、任务的状态事实。
- 评价员工能力、态度或绩效。
- 修改任务、负责人、Deadline、权限或任何飞书源数据。
- 替代项目负责人作出最终决策。

## 3. V2 输入结构设计

Backend 在权限过滤和规则计算完成后，向 AI Service 发送最小必要结构。输入可以包含规则结果供 AI 解释，但这些字段属于只读上下文，AI 不得在输出中复制为新的项目判断。

```json
{
  "projectContext": {
    "projectId": "project-id",
    "projectName": "Echo Insight MVP",
    "healthScore": 76,
    "healthStatus": "needs-attention",
    "riskLevel": "L3",
    "sensitivityMode": "robust"
  },
  "tasks": [
    {
      "taskId": "task-id",
      "taskName": "完成数据读取",
      "owner": "成员甲",
      "status": "进行中",
      "deadline": "2026-08-30",
      "dependencyIds": [],
      "description": "完成 Base、Table、Record 读取链路"
    }
  ],
  "ruleSignals": [
    {
      "signalId": "signal-1",
      "code": "DEADLINE_NEAR",
      "level": "L3",
      "taskId": "task-id",
      "evidence": "任务仍在进行中且截止日期临近"
    }
  ],
  "metadata": {
    "source": "feishu-base",
    "accessMode": "read-only",
    "authorizedProjectIds": ["project-id"],
    "generatedAt": "2026-08-22T00:00:00.000Z"
  }
}
```

输入约束：

- `projectContext.healthScore`、`projectContext.healthStatus`、`projectContext.riskLevel` 和任务 `status` 均是规则或源数据事实，只读传入。
- `ruleSignals.level` 由规则引擎确定，AI 只能引用其证据，不能重新分级。
- `authorizedProjectIds` 用于审计和权限边界，不允许模型据此推断未提供的项目。
- 不发送 Secret、完整 Base、无关字段或未经过权限过滤的数据。

## 4. V2 输出 JSON Schema

V2 输出只允许返回 AI 派生内容，不包含 `healthScore`、`healthStatus`、`riskLevel` 或项目状态事实。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "EchoInsightAIOutputV2",
  "type": "object",
  "additionalProperties": false,
  "required": ["risks", "limitations"],
  "properties": {
    "risks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "evidenceRefs", "reason", "impact", "suggestedActions"],
        "properties": {
          "id": {"type": "string", "minLength": 1},
          "title": {"type": "string", "minLength": 1},
          "evidenceRefs": {
            "type": "array",
            "items": {"type": "string", "minLength": 1}
          },
          "reason": {"type": "string"},
          "impact": {"type": "string"},
          "suggestedActions": {
            "type": "array",
            "items": {"type": "string"}
          }
        }
      }
    },
    "limitations": {
      "type": "array",
      "items": {"type": "string"}
    }
  }
}
```

V2 输出示例：

```json
{
  "risks": [
    {
      "id": "risk-1",
      "title": "截止日期临近",
      "evidenceRefs": ["signal-1", "task-id"],
      "reason": "任务仍在进行中，且输入信号显示截止日期临近。",
      "impact": "可能压缩后续验证和交付准备时间。",
      "suggestedActions": ["确认剩余工作量并安排下一次检查"]
    }
  ],
  "limitations": []
}
```

## 5. 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `risks` | array | AI 对规则信号进行解释后的风险条目，可为空。 |
| `risks[].id` | string | 本次 AI 输出中的风险条目标识，不代表规则风险等级。 |
| `risks[].title` | string | 风险主题的简短说明。 |
| `risks[].evidenceRefs` | string[] | 指向输入中的 `signalId`、`taskId` 或其他证据标识。 |
| `risks[].reason` | string | 基于输入证据的风险原因解释。 |
| `risks[].impact` | string | 对任务、时间节点或依赖关系的可能影响说明。 |
| `risks[].suggestedActions` | string[] | 供负责人参考的行动建议，不是自动执行命令。 |
| `limitations` | string[] | 数据不足、证据不足或模型无法判断时的限制说明。 |

V2 不定义健康分数、健康状态、风险等级或任务状态字段；这些字段继续由规则结果和源数据提供。

## 6. AI 允许行为

- 使用输入中的规则信号和证据生成自然语言解释。
- 将一个或多个证据标识关联到风险原因和影响说明。
- 在证据充分时生成低风险、可人工确认的建议行动。
- 在无法判断时返回 `limitations`，或省略无法证实的风险条目。
- 输出空的 `risks` 数组，表示没有可解释的风险内容。

## 7. AI 禁止行为

- 输出或改写 `healthScore`、`healthStatus`、`riskLevel`。
- 输出未经规则或源数据确认的项目、任务状态事实。
- 编造任务、负责人、截止日期、依赖关系或其他项目事实。
- 跨项目推断或扩大授权数据可见范围。
- 对员工能力、态度、绩效作出判断。
- 生成自动修改、删除、通知、授权或执行项目操作的指令。
- 在 JSON 契约之外输出自由文本、Markdown 或隐藏字段。

## 8. 与 Backend / AI Service 的关系

```text
Feishu Connector（只读）
        ↓
Backend：权限过滤 + 数据整理 + 规则计算
        ↓
AI Service：接收 V2 输入 + 调用模型 + 校验 V2 输出
        ↓
Backend：合并规则结果与 AI 派生内容
        ↓
Frontend：展示健康度、规则风险和 AI 解释
```

### Backend

- 读取并过滤用户授权范围内的飞书数据。
- 计算并保留健康度、风险等级和项目状态事实。
- 构造 V2 输入。
- 将 AI 输出作为派生解释合并到展示模型，不允许其覆盖规则结果。

### AI Service

- 只处理结构化 V2 输入。
- 通过模型适配器生成 V2 输出。
- 校验 JSON Schema、证据引用和只读边界。
- 对不合规输出执行拒绝或降级，不把自由文本直接交给前端。

AI Service 不读取飞书、不管理飞书 Token、不修改项目数据。

## 9. 后续模型接入约束

- 所有模型供应商必须遵循同一 V2 输入和输出契约。
- Model Adapter 只负责供应商请求格式、认证和响应解析，不改变协议语义。
- 接入新模型时必须验证：禁止字段不出现、证据引用可追溯、JSON Schema 可通过、限制说明可保留。
- 模型超时、限流、认证失败或输出解析失败时，保留 Backend 的规则结果，不伪造 AI 派生内容。
- 任何模型输出不得覆盖规则计算的健康度、风险等级或源数据状态。
- V2 协议变更必须更新版本号、测试样本和模型测试记录；本文件不代表已修改运行时代码。

本文件仅为协议设计归档，不修改现有 Prompt、测试数据、AI Service 实现或模型接入逻辑。
