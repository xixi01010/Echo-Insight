# Echo Insight Frontend

## 当前职责

Frontend 是 Echo Insight 的 React Web App，当前包含：

- 飞书登录状态与受保护页面；
- 用户可访问项目的选择、创建、加入和项目空间；
- 项目健康度、风险中心、AI 解释、数据来源与设置；
- 跨项目全局洞察、偏好设置、响应式布局和明暗主题；
- 加载、空数据、部分失败与可重试状态的明确呈现。

## 本地运行

在 `02_工程代码/` 目录执行：

```text
npm run dev:frontend
```

开发服务器默认运行在 `http://localhost:5173`，并将 `/api` 代理到
`http://localhost:3000`。生产构建使用：

```text
npm run build:frontend
```

## 数据与交互边界

- 前端只消费 Backend 返回的安全 DTO，不保存或展示飞书密钥、模型 API Key 或访问令牌。
- 风险分数来自确定性规则；AI 文本用于解释，不作为事实来源或自动决策。
- 产品不会自动写回飞书，也不提供自动执行项目操作的聊天式代理。
- 本地缓存只用于可安全展示的产品状态；认证与权限判断始终以服务端为准。

界面使用 WEUI 与 GSAP。GSAP 不适用本项目 MIT License，具体边界见根目录
`THIRD_PARTY_NOTICES.md`；名称与 Logo 使用边界见 `TRADEMARKS.md`。
