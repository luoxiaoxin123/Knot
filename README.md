# Switch

自托管的订阅聚合与转换工具：把**自建节点**和**外部（机场）订阅**放在一起管理，配置**链式代理**与**分流规则**，生成一个订阅链接导入 Clash / mihomo、sing-box、V2Ray 系客户端。

- 单个 Docker 容器，数据存为一个 JSON 文件，无数据库依赖
- 简洁的 WebUI，支持手机端与深色模式
- 生成的 Clash 配置与 sing-box 配置均通过 mihomo / sing-box 内核校验

## 功能

**节点**
- 粘贴导入：`vless` `vmess` `trojan` `ss`（含 SS2022 / obfs / v2ray-plugin）`ssr` `hysteria2`（含端口跳跃）`hysteria` `tuic` `anytls` `wireguard` `socks5` `http` 分享链接，Base64 订阅内容，Clash YAML，sing-box JSON
- 节点启用 / 停用、标签、批量操作、复制分享链接、二维码、YAML 直接编辑
- TCP 延迟测试（UDP 协议节点如 Hysteria2 / TUIC 无法用 TCP 测速，会标注 UDP）

**外部订阅**
- 支持 Clash / Base64 / 分享链接 / sing-box 格式，可自定义 User-Agent
- 定时自动更新、保留 / 排除正则（默认过滤“剩余流量 / 到期”等提示节点）、名称前缀
- 显示流量与到期时间，并可通过 `Subscription-Userinfo` 透传给客户端
- 订阅更新时尽量保持节点 ID 不变，**依赖它的链式代理不会失效**

**链式代理**
- 在任意节点上点「链」图标 → 选择中转节点 → 生成新的链式节点（本机 → 中转 → 落地）
- 支持多级链（中转节点本身也可以是链式节点），自动检测循环引用
- 中转节点即使没被订阅输出选中，也会自动写入配置（只放在 `proxies`，不进分组，避免干扰）
- 链式节点的配置在导出时从落地节点实时派生：落地节点更新（换端口 / 换 IP）后，链式节点自动跟着变
- 地区分组、国旗按**落地节点**判断
- Clash 输出为 `dialer-proxy`，sing-box 输出为 `detour`；V2Ray 链接无法表达链式代理，会自动跳过

**分流规则**
- 内置分流模块（见下文），在每个订阅输出里勾选启用，预设「极简 / 推荐 / 完整」
- 自定义规则：可视化编辑（选类型、填内容、选策略，支持一次填多行批量添加）与 YAML 编辑双模式
  - 单条规则：DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / DOMAIN-REGEX / GEOSITE / GEOIP / IP-CIDR / IP-CIDR6 / IP-ASN / SRC-IP-CIDR / DST-PORT / SRC-PORT / PROCESS-NAME / PROCESS-PATH / NETWORK / RULE-SET
  - 远程规则集：yaml / text / mrs，domain / ipcidr / classical
  - 可选放在**头部**（最高优先级）或**尾部**（兜底之前）
  - 策略可以是分组、DIRECT、REJECT、具体节点；填一个不存在的名字会**自动新建分组**
  - GEOSITE / GEOIP 规则自动转换为 MetaCubeX 规则集，客户端无需下载完整的 geosite.dat
- 外部规则模板：导入 subconverter / ACL4SSR 的 `.ini`，或任意 Clash YAML（包括机场的 Clash 订阅），节点会自动替换为你的节点

**订阅输出**
- 可创建多个输出（例如“手机”“家人”），分别选择节点（全部 / 按来源 / 手动挑选 + 正则过滤）与规则
- 同一个链接根据客户端 UA 自动返回 Clash YAML / sing-box JSON / Base64，也可以用 `?target=clash|singbox|v2ray` 指定
- 自动地区分组（香港 / 台湾 / 日本 / 新加坡 / 美国 / 韩国）、节点名自动加国旗
- 覆写 YAML：与生成的配置深度合并，修改端口、DNS、TUN 等任意字段
- 预览生成结果，显示转换警告；记录最近的拉取记录（时间 / IP / UA）
- 一键导入链接、二维码、链接泄露时可重置

**备份**
- S3 兼容对象存储（AWS S3 / Cloudflare R2 / MinIO / 阿里云 OSS / 腾讯云 COS / Backblaze B2 …）定时备份、保留份数、一键恢复
- 本地下载 / 上传 JSON 备份

## 内置分流规则说明

规则源使用 [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)：

- 域名数据来自社区维护的 [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)，IP 数据来自 Loyalsoldier GeoIP，**每天自动构建**
- 为 mihomo 提供 `.mrs` 二进制格式（体积小、加载快、内存占用低），为 sing-box 提供同源 `.srs` 格式，两种客户端行为一致
- 相比 ACL4SSR 的 `.list` 文本规则：条目更全、维护更活跃，`category-ai-!cn` 这类分类可以一条规则覆盖 ChatGPT / Claude / Gemini / Copilot 等全部 AI 服务

