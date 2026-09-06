# Echo Insight Tests

## 当前覆盖

测试覆盖连接器与分页读取、权限过滤、用户凭据生命周期、认证与项目路由、
多来源项目上下文、确定性风险规则、AI 输出契约与标准化、项目和全局洞察、
前端安全 DTO 与关键状态逻辑，以及本地安装脚本的预检行为。

## 运行

在 `02_工程代码/` 目录执行：

```text
npm test
npm run typecheck
```

`npm test` 会递归枚举 `02_工程代码/` 内的 `.test.ts` 与 `.test.tsx` 文件，并排除
`node_modules`、`dist`、`coverage` 与 `.git`；新增 TypeScript 测试不需要手工维护文件清单。
普通测试默认使用假客户端、本地临时数据和本地 HTTP 服务，不应读取
真实 `.env`、调用真实飞书或模型 API，也不应写入远端数据。

`review:real-tenant`、`ai-model-test` 和 `ai-runtime-smoke:deepseek` 属于显式的人工或
外部集成验证，不是普通离线测试；运行它们前必须单独确认凭据、数据范围和授权。
`ai-model-test` 使用 `tests/fixtures/ai-model/` 内的公开合成样本，结果只写入已忽略的
`.runtime/ai-model-test-results/`，不会依赖或重建仓库外的私有资源目录。
