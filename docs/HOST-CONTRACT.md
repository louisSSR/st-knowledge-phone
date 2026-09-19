# SillyTavern 宿主合约 · v0.1

本扩展是宿主顶层浏览器 UI 扩展，最低源码合约基线为 **SillyTavern 1.18.0**。没有 Tavern Helper、MVU、世界书插件或后端插件依赖。唯一接触宿主的模块为 `src/platform/sillytavern.ts`。本地预览必须明确选择预览 Adapter；宿主能力缺失会报错，不会自动换成模拟聊天。

## 来源与证据边界

源码核验基线：SillyTavern 1.18.0，commit `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`。以下能力均对照该固定提交；源码核验不代表真实宿主安装验收。

以下链接固定到同一提交，可复核相同实现。2026-09-20 已在该版本的真实宿主完成选定运行矩阵，见[实机验收记录](REAL-HOST-ACCEPTANCE.md)。未对 1.14–1.17 作兼容承诺，也没有把这一源码版本当作目前最新版本。

| 能力 | 固定源码 | 核对结果 |
| --- | --- | --- |
| 顶层 API | [public/script.js L292](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L292) | `globalThis.SillyTavern` 暴露 `libs`、`getContext`。核心上下文成员不能直接当作 `SillyTavern` 属性使用。 |
| 上下文 | [scripts/st-context.js L114](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/st-context.js#L114) | `getContext()` 返回当前 `chat`、`characters`、`characterId`、`groupId`、`getCurrentChatId`、`eventSource`、`eventTypes`、`chatMetadata` 等。每次读取重新获取上下文。 |
| 聊天身份 | [script.js L540](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L540) | `getCurrentChatId()` 为群组当前 `chat_id` 或当前角色的 `chat`；无聊天可为 `undefined`。单独聊天名称无法隔离不同角色。 |
| 常量 | [scripts/events.js](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/events.js) | 消费 `context.eventTypes`；例如 `CHAT_CHANGED` 的真实值为 `chat_id_changed`，不手写事件值。 |
| 订阅和清理 | [lib/eventemitter.js L44](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/lib/eventemitter.js#L44) / [L114](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/lib/eventemitter.js#L114) | `on(event, listener)` 返回 `void`；用同一函数引用调用 `removeListener(event, listener)`。不能套用 Tavern Helper 的 `{ stop() }`。 |
| 元数据 | [script.js L8918](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L8918) / [L9348](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L9348) | `updateChatMetadata(newValues, reset)` 替换元数据对象；`saveMetadata()` 调用完整 `saveChatConditional()`，不是独立只写某个 metadata 键的接口。v0.1 均不调用，数据保存在扩展自己的 IndexedDB。 |

## 实际消费的事件

| 常量 | 源码发出参数 | Adapter 行为 |
| --- | --- | --- |
| `CHAT_CHANGED` | 当前聊天 ID，可能 `undefined`；单聊 [L7641](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L7641)，群聊 [group-chats.js L318](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/group-chats.js#L318) | 重新读取身份和最近 8 条。 |
| `CHAT_LOADED` | `{ detail: { id: this_chid, character } }`，[L7610](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L7610) | 忽略 payload 中角色全文，只重新读取有限上下文；相同快照不重复通知。 |
| `CHAT_RENAMED` | `{ avatarId, groupId, oldFileName, newFileName }`，[L10656](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L10656) | 重新读取身份。 |
| `MESSAGE_SENT` | 消息索引，[L5851](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L5851) | 只读取该索引的当前 `mes`。 |
| `MESSAGE_RECEIVED` | 消息索引、生成类型；[L3740](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L3740)、[L6722](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L6722) | 新消息增量读取；已有楼层、continue、swipe 改为有限重算。 |
| `MESSAGE_UPDATED` | 消息索引，[L8371](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L8371) | 只监听编辑完成后的 UPDATED，避免与较早的 EDITED 双算。 |
| `MESSAGE_SWIPED` | 消息索引，[L10255](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L10255) | 最近 8 条重算，只读取当前 `mes`，不遍历备选 swipes。 |
| `MESSAGE_SWIPE_DELETED` | `{ messageId, swipeId, newSwipeId }`，[L9328](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L9328) | 有限重算；随后重复快照会被抑制。 |
| `MESSAGE_DELETED` | **删除后 chat.length**，[L1609](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L1609)、[L1672](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L1672) | 不将其误解为删除楼层；重新获取最近 8 条。 |
| `APP_READY` | 无参数；events.js 创建 emitter 时登记自动重放 | 补充初始化刷新。注册时可能立即回调。 |

## 读取、隔离与生命周期

- 快照和 reconcile 最多读取最近 8 条，每条最多 8000 个 UTF-16 字符；增量事件最多读取该消息一条。不会枚举整个聊天内容、swipes、worldbook、chatMetadata 或 extensionSettings。无可用聊天身份时消息列表为空。
- 单聊隔离键是 JSON 元组 `['sillytavern','character',avatar,chatId]`，群聊为 `['sillytavern','group',groupId,chatId]`。同名角色的 avatar 文件不同，因此同名聊天不会混库。字符数组位置和角色显示名均不作为长期主键。
- 未选择聊天使用 `st-knowledge-phone:lobby`，不把中性系统消息解析为剧情。无法取得 avatar 时同样安全退回无消息状态。
- 索引/角色 avatar 改名、聊天重命名后是新隔离键。v0.1 不自动迁移旧扩展记录；旧记录仍在原键下，避免推测身份后合并资料。
- **同一浏览器同源的 ST 多账号不隔离扩展存储。** 1.18.0 `getContext()` 未暴露账户 handle；`name1` 是可变的用户/人格显示名，不是登录账号。`accountStorage` 的 [公开方法](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/util/AccountStorage.js#L40) 不提供所有者身份，写入随机 namespace 会触发宿主设置保存，违反本版只读边界。宿主 [scripts/user.js L54](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/user.js#L54) 另有 `getCurrentUserHandle()`，但未挂到 context，当前 Adapter 不导入该宿主内部模块，也不调用 `/api/users/me`。不能宣称账号隔离通过；完整解决需另立显式宿主模块依赖或用户提供的账户 namespace。
- 事件不会生成内容、发消息或主动搜索。订阅缓存最多 8 条，用来抑制同一消息的重复事件；不持久化原始聊天文本。`MESSAGE_UPDATED` / swipe / delete 由 controller 用有限快照替换提取上下文，避免旧剧情条件残留。
- 最近 8 条之外的历史修订，不会扫描全历史以恢复遗失的条件。需要时可明确设置日期、地点；这是 v0.1 有限观察预算的边界。
- `subscribe()` 返回幂等取消函数；`dispose()` 取消所有订阅。没有轮询、定时器、宿主 DOM observer、HTTP 请求、prompt 注入或宿主写操作。扩展入口自己的 disable/clean 应调用 controller.dispose() 与 adapter.dispose()；enable 重新创建实例。手机关闭若仍需记录上下文，则只关闭 UI/Worker，保留轻量订阅。

### Enable 与 activate 并非同一调用

1.18.0 的 [enableExtension L474](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/extensions.js#L474) 先调用 `enable` hook，再保存启用状态；`reload=true` 随后刷新页面，`reload=false` 只标记需要刷新。它不直接调用 `activate`。页面重载后 [activateExtensions L568](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/extensions.js#L568) 才加载符合条件的扩展并调用 `activate`。若支持当前页面 disable 后不刷新即重新 enable，入口须额外导出 `onEnable(){ init(); }` 并声明 `hooks.enable`，同时保证 init 幂等。

库回执：route `sillytavern-api-reference`；快照 `2026-08-18`；读取 ST-A0（本地源码写入目标/红线/验收）、ST-C1（区分 iframe 与原生宿主 API）、wiki-phone（宿主单例抽屉边界）。API 最终权威是上述匹配版本源码。

本地自动证据：Adapter 和公共 types 的 TypeScript strict / noUnused 检查通过；`tests/host.test.mjs` 的内存宿主 fixture 验证了缺失宿主报错、20 条消息仅读尾 8 条且各截 8000 字符、不同角色同名聊天与群聊隔离、lobby 不读消息、新消息只读事件 floor 一次、重复事件抑制、编辑/swipe/删除重算、切换与重复加载去重、取消/释放后监听数量归零。fixture 导入构建后的 Adapter，不连接实际宿主。

真实 ST 1.18.0 已验证专用角色聊天切换、编辑、现有 swipe、删除、手机关闭后的上下文更新、禁用/重新启用、刷新与清理。真实模型生成/续写、群聊、多账号、手机真机和大语料性能仍未覆盖。实机检查通过也不自动设置用户的 `driver-accepted`。
