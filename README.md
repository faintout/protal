# 极光导航 (Aurora Portal)

> 高颜值个人导航门户，支持自定义编辑网站/分类，内置多端实时共享粘贴板。

![预览](https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=https://aurora-portal.workers.dev)

## ✨ 功能特性

- **🌐 网址导航矩阵** - 精美卡片网格，毛玻璃主题，分类过滤
- **✏️ 可视化编辑** - 网站增删改，自动探测 Favicon，分类自维护，JSON 备份恢复
- **🔍 多引擎聚合搜索** - 站内实时过滤 + 百度/谷歌/必应/B站/GitHub/知乎
- **📋 共享粘贴板** - 多设备实时同步，Markdown 渲染，一键复制，悬浮抽屉
- **📱 局域网跨设备** - SSE 实时广播，扫码直达，手机电脑秒级互传
- **☁️ Cloudflare Worker** - 免费全球 CDN 部署，KV 边缘持久化

---

## 🚀 快速开始

### 本地运行 (零依赖)

```bash
node server.js
```

浏览器访问: `http://localhost:3000`

局域网地址和二维码会自动打印在控制台中。

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

| 模式 | 描述 |
|------|------|
| **单机模式** | 多标签页实时联动 (BroadcastChannel)，刷新不丢失 |
| **局域网模式** | `node server.js` 后，手机/平板扫码同步 (SSE) |
| **云端模式** | 部署 CF Worker 后，全球任意设备实时同步 |

### 手机跨设备传文字

1. 运行 `node server.js`
2. 控制台打印局域网地址，或在页面点击"📱 手机扫码直达"按钮
3. 手机扫码 → 打开粘贴板页 → 双向实时同步

---

## 📂 项目结构

```
protal/
├── public/
│   ├── index.html         # 主页面 HTML
│   ├── css/style.css      # 毛玻璃主题样式
│   └── js/app.js          # 前端逻辑 (搜索/编辑/粘贴板/SSE)
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

### 备份与恢复

设置图标 → **数据管理** → 导出 JSON / 导入备份 / 恢复预置

---

## License

MIT
