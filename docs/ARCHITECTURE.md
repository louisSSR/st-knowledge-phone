# 掌上知库 v0.3 技术架构

掌上知库是独立的 SillyTavern 顶层浏览器 UI 扩展。用户已明确将默认方式改为「联网查成熟来源，读过的内容缓存本地；ZIM 可选」，此决定取代早期需求报告的默认离线方案。产品承担检索、来源导航和阅读，不自行编写百科，也不把摘要包装成完整资料库。

## 运行边界与依赖

- 最低宿主源码合约为 SillyTavern 1.18.0；只有 platform/sillytavern.ts 接触宿主 API。没有 Tavern Helper、MVU、后台服务、API Key、LLM 或 Embedding 依赖。
- 桌面手机浮层与移动窄屏共用 UI 和业务代码，Shadow DOM 隔离样式。浏览器运行编译后的原生 ES Modules；Node.js 和 TypeScript 仅用于开发构建。
- 默认在线 Provider 直连中文维基百科官方 Action API。可选 ZIM Provider 使用随附 OpenZIM javascript-libzim v0.95 的 Worker/WASM；高级 JSON Provider 使用本地搜索 Worker。第三方引擎出处与 GPL 说明见 vendor/libzim/NOTICE.md。
- 不在启动、聊天事件、关键词提取时预取网络资料。用户提交查询才检索，点击词条或原文内部链接才读取。无模型生成、提示词注入、宿主聊天写入或宿主设置写入。

依赖方向：

~~~text
main → platform/sillytavern + controller
controller → providers/online → 官方 Action API + library/online-cache → library/storage
controller → search/service → providers/zim → zim/engine → libzim Worker/WASM
                            → providers/local → search/worker
ui → PhoneController interface
ui/archive-reader → 已获取 HTML 的沙箱阅读与受控链接导航
~~~

src/core/types.ts 是公共接口权威。Settings.sourceMode 在 online 和 offline 间选择；旧设置缺失此字段时归一化为 online。离线剧情设置不会因切换在线科普而被改写。

## 在线检索与原文

OnlineProvider 仅访问 https://zh.wikipedia.org/w/api.php，使用匿名 CORS、credentials: omit 和 no-referrer。在线查询上下文由 controller 明确置空；请求不含聊天文本、聊天键、历史、日期或地点。传输内容限查询词、用户打开的词条标题和接口参数；点击从聊天中提取的关键词会提交这个查询词，提取动作本身不会发送。

一次搜索并行请求来源全文检索与标题/重定向核对，合并后最多展示 12 条。片段来自接口，精确标题或重定向优先；不将在线条目猜成游戏、商店等领域类型。查询词作有限长度及问句前后缀处理，不调用模型。

读取通过 action=parse 获得正文 HTML 与修订号，保留来源身份、规范地址、oldid 修订链接和许可。updatedAt 是来源提供的更新时间（可能缺失）；fetchedAt 是本机获取时间。二者均不充当历史剧情可知日期。

每个在线请求有 8 秒超时和取消机制；关闭、切换聊天、开始新查询时取消旧请求，controller 用请求代号与聊天代号丢弃迟到结果。响应大小预算为 12 MiB。HTTP 429/503 遵守 Retry-After，没有可用值时暂缓 60 秒，不后台无限重试。官方网络不可达时明确报告；不自动切换镜像、代理或付费服务。

## 已读缓存与存储

继续使用 IndexedDB st-knowledge-phone 的既有 values 仓，不新增数据库或 schema。online-cache.ts 将成功读取的 HTML、标题及别名、来源元数据、获取时间、修订号和地址存于 webcache:wikipedia-zh:v1。最多 20 页、10 MiB（序列化 UTF-8 字节预算），按成功获取顺序保留较新页面；仅打开缓存不刷新获取时间。

