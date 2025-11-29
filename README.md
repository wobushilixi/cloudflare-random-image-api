# 🚀 Cloudflare Worker 随机图片 API & 链接管理器 (V13)

这是一个高性能、功能丰富的随机图片链接分发服务，完全基于 **Cloudflare Worker** 和 **Cloudflare KV** 存储构建。

### ✨ 核心特性

* **极速分发：** 利用 Cloudflare 全球 CDN，实现超低延迟的图片链接重定向。
* **标签筛选：** API 支持通过 `?tag=xxx` 参数精确获取特定分类的图片。
* **分辨率控制：** API 支持通过 `?ratio=W:H` 参数筛选特定宽高比的图片。
* **自动化维护 (Cron)：** 使用 Cron Triggers 定时自动检查并清理失效的图片链接。
* **现代化管理面板：** 提供管理员登录界面，支持链接的批量添加、分页管理、批量删除、数据导入/导出。
* **零服务器成本：** 仅需 Worker 和 KV 的免费额度即可长期稳定运行。

---

## 🛠️ 部署指南 (Setup)

### 前置条件

1.  一个 Cloudflare 账户。
2.  安装 Cloudflare **Wrangler CLI**（用于部署）。
    ```bash
    npm install -g wrangler
    ```

### 1. 创建 KV 命名空间

在 Cloudflare 仪表盘中创建一个 KV 命名空间，命名为 `IMAGE_LINKS` (或任何您喜欢的名称)，并记下它的 **ID**。

### 2. 配置项目文件

在您的项目根目录下创建 `index.js` 和 `wrangler.toml` 文件。

**`index.js`:**
将完整的 Worker 代码粘贴到此文件中。

**`wrangler.toml`:**
将以下内容复制到 `wrangler.toml` 并替换您的 KV ID：

```toml
name = "random-image-api-worker" 
main = "index.js" 
compatibility_date = "2024-05-01" 

# 绑定 KV 命名空间
[[kv_namespaces]]
binding = "IMAGE_LINKS" # 必须与 Worker 代码中的变量名 IMAGE_LINKS 匹配
id = "YOUR_KV_NAMESPACE_ID_HERE" # <<< 替换成您在 Cloudflare 创建的 ID
