# 批量采集与验收

这是维护者在电脑上运行的资料制作工具。酒馆端只导入生成的 `.pack.json`，搜索和阅读时不联网、不调用模型。默认清单包含从 20 篇候选中筛出的 13 篇中文百科摘录；原候选保留在 `wikipedia-zh-initial-candidates.json`，其中 7 篇暂缓收录，原因见[内容抽查报告](../packs/wikipedia-zh-starter/CONTENT-REVIEW.md)。可在 `wikipedia-zh-starter.json` 的 `articles` 中调整，每批最多 100 篇，不跟随网页链接递归抓取。

## 运行

需要 Node.js 24 或更新版本。在仓库根目录运行：

```sh
npm run corpus:collect -- --out corpus/output/batch-001
npm run corpus:verify -- corpus/output/batch-001
```

仓库已包含 `dist/`，无需为采集安装额外依赖。修改过 TypeScript 时先构建。输出目录须为新批次目录；不要覆盖历史报告。只有 `report.json` 和 `acceptance.json` 均为 `passed` 才进入内容抽查和浏览器验收。

如当前网络无法直接连接维基百科，可使用你已有的 HTTP 代理。Node.js 24 的代理示例（PowerShell，端口换为自己的代理）：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:你的端口'
$env:NODE_USE_ENV_PROXY = '1'
npm run corpus:collect -- --out corpus/output/batch-001
```

这只影响当前终端进程，不修改系统代理。工具不要求账号、Cookie、API Key 或聊天内容。

## 缓存、更新与失败

- 默认读取 `corpus/.cache/wikipedia-zh/` 的原始响应缓存，并沿用原采集日期。缓存和临时输出不提交到 Git。
- 中断后用新的 `--out` 目录重跑，已经成功的条目不会再次下载。`--refresh` 显式重新采集；`--offline` 仅从缓存重建，缺缓存就失败。
- 请求间隔至少 1.1 秒，每次超时 30 秒，最多 3 次尝试。识别 HTTP 429/5xx 和 HTTP 200 的 `maxlag` 错误，遵守 `Retry-After`；等待要求超过 60 秒或重试耗尽仍被限流时停止整批，不改抓下一篇来绕过等待。
- 单次响应上限 2 MiB，单篇 200–250000 字符。缺失页、消歧义页、章节重定向、API 警告、坏缓存、重复页面内容冲突、未渲染的 TeX 公式均列为失败。表格缺失和上标扁平化仍须抽查；机器通过不等于内容通过。
- 任一条目失败，本批不输出知识包。成功内容留在缓存，失败原因保存在报告中；修正清单后用新目录续跑。站点许可检查不通过时会在抓正文前直接停止。
- 普通重定向按 pageid 合并，保留请求标题作为搜索别名。不同页面正文完全相同会失败，要求人工检查，避免误合并不同来源。

## 输出和来源

每段默认最多 6000 个字符，在段落处优先切分，按顺序拼接能恢复完整的规范化摘录。每包默认不超过 512 KiB／200 段，含预建全文索引；仍遵守扩展的 10 MiB／5000 条硬限制。

每条保留标准条目页、作者历史、CC BY-SA 4.0 许可及链接、处理说明、采集 UTC 时间和正文校验和。正文和索引采用同样的内容许可；本许可说明不改变仓库其他源码或原创演示包的许可。

默认条目类型均为 `article`（百科摘录），不当成完整的游戏规则教程。明确审查过完整规则后才适合改为 `game_rule`。

采集使用 Wikimedia TextExtracts，产物是**纯文本摘录**。图片、部分表格、模板、公式与非文本归因信息可能省略，不能当成完整网页归档或竞技裁判规则。发布者还应抽查原页面中的额外归因要求。中文页面原有简繁混排保留，请求标题和配置别名用于辅助搜索。

`observedRevisionId/At` 是同次请求中观测到的修订信息，不保证摘录绑定该修订，不伪造永久版本链接。`source.updatedAt` 和 `knownFrom` 使用采集日期；2008 年的故事不能看到今天采集的最新百科。需要历史知识时，应另做经过历史版本审查的资料包，不能把 `knownFrom` 改成事件发生日期。

## 验收分层

1. `corpus:verify` 独立检查文件 hash、包结构、来源、许可、元数据、各段重组的完整性、时间过滤和真实搜索函数；错误返回非零退出码并写 `acceptance.json`。
2. 维护者抽查正文与源页面：至少覆盖棋牌、科普和长文分段，检查内容可读性和额外归因。技术校验不是百科事实真实性证明。
3. 启动本仓库预览后，运行 `node scripts/corpus-browser-smoke.mjs 输出目录`。需要 Playwright/Chromium；环境变量与主 README 的浏览器测试相同。实际导入所有包、搜索全部原标题、阅读来源、2008 隔离、刷新持久化、断网查询和 320px 布局。
4. 真实 SillyTavern 安装和手机真机验收仍是独立步骤。

普通用户在「掌上知库 → 知库 → 导入资料包」逐个选择 `.pack.json`。将时间设为「现代模式 · 今天」可搜索首批资料。更新同 ID 包时，当前版本须先卸载旧包，再导入新包。

本工具解决小批量资料制作，不代表当前检索器适合整个维基百科或 GB 级语料。

## 官方依据

- [TextExtracts 摘录范围](https://www.mediawiki.org/wiki/Extension:TextExtracts)
- [Action API Query 与版本限制](https://www.mediawiki.org/wiki/API:Query)
- [API 礼仪](https://www.mediawiki.org/wiki/API:Etiquette)、[maxlag](https://www.mediawiki.org/wiki/Manual:Maxlag_parameter)
- [内容复用](https://www.mediawiki.org/wiki/Wikimedia_APIs/Content_reuse)、[使用条款第 7 节](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use/en#7._Licensing_of_Content)
- [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
