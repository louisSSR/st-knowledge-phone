# 本地主题

主题由 `src/themes/manager.ts` 注册，只有受控样式 token，没有外部图片、字体、脚本或模型调用。

- `midnight`：午夜书房，默认墨紫、淡紫与薄金。
- `no-game-no-life`：彩色棋局，原创 CSS 棋盘与糖果配色；不含作品角色、标志或第三方素材。

添加主题时，在 `src/themes/` 新建符合 `PhoneTheme` 的模块，然后加入主题管理器注册表。搜索、上下文、数据包与阅读器核心无需修改。颜色与装饰背景只通过 Shadow DOM 中的 `--kp-*` token 生效。