搜索结果片段不等于正文缓存，未点击条目和未打开链接不预抓取。缓存写入失败不取消已成功读取的页面，但提示本次未保存。缓存直接阅读无需网络；联网检索失败时，可用本地正文匹配已读页面，并明确标为缓存。联网读取失败时仅回退该目标已存在的缓存，不能编造缺失内容。

主题、来源模式、ZIM 连接记录和已读缓存在同一浏览器扩展数据库中共享；聊天上下文、历史与收藏按聊天键持久化，历史还按剧情日期、严格开关和地点分世界线。同源 ST 多账号目前不隔离此数据库。收藏保存条目引用，不保证缓存永久保留。原始聊天文本不持久化。

高级 JSON 包仍为 schemaVersion=1，数据分 manifest / indexes / entries / content 仓；安装使用原子事务，限 10 MB / 5000 条，正文按纯文本呈现。v0.1 原创演示和 105 篇摘录退出正式来源，不随更新自动删除已有用户数据。

## 可选离线检索与恢复

ZIM 原文件通过浏览器 File 按需读取，不复制整库进 IndexedDB；当前只连接一个。连接记录可持久化，File 授权不能跨页面刷新保留，刷新后需重新选择同一文件。源码和引擎通过并不证明任意大小资料库可用。

标题优先查询；找到标题匹配即返回，未找到才进入全文搜索。全文最多核对 30 个候选的标题、片段或原文查词，过滤中文拆字误命中，不声称穷尽整库。查询取消和超时终止当前工作线程，同时保留本页 File；后续请求重开同一个文件。初次连接超时由 controller 保留 File，并提供重试连接。显式移除或销毁实例会释放连接。

超时错误区分打开、计数、标题、全文和正文读取阶段。受控故障注入可以证明恢复机制，但不能据此认定用户此前自然超时的根因。99 MB 中文维基教科书样本也不能作为百科覆盖或 14 GB 整库性能证据。

## 时间线与阅读安全

默认在线科普明确属于当前资料，未核验剧情历史版本；用户可独立查阅，不套用角色的时间限制，也不会把资料注入聊天。在线收藏和缓存保留相同现代来源身份。离线模式继续执行日期、地点和类型约束；严格模式日期未知时，只展示无日期限制的合格资料。ZIM 日期暂取文件名月份的月末，有快照日期也不代表逐条历史可知性。

上下文只读取最近 8 条、每条最多 8000 字符，识别明确标注的日期、地点和关键词。日期优先级为自定义 > 现代本地日历日期 > 跟随剧情。事件发生时间 occurredAt 不替代 knownFrom / publishedAt；有效区间由 validFrom / validUntil 约束。

HTML 先在惰性 template 中解析、按标签和属性白名单清理，再放入无脚本沙箱 iframe。CSP 阻断页面自身的网络和代码执行，资源只经受控路径读取。在线图片、外部样式、音视频及互动组件不自动加载；保留可呈现的表格、列表和 MathML。内部维基词条链接交给官方 Provider，外部 HTTPS 链接由用户点击后打开。ZIM 的本地图片和样式有资源数量、并发及字节预算；关闭或换页释放对象 URL 与监听器。

## 验收与证据

自动验证应覆盖匿名请求参数、精确标题与重定向、原文读取、缓存淘汰、断网缓存、来源与获取时间分离、取消竞态、时间线和聊天隔离。浏览器还需验证 CORS、原文表格与公式、术语导航、缓存断网读取以及 ZIM 超时恢复；真实 SillyTavern 的安装版本、构建文件和运行结果另行核对。

历史 v0.2 的测试与实机证据只描述当时版本，不能自动升级为 v0.3 验收。实际 API 可达不保证任何地区或后续时刻可达；大型 ZIM、低端手机与所有条目格式未经实测前不作性能承诺。自动检查不能代替用户的 driver-accepted。

库路由回执：sillytavern-extension-dev，快照 2026-08-18；已读取 ST-A0 的目标/红线/验收、ST-D5 的扩展职责、ST-E5 的运行层边界。本文同步已授权的产品变更，不修改历史验收记录。
