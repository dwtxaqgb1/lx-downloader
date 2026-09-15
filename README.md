# NAS歌曲下载器 (lx-downloader) V2

一个基于 Node.js + Express 的轻量级音乐搜索/试听/下载 Web 应用，专为 NAS 部署设计。

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
- 榜单可在设置中自定义配置
- 全选/反选/取消选择
- 试听/下载

### 📋 我的歌单
- 多歌单管理
- 上传 JSON 歌单文件
- 粘贴文本创建歌单
- 歌单二级菜单（列表→歌曲详情）
- 歌单内全选/反选/播放/下载

### ⬇️ 下载
- **下载到NAS**（管理员）：多线程并发下载到服务器
- **下载到本地**：单首 mp3 逐个下载到浏览器
- **下载打包zip**（管理员）：打包成 zip 一次下载
- 下载管理页面实时显示进度
- 支持暂停/取消
- 下载历史记录（跨设备共享）

### 📡 音源管理
- 上传落雪风格 JS 音源插件
- 多音源管理，开关控制
- 音源失效可重新上传

### 👥 用户系统
- 管理员/访客角色
- 管理员可添加访客账户
- 访客权限控制（隐藏下载到NAS、打包下载、设置、删除等）
- 登录页验证

### 🎧 播放器
- 底部迷你播放栏
- 点击弹出大图播放器
- 封面、歌词滚动、模糊背景
- 播放队列支持

### 🎨 界面
- 暗色主题
- 响应式设计（手机/电脑自适应）
- 手机端侧边滑出榜单

## 快速部署

### 方式一：docker-compose（推荐）

```bash
mkdir -p lx-downloader/downloads
cd lx-downloader
```

创建 `docker-compose.yml`：

```yaml
services:
  lx-downloader:
    image: node:18-alpine
    container_name: lx-downloader
    restart: unless-stopped
    ports:
      - "5200:5200"
    volumes:
      - ./app:/app
      - ./downloads:/downloads
    working_dir: /app
    command: sh -c "npm install --production --registry=https://registry.npmmirror.com && node server.js"
    environment:
      - PORT=5200
      - DOWNLOAD_DIR=/downloads
```

启动：

```bash
docker-compose up -d
```

### 方式二：直接运行

```bash
cd app
npm install --production
node server.js
```

## 默认账号

- 管理员：`admin` / `admin`
- 登录后请在设置→账号安全中修改密码

## 目录结构

```
lx-downloader/
├── app/
│   ├── server.js          # 后端服务
│   ├── package.json
│   ├── Dockerfile
│   └── public/
│       └── index.html    # 前端页面
├── downloads/             # 持久化数据
│   ├── sources.json       # 音源配置
│   ├── auth.json          # 用户认证
│   ├── api-config.json    # 榜单平台配置
│   ├── history.json       # 下载历史
│   └── playlists/         # 歌单文件
└── docker-compose.yml
```

## 端口

默认 `5200`，可在 docker-compose.yml 中修改。

## 设置说明

点击右上角齿轮图标进入设置：

1. **音源管理**：上传 JS 音源，开关启用/禁用
2. **歌单管理**：上传/粘贴歌单
3. **榜单平台配置**：JSON 格式配置各平台榜单 API
4. **账号安全**：修改密码、添加/删除访客

## 技术栈

- 后端：Node.js 18 + Express
- 前端：原生 HTML/CSS/JS（无框架）
- 容器：Docker
- 音源加载：Node.js vm 沙箱

## License

仅供学习交流使用。
