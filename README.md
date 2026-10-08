# 极光导航 (Aurora Portal)

> 高颜值个人导航门户，支持自定义编辑网站/分类，内置互联网共享粘贴板。

![预览](https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=https://aurora-portal.workers.dev)

## ✨ 功能特性

- **🌐 网址导航矩阵** - 精美卡片网格，毛玻璃主题，分类过滤
- **✏️ 可视化编辑** - 网站增删改，自动读取网页标题与图标，分类自维护，JSON 备份恢复
- **🔍 多引擎聚合搜索** - 站内实时过滤 + 百度/谷歌/必应/B站/GitHub/知乎
- **📋 共享粘贴板** - 通过同一云端地址轮询同步，Markdown 渲染，一键复制，悬浮抽屉
- **☁️ Cloudflare Worker** - 免费全球 CDN 部署，KV 边缘持久化

---

## 🚀 快速开始

### 本机开发 (零依赖)

```bash
node server.js
```

浏览器访问: `http://localhost:3000`

跨设备共享请部署到可通过互联网访问的 HTTPS 地址，随后在各设备打开同一地址。Cloudflare Worker 的部署步骤如下。

---

## ☁️ 部署到 Cloudflare Worker

### 1. 安装 Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. 创建 KV 命名空间

```bash
# 生产环境
wrangler kv namespace create "AURORA_KV"

# 预览/开发环境
wrangler kv namespace create "AURORA_KV" --preview
```

将输出的 `id` 和 `preview_id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "AURORA_KV"
id = "你的KV ID"
preview_id = "你的预览KV ID"
```

### 3. 构建并部署

```bash
# 一键构建 + 部署
npm run deploy

# 或者分步执行
npm run build      # 生成 worker-dist.js
wrangler deploy    # 推送至 Cloudflare
```

### 4. 本地调试 Worker

```bash
npm run cf:dev
```

---

## 📋 共享粘贴板使用说明

### 手机跨设备传文字

1. 部署 Cloudflare Worker，并绑定 `AURORA_KV`。
2. 手机和电脑通过互联网打开**同一部署的 HTTPS 地址**。
3. 在粘贴板页输入文字，保存成功后，其他设备通过轮询取得更新。

粘贴板只通过 `/api/clipboard` 云端接口共享，不再使用浏览器本地存储、跨标签页广播或局域网推送。断网或云端存储不可用时会显示失败状态，不会将本地内容当作同步成功。

Cloudflare KV 是最终一致存储，跨地区可能延迟约 60 秒或更久；HTTP 响应禁止缓存，但不能消除 KV 的传播延迟。接口返回保存时间，页面忽略比已知版本更旧的结果。旧版 KV 粘贴板文本会继续读取，后续保存使用单独的版本化数据键。

---

## 📂 项目结构

```
protal/
├── public/
│   ├── index.html         # 主页面 HTML
│   ├── css/style.css      # 毛玻璃主题样式
│   └── js/app.js          # 前端逻辑 (搜索/编辑/云端粘贴板轮询)
├── data/
│   ├── default-sites.json # 预置导航站点数据
│   ├── sites.json         # 用户自定义数据 (自动生成)
│   └── clipboard.txt      # 粘贴板内容 (自动生成)
├── server.js              # 本地 Node.js 服务器 (零依赖)
├── worker.js              # Cloudflare Worker 模板
├── worker-dist.js         # CF Worker 构建产物 (build 后生成)
├── build.js               # CF Worker 构建脚本
├── wrangler.toml          # Wrangler 部署配置
└── package.json
```

---

## 🛠️ 自定义配置

### 修改站点标题/简介

双击页面上的**标题**或**简介**文字即可直接编辑，修改会自动保存。

### 添加/编辑网站

- 点击顶部**"添加网站"**按钮
- 或悬停在现有卡片上，点击 **✎ 编辑** 图标
- 输入网址后自动读取目标网页的 `<title>` 与 `rel="icon"`，支持相对图标路径和重定向。手动填写的名称与图标会保留，也可点击**获取名称和图标**重试。
- 自动获取仅访问公开 HTTP/HTTPS 网站，最长等待约 10 秒。内网、需要登录或拒绝抓取的网站可手动填写；无法获取时使用域名及 `/favicon.ico` 作为默认值。
- 网站标签（分类）可重命名：点击分类标题右侧的**编辑标签**，或在网站编辑窗口中点击分类选择框旁的 **✎**。修改会同步更新该标签下的全部网站，空名称和重复名称不会保存。

### 备份与恢复

顶部**备份** → **导出网址备份 (JSON)** / **导入网址备份 (JSON)**。

- 备份包含全部网址、名称、图标、简介、分类和个人配置，兼容之前导出的 JSON 文件。
- 导入前检查格式与网址，显示覆盖数量并请求确认；缺失的分类和站点 ID 会自动补齐。最大文件为 5 MB。
- 覆盖前在当前浏览器保存原数据，可用**恢复导入前备份**撤回最近一次导入。此副本保存在浏览器中，长期备份请导出文件。
- 导入与恢复须成功保存至服务器后才替换页面；同步失败会提示重试并保留原数据。
- iOS Safari 导出后可在下载列表中保存至“文件”，导入时从“文件”选择该 JSON。备份不包含共享粘贴板和最近访问记录。

### 浏览器兼容与验证

前端以 **iOS 14.2.1 Safari** 为兼容目标，提供 Flex 间距及文本复制的回退，并固定 Markdown 库版本；不依赖 `crypto.randomUUID`、`Array.at` 等新 API。

本地服务仍为零运行依赖。开发测试使用 Node.js 18+：

```bash
npm test                         # 元信息解析、网络边界、粘贴板 API 与 Worker 构建测试
npm install                      # 仅浏览器测试需要 Playwright 开发依赖
npx playwright install chromium webkit
npm run test:browser              # 隔离数据的浏览器回归测试
npm run build                    # 更新 worker-dist.js
```

浏览器回归使用 Chromium 和现代 WebKit，并模拟缺失 API 与 Flex gap 的情况，不能替代 iOS 14.2.1 真机验证。

---

## License

MIT
