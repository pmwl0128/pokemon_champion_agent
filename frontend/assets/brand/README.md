# Brand mark

`logo.svg` 是站点标识的唯一源文件（原创，随 UI bundle 发布）：蓝紫渐变圆角底板上一枚“戴王冠的球”——下半是球身，上半换成冠军王冠，中间保留腰带缝与中心按钮。顶栏、使用率卡的站点标识和浏览器标签页图标都引用它。

另外两个 PNG 由它栅格化而来，不要手工编辑：

| 文件 | 用途 | 生成方式 |
|---|---|---|
| `favicon-32.png` | 不支持 SVG 图标的浏览器的标签页/收藏栏回退 | `logo.svg` 按 32×32 绘制到 canvas，透明圆角 |
| `apple-touch-icon.png` | iOS 添加到主屏 | `logo.svg` 改为 `rx="0"`（满版底板，由系统自行裁圆角）后按 180×180 绘制 |

`frontend/web/index.html` 先声明 PNG（`sizes="32x32"`）再声明 SVG，支持 SVG 的浏览器会选矢量版本。改动 `logo.svg` 后需按上表重新生成两个 PNG。
