# 联网来源与接口约定 · v0.3

当前唯一在线来源是中文维基百科，固定接口为 `https://zh.wikipedia.org/w/api.php`。用户主动搜索或点击词条后才请求，不在启动、聊天事件或缓存列表中预取资料。没有 API Key、模型调用、后台代理或备用镜像。

## 官方依据

| 能力 | 一手文档 | 本扩展采用方式 |
| --- | --- | --- |
| 来源检索 | [MediaWiki API:Search](https://www.mediawiki.org/wiki/API:Search) | `action=query&list=search`，请求标题、来源片段和更新时间；最多取 12 条，与标题及来源重定向核对后合并排序。 |
| 匿名浏览器访问 | [MediaWiki API:Cross-site requests](https://www.mediawiki.org/wiki/API:Cross-site_requests) | `origin=*`、`credentials: omit`；只有查询词、打开的词条标题及 API 参数，省略聊天上下文和 referrer。 |
| 来源正文 | [MediaWiki API:Parsing wikitext](https://www.mediawiki.org/wiki/API:Parsing_wikitext) | `action=parse&page=...`，获取正文 HTML 与修订号，保留规范地址及 `oldid` 链接。 |
| 请求礼仪 | [Wikimedia Foundation API Usage Guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines) | 标识扩展的 `Api-User-Agent`，使用有限结果和用户触发的读取；HTTP 429/503 遵守 `Retry-After`，不后台无限重试。 |

这些文档说明官方接口能力，不能代替当前浏览器 CORS、实际网络及插件 UI 的运行验收。每次请求限时 8 秒；来源不可达或地区限制时给出失败提示，不擅自更换来源。具体环境的成功响应不能保证其他地区或后续时刻的可达性。

## 原文、版本与许可

搜索片段与正文分别处理；正文由来源解析接口返回，不用 TextExtracts 摘录或模型生成文字替代。来源内中文维基百科链接可继续查词，但不同词条分别取各自当前版本，不能声称属于同一历史快照。

`metadata.revision` 和修订链接对应此次获得的正文；只有搜索结果的非零修订号与正文修订号一致时，才保留搜索接口提供的 `source.updatedAt`，否则留空。`metadata.fetchedAt` 单独记录获取时间。这些时间均不能证明历史剧情可知性。联网科普及其缓存都明确属于未核验历史版本的现代资料。

正文标明中文维基百科与 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 许可，保留来源和修订链接。阅读器使用自己的排版，停用脚本和互动内容；在线图片、外部样式、音视频不自动下载。表格与可用 MathML 保留，原站链接供用户查看不能在阅读器呈现的内容。代码许可不改变来源资料版权。

## 缓存契约

只有成功读取的正文进入现有 IndexedDB，保留 HTML、标题及别名、修订、URL 和获取时间。最多 20 页 / 10 MiB，按成功获取顺序淘汰较旧页面；不会预抓取未读链接。超大页面和保存失败会明确说明未缓存，已成功读取的内容仍可查看。

缓存按同源浏览器数据库共享，历史与收藏按聊天存储。直接打开缓存无需联网；查询失败可返回实际匹配的缓存，读取失败可回退目标已有缓存，均明确显示缓存身份与获取时间。没有目标缓存时不会宣称可离线阅读。收藏不阻止缓存淘汰。

## 验收要求

自动测试、命令行连通、浏览器 CORS、插件原文导航与真实 SillyTavern 安装分别留证。至少检查：精确名词及重定向、不同主题结果、来源正文、术语链接、表格或公式、出处修订、断网后缓存阅读、未缓存目标失败以及请求中没有聊天上下文。

历史 v0.2 验收保持原状，仅证明当时离线实现。v0.3 的运行记录应绑定当前构建与目标宿主；不能因为官方文档存在或单次网络请求成功就宣称整个用户流程通过。
