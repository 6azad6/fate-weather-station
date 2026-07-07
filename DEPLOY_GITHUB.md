# GitHub 部署说明

## 1. 只部署到 GitHub Pages

GitHub Pages 可以提供公网 HTTPS 页面，微信可以打开和解析链接。

但要注意：GitHub Pages 只能运行静态网页，不能运行 `server.js`，所以此模式下页面会自动显示“本地演示版”，不能统计所有用户总盈亏。

上传到 GitHub 后：

1. 打开仓库 Settings。
2. 进入 Pages。
3. Source 选择 GitHub Actions。
4. 推送 main 分支后，`.github/workflows/pages.yml` 会自动发布页面。

## 2. 保留“所有用户总盈亏实时同步”

需要把这个 GitHub 仓库再连接到 Render / Railway / Fly.io 之类能运行 Node 的平台。

本项目已包含 `render.yaml`，在 Render 中选择 New Web Service 并连接这个 GitHub 仓库即可。

运行命令：

```text
npm start
```

部署成功后，微信访问 Render 给出的 HTTPS 地址，顶部应显示：

```text
多人实时版
```

只有这个状态下，气象球才是所有用户总盈亏。
