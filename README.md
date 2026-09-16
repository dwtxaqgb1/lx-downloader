# NAS音乐下载器 (LX Downloader) V2.4 稳定版

基于 Node.js + Express 的 Web 音乐下载器，部署在 NAS 上，支持多平台搜索、排行榜、歌单管理、JS音源上传、试听播放和批量下载。

## 功能特性

### 🎵 搜索
- 多平台搜索（网易云、QQ、酷狗等，可配置）
- 音质选择（标准/极高/无损）
- 搜索结果试听
- 全选/反选/取消选择
- 全部播放/选中播放
- 保存到歌单

### 📊 排行榜
- 多平台榜单（网易、QQ、酷狗、汽水音乐等）
- 榜单可在设置中自定义配置API
- 全选/反选/取消选择
- 试听/下载

### 📋 我的歌单
- 多歌单管理
- 上传 JSON 歌单文件
- 粘贴文本创建歌单
- 歌单二级菜单（列表→歌曲详情）
- 歌单内全选/反选/播放/下载

### ⬇️ 下载
- **下载到NAS**（管理员）：3线程并发下载到服务器
- **下载到本地**：浏览器直接下载，弹窗显示进度，可最小化为悬浮按钮
- **下载打包zip**（管理员）：打包成 zip 一次下载
- 支持暂停/取消
- 下载历史记录（倒序编号，跨设备共享）

### 📡 音源管理
- 上传落雪风格 JS 音源插件
- 多音源管理，开关控制
- 音源失效可重新上传
- vm沙箱加载，兼容Buffer/request/on/send等API

### 👥 用户系统
- 管理员/访客角色
- 管理员可添加访客账户
- 访客权限控制（只能试听，不能下载）
- 安装时可设置管理员账号密码
- 登录页验证，点击用户名二次确认退出

### 🎧 播放器
- 底部迷你播放栏
- 点击弹出大图播放器
- 封面、歌词滚动、模糊背景
- 播放队列支持

### 🎨 界面
- 暗色主题 (#0f1117背景，#1f6feb蓝色主题)
- 响应式设计（手机/电脑自适应）
- 手机端侧边滑出榜单

## 安装方式

### 方式一：飞牛FNOS FPK安装（推荐）

1. 下载 `lx-downloader.fpk`
2. 打开飞牛应用中心 → 手动安装 → 上传FPK文件
3. 安装向导中设置：
   - 管理员用户名和密码
   - 音乐下载保存路径（如 `/vol1/1000/音乐`）
4. 安装完成后点击桌面图标打开

### 方式二：Docker部署

```bash
docker run -d \
  --name lx-downloader \
  -p 5200:5200 \
  -v /your/download/path:/downloads \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=admin \
  -e PORT=5200 \
  -e DOWNLOAD_DIR=/downloads \
  --restart unless-stopped \
  ghcr.io/dwtxaqgb1/lx-downloader:latest
```

### 方式三：Docker Compose

```yaml
version: "3.8"
services:
  lx-downloader:
    image: ghcr.io/dwtxaqgb1/lx-downloader:latest
    container_name: lx-downloader
    restart: unless-stopped
    ports:
      - "5200:5200"
    volumes:
      - /your/download/path:/downloads
    environment:
      - PORT=5200
      - DOWNLOAD_DIR=/downloads
      - ADMIN_USER=admin
      - ADMIN_PASS=admin
```

启动：
```bash
docker-compose up -d
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| PORT | 服务端口 | 5200 |
| DOWNLOAD_DIR | 下载文件保存目录 | /downloads |
| ADMIN_USER | 管理员用户名 | admin |
| ADMIN_PASS | 管理员密码 | admin |

## 使用说明

1. **登录**：默认 admin/admin，Docker部署时通过环境变量设置
2. **上传音源**：设置 → 音源管理 → 上传JS音源文件
3. **搜索**：输入歌名/歌手，选择平台搜索
4. **排行榜**：左侧菜单选择榜单平台
5. **歌单**：上传JSON歌单或粘贴歌单
6. **下载**：勾选歌曲后选择下载到NAS、本地或打包ZIP
7. **访客**：管理员可在设置中添加访客账户

## 技术架构

```
lx-downloader/
├── app/
│   ├── server.js          # 后端Express服务
│   ├── package.json        # 依赖（express, cors, archiver等）
│   └── public/
│       └── index.html     # 前端单页应用
├── fpk-build/             # 飞牛FPK打包配置
│   ├── app/docker/        # 容器编排
│   ├── cmd/                # 生命周期脚本
│   ├── config/             # 权限和资源声明
│   └── wizard/             # 安装向导
└── docker-compose.yml
```

### 后端核心模块 (server.js)

- **Express Web服务**：提供REST API和静态文件服务
- **音源VM沙箱加载**：
  - 用Node.js `vm`模块隔离执行JS音源
  - 自动注入Buffer、request、on、send、log等全局对象
  - 兼容落雪音源插件格式（on(EVENT_NAMES.request, callback)）
  - 多音源开关控制，按优先级依次尝试
- **下载队列**：
  - 3线程并发下载到NAS
  - 支持暂停/取消
  - 自动写下载历史
- **无损音质获取**：
  - gdstudio API: br=740返回flac，br=320返回mp3
  - fallback: oiapi返回mp3
- **认证系统**：
  - Token会话管理
  - 环境变量ADMIN_USER/ADMIN_PASS每次启动强制同步admin
  - admin/guest角色权限分离
- **数据持久化**（都在DOWNLOAD_DIR）：
  - `auth.json`：用户账号和会话
  - `sources.json`：上传的JS音源
  - `api-config.json`：榜单平台API配置
  - `history.json`：下载历史
  - `playlists/*.json`：用户歌单

### 前端核心 (index.html)

- 纯HTML/CSS/JS单页应用，无框架依赖
- 暗色主题，响应式布局
- 底部迷你播放器 + 全屏播放器（封面/歌词/背景图）
- 下载进度弹窗，最小化为右下角悬浮按钮
- 手机版侧边滑出榜单选择器

### 数据文件说明

| 文件 | 说明 |
|------|------|
| auth.json | 用户账号密码和会话 |
| sources.json | 上传的JS音源内容 |
| api-config.json | 榜单平台API配置 |
| history.json | 下载历史记录 |
| playlists/*.json | 用户歌单 |

## 飞牛FPK打包

本项目包含飞牛FPK打包配置，使用fnpack 1.2.3：

```bash
cd fpk-build/lx-downloader
fnpack build
```

FPK安装向导支持：
- 安装时设置管理员账号密码
- 设置音乐下载保存路径
- 端口固定5200

## 注意事项

- 音源JS文件仅供学习交流，请支持正版音乐
- 上传的音源会随平台接口变化而失效，可随时更换
- 下载到本地通过服务器代理转发音频流
- 访客账户不能下载到NAS和打包ZIP

## License

MIT
