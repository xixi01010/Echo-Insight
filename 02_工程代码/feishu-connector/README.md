# feishu-connector

## 职责

飞书 Base 只读数据访问层，负责初始化官方 Node SDK 客户端、读取 Base / Table / Record，并输出标准化项目 JSON。

## 环境变量

参考 .env.example 配置 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_BASE_TOKEN。真实 Secret 不得写入代码或提交到版本库。

## 当前边界

仅实现读取能力，不包含创建、更新、删除或批量写入方法。自动测试通过注入假客户端运行，不访问真实飞书环境。
