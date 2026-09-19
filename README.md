# 掌上知库 · Knowledge Phone v0.1.2

零后端、零必需第三方插件的 SillyTavern 掌上知识终端。按当前聊天的世界日期与地点搜索本地知识包，不调用模型、不上传聊天，默认严格时间线。

## 安装

要求 SillyTavern **1.18.0 或更高版本**，以及支持 ES Modules、module Worker、IndexedDB、Shadow DOM 和 structuredClone 的浏览器。源码合约已核对 1.18.0；真实宿主安装验收尚待完成。

在 SillyTavern 的「扩展 → 安装扩展」中粘贴：

```text
https://github.com/louisSSR/st-knowledge-phone.git
```

仓库根目录包含 manifest.json、index.js、dist/ 和 packs/；成品已包含编译文件，使用者不需要安装 Node.js、Python、数据库或额外后端。

安装后打开右下角「掌上知库」，进入「知库 → 安装原创演示包」，即可搜索「扑克牌怎么玩」。也可以导入自己的 .pack.json 文件。

## 功能

- 手机浮层，桌面与移动端共用界面；午夜书房与彩色棋局主题。
- 离线知识包安装、校验和移除；正文点击后读取，作为纯文本展示。
- Worker 全文检索、时间／地点／类型过滤、相关联想、每页最多 12 条。
- 跟随剧情、自定义日期、现代模式；阅读、历史、收藏入口均遵守当前世界限制。
- 历史按聊天与世界线隔离，收藏按聊天保存；关闭手机终止搜索 Worker。

附带 17 条原创演示资料，其中包括六种纸牌玩法。商店、品牌、商品、赛事与历史事件是虚构演示数据；牌戏是简化教学规则。它们用于体验和验证功能，不是真实百科或竞技裁判规则。

另有真实来源的[中文百科首批资料包](packs/wikipedia-zh-starter/README.md)，从中文维基百科采集棋牌与基础科普纯文本摘录，保留来源与 CC BY-SA 4.0 归因。下载其中的 `.pack.json` 后逐个导入，将世界时间设为「现代模式 · 今天」即可查阅。最新摘录不会出现在 2008 年的严格世界线。

维护者可使用[批量采集与验收脚本](corpus/README.md)继续制作：

```sh
npm run corpus:collect -- --out corpus/output/batch-001
npm run corpus:verify -- corpus/output/batch-001
```

需要 Node.js 24+。脚本按明确清单限速下载、缓存、校验、去重和分包；普通使用者不需要运行它。

## 世界时间

跟随剧情模式只读取明确标注，例如：

```text
世界时间：2008-07-18
地点：日本 / 东京 / 涩谷
话题：纸牌、秋装
```

普通新消息增量处理；切换聊天时最多读取最近 8 条，每条最多 8000 字符，不保存整段聊天。自定义日期优先于剧情提取。编辑、删除或切换回复后会保守重算；窗口内没有明确日期时，可手动设置世界日期。

严格模式硬过滤未来 knownFrom、publishedAt 及有效期。带日期却缺 knownFrom 的资料不展示；世界日期未知时，仅显示没有日期限制的条目。已公开的未来活动预告可以出现，但包作者必须保证其中不包含未来结果。地点采用从大到小的路径；无地点条目视为通用。

## 开发与验证

成品使用者无需执行以下命令。修改 TypeScript 源码的开发者在本仓库目录运行：

```sh
npm install
npm run build
npm test
npm run preview
```

预览地址为 http://127.0.0.1:4179，使用三个模拟聊天，数据与真实酒馆分离。编译依赖由本仓库 package.json 声明；dist/ 必须提交，不能加入忽略列表。

浏览器验证是可选开发步骤，额外需要 Playwright 和 Chromium。在运行预览服务器后执行：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node scripts/browser-smoke.mjs
```

自动测试覆盖时间线、知识包校验、聊天隔离、异步切换和监听器清理。浏览器验证覆盖 IndexedDB、Worker、断网搜索、阅读、收藏和窄屏；它们不能代替真实酒馆安装、启停、生成事件和手机真机验收。

## 初版边界

- 单包上限 10 MB／5000 条，每聊天最多收藏 200 条。
- 同一浏览器、同一酒馆地址的多个 ST 账号共享 IndexedDB；本版没有账号级隔离。
- 聊天重命名不迁移历史；不同设备和浏览器不共享存储。
- 离线检索无需互联网；打开酒馆本身仍须能访问自己的 ST 服务。
- 无在线搜索、LLM、Embedding、BM25、推荐引擎、后端或多设备同步。
- 日期过滤依赖包作者正确标注 metadata；不提供包签名或事实真实性认证。

更多说明：[知识包与 Builder](packs/README.md)、[主题](themes/README.md)、[架构](docs/ARCHITECTURE.md)、[宿主合约](docs/HOST-CONTRACT.md)、[维护约束](CONTRIBUTING.md)。
