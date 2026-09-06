# Echo Insight Backend

## 当前职责

Backend 是 Echo Insight 的 Node.js 业务协调层，当前负责：

- 飞书登录、会话状态与当前用户身份边界；
- 用户可访问项目的列表、创建、加入、详情、数据源和报告接口；
- 多来源项目上下文的读取、标准化与权限过滤；
- 确定性风险分析、AI 解释、项目报告与全局洞察编排；
- 本地 Demo、人工 Review 与显式授权的真实租户验证入口。

历史兼容接口 `/api/project-data`、`/api/project-analysis`、
`/api/project-report` 仍由主服务提供；V3 客户端主要使用认证、`/api/projects`
和 `/api/insights` 系列接口。

## 本地启动

先按仓库根目录的一键安装入口完成配置，再在 `02_工程代码/` 中运行：

```text
npm run start:backend
```

服务默认监听 `3000` 端口，可通过 `PORT` 调整。本地运行时数据写入
`ECHO_INSIGHT_RUNTIME_DIR` 指定目录；未指定时使用 `backend/.runtime/`，该目录不应提交。
在线访客模式会在该目录写入 `visitor-ai-accounts.json`：飞书应用内账号标识使用
HMAC 索引，Provider 与 API Key 使用 AES-256-GCM 加密。主密钥来自服务端变量
`ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY`，必须是 32 字节 Base64，且不得与
飞书 App Secret 共用。

## 安全边界

- 密钥和连接凭据只允许通过服务端环境变量或本地受限存储提供，不得进入前端、日志或仓库。
- 访客 AI 凭据按完整飞书应用身份隔离；退出登录保留加密记录，主动断开才删除，并清除该账号全部活跃 Session 的 Provider。
- 当前加密 JSON 只支持单后端实例，主密钥必须稳定保管；本版本不提供自动轮换或多实例一致性。无迁移轮换时，需在旧密钥有效时清空账号记录，停服后删除或重建空存储文件，再设置新密钥并让用户重新连接。
- 权限过滤必须先于风险分析和 AI 调用；模型只接收过滤后的最小必要上下文。
- 确定性规则不依赖 AI，外部模型失败时不得把旧结果或模拟结果伪装成成功。
- 默认产品路径不写入飞书；真实租户和外部模型验证必须由用户显式启动。
