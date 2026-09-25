# 传统技艺内容依据管理

本项目提供传统技艺内容依据管理的服务端基础，现有代码包含基础登记对象、可替换时钟、进程内存储、健康检查、JSON 请求边界和命令行入口。模块之间保持明确边界，便于继续扩展领域规则和持久化行为。

## 目录

- `src/store.js` 保存基础登记记录。
- `src/service.js` 组织登记与查询行为。
- `src/api.js` 处理进程内 JSON 请求。
- `src/cli.js` 提供标准输入入口。
- `test/` 覆盖当前已有行为。

## 运行

运行测试：`npm test`

检查构建：`npm run build`

本地冒烟：`printf '%s' '{"action":"health"}' | npm run cli --silent`

项目只使用 Node.js 内置能力，运行期间不连接其他服务。