规则顺序（即匹配优先级）：

| 顺序 | 模块 | 规则 | 默认 |
|---|---|---|---|
| — | 自定义头部规则 | | |
| 1 | 🏠 局域网 | geosite:private、geoip:private | 固定直连 |
| 2 | 🛑 广告拦截 | geosite:category-ads-all | 拦截 |
| 3 | 🤖 AI 服务 | geosite:category-ai-!cn | 代理 |
| 4 | 📲 Telegram | geosite:telegram、geoip:telegram | 代理 |
| 5 | 📹 YouTube / 🔍 Google / 🐱 GitHub / 🐦 X / 📘 Meta / 🎧 Discord | 对应 geosite | 代理 |
| 6 | 🎥 Netflix / 🏰 Disney+ / 🌍 国外媒体 / 🎮 游戏平台 | 对应 geosite | 代理 |
| 7 | Ⓜ️ 微软 / 🍎 苹果 / 📺 哔哩哔哩 | 对应 geosite | 直连 |
| 8 | 🌐 国外网站 | geosite:geolocation-!cn | 节点选择 |
| 9 | 🎯 国内直连 | geosite:cn、geoip:cn | 直连 |
| — | 自定义尾部规则 | | |
| 10 | 🐟 漏网之鱼 | MATCH | 代理 |

每个非固定模块都会生成一个可在客户端切换的分组。规则集默认通过「🚀 节点选择」下载（国内访问 GitHub 不稳定），也可以在设置里换成 jsDelivr 或自定义加速前缀。

## 部署

### Docker Compose（推荐）

```bash
mkdir switch && cd switch
curl -O https://raw.githubusercontent.com/luoxiaoxin123/switch/main/docker-compose.yml
# 使用预构建镜像：把 docker-compose.yml 中的 `build: .` 换成
#   image: ghcr.io/luoxiaoxin123/switch:latest
docker compose up -d
```

或者克隆仓库后直接 `docker compose up -d --build`。

打开 `http://服务器IP:3000`，首次访问设置管理密码。数据保存在 `./data/db.json`。

### Docker

```bash
docker run -d --name switch --restart unless-stopped \
  -p 3000:3000 -v $(pwd)/data:/data \
  ghcr.io/luoxiaoxin123/switch:latest
```

> 镜像由 GitHub Actions 在推送到 main 分支后自动构建（amd64 / arm64）。首次使用需要在 GitHub 仓库的 Packages 中把镜像设为 Public，或先 `docker login ghcr.io`。

### 从源码运行

需要 Node.js 20+：

```bash
npm ci
npm run build
DATA_DIR=./data PORT=3000 npm start
```

开发模式：`npm run dev`（前端 http://localhost:5173，自动代理到后端 3000 端口）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data`（镜像内 `/data`） | 数据目录 |
| `ADMIN_PASSWORD` | — | 首次启动时设置管理密码（已设置过则忽略） |
| `NODE_USE_ENV_PROXY` + `HTTPS_PROXY` | — | 服务器拉取订阅 / 模板需要走代理时设置 |

### 反向代理（HTTPS）

建议放在 HTTPS 反代后面，并在「设置 → 对外访问地址」填写域名，订阅链接会使用该地址。

Caddy：

```
sub.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name sub.example.com;
    # ssl_certificate ...;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 使用流程

1. **节点** → 添加节点：粘贴自建节点的分享链接
2. **订阅源** → 添加订阅：填机场订阅链接（可选）
3. **节点** → 在落地节点上点「链」图标 → 选中转节点，生成链式节点（可选）
4. **规则** → 添加自定义规则（可选）
5. **订阅输出** → 编辑默认配置：选节点、勾选分流模块 → 复制链接导入客户端

## 客户端识别

| UA 包含 | 返回格式 |
|---|---|
| clash / mihomo / stash / verge / flclash / nyanpasu / hiddify | Clash YAML |
| sing-box / SFA / SFI / SFM | sing-box JSON（1.12+ 格式） |
| 其他（v2rayN / v2rayNG / Shadowrocket / NekoBox …） | Base64 分享链接 |

## 开发

```
server/   后端（Hono + Node.js）
  src/core/   解析、转换、配置生成（纯函数，有单元测试）
  src/services/ 订阅拉取、测速、S3 备份
shared/   前后端共享类型
web/      前端（React + Tailwind）
```

```bash
npm test          # 单元测试
npm run typecheck # 类型检查
```

## License

Apache-2.0
