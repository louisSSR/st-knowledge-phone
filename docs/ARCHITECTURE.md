# 掌上知库 v0.1 技术架构与冻结范围

依据用户提供的《SillyTavern 通用小手机知识终端》v0.1 报告第 53 节，实现独立浏览器 UI 扩展。真实酒馆安装与人工验收尚待完成。没有第三方运行依赖。此目录独立于原项目的世界书脚本与打包流程。

## 已决定的初版边界

- 暂名「掌上知库 / Knowledge Phone」，默认简洁的午夜紫主题；另提供 `themes/no-game-no-life` 配色主题，无外部角色图片、字体、音乐。
- 桌面右侧手机浮层，移动端全屏单栏，底部五个入口；同一 UI 与业务代码。Shadow DOM 隔离样式。
- 随附原创演示包（规则、地点、时间线示例），明确示范数据性质；不冒充大百科。允许第三方 JSON 数据包，无脚本、HTML 执行或远程资源加载。
- 包格式 `.pack.json`，schemaVersion=1，含 manifest、metadata(entries)、全文 index、content 正文分块；IndexedDB 按 manifest / indexes / entries / content 分仓。安装为原子事务，覆盖同 ID 包前应由界面明确确认或拒绝。v0.1 限制单包 10 MB / 5000 条，远低于未来数 GB 目标。
- 搜索在 Dedicated Web Worker 内执行。遵守报告第 33 节硬约束，提前实现原阶段二列出的 Worker，但不顺带引入向量、BM25 或推荐引擎。
- 所有结果、联想、阅读与收藏入口都复核时间和地点。严格模式 worldDate 未识别时仅展示无时间限制的资料；带日期条目必须明确 knownFrom。不以排名替代硬过滤。
- `occurredAt` 是事件时间，不能直接当成知识可知时间。knownFrom 与 publishedAt 限定可知时间，validFrom/validUntil 限定状态有效区间。
- 日期优先级：自定义日期 > 现代模式的浏览器本地日历日期 > 跟随剧情提取。剧情只识别明确标注的「世界时间/剧情日期/日期」与「地点/位置」，不猜测泛指年份；每次最多处理 8 条、每条 8000 字符。
- ContextState、设置、历史、收藏持久化到本浏览器 IndexedDB。聊天隔离键来自 Adapter；历史再按日期、严格开关、地点组成的世界线隔离。没有整段聊天持久化和上传；不写宿主聊天正文。
- 启动只创建入口。打开后加载 UI / IndexedDB manifest；搜索才启动 Worker 和加载索引；点击结果才读取正文；关闭终止 Worker，保留轻量事件更新上下文。
- Provider 接收完整 SearchRequest（包含 SearchContext），通过构造器注册；v0.1 只注册本地 Provider。无后端、网络搜索、LLM、Embedding、付费调用。

## 依赖方向

`main → platform/sillytavern + controller → storage + search/service → providers/local → search/worker`

`ui → PhoneController interface`；`themes → 主题 token`；`context/extractor → 纯函数`。

唯一允许接触 SillyTavern 的模块是 `platform/sillytavern.ts`。知识正文只当纯文本渲染。源码使用 TypeScript，编译为原生 ES Modules；浏览器不需要 Node.js。

接口唯一权威为 `src/core/types.ts`。Worker 通讯为带 request id 的 search 消息与 success/error 响应；陈旧结果由 controller 的请求代号丢弃。DB 升级集中在 storage 的 onupgradeneeded；所有 schemaVersion 非 1 的包拒绝，未来用显式迁移器。

## 验收

自动测试覆盖时间线未来过滤、缺失日期、地点/类型、聊天隔离、上下文增量、包校验与生命周期；浏览器验证包安装、搜索、阅读、收藏、刷新持久化、卸载、窄屏、关闭和断网。实际宿主版本与 API 源码证据单独记录。未进行真实安装前不声称真实酒馆验收通过。

预算：首次入口 JS gzip < 100 KB；首页节点 < 150；每页最多 12 条；关闭无轮询；所有全文检索在 Worker。大型数据集与低端真机延迟没有实测前不承诺 < 200 ms。

知识库路由回执：`sillytavern-extension-dev`，快照 `2026-08-18`；已读取 ST-A0、ST-D5 的扩展合约与生命周期章节、ST-E5 的运行层边界。Shadow DOM / Workers 为平台原语选择，候选 design:d4-lit-shadow、ledger:B5-Worker-x03 未作为库依赖采用。
