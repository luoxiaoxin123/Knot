# Knot（结点）

<img src="web/public/favicon.svg" width="64" alt="Knot" />

自托管的订阅聚合与转换工具：把**自建节点**和**外部（机场）订阅**放在一起管理，配置**链式代理**与**分流规则**，生成一个订阅链接导入 Clash / mihomo、Stash、sing-box、Surge、Loon、Quantumult X、V2Ray 系客户端。

- 单个 Docker 容器，数据存为 JSON 文件，无数据库依赖；常驻内存约 80MB（1000 个节点时峰值约 100MB）
- 简洁的 WebUI，支持手机端与深色模式
- 生成的 Clash 配置与 sing-box 配置均通过 mihomo / sing-box 内核校验

## 功能

**节点**
- 粘贴导入：`vless` `vmess` `trojan` `ss`（含 SS2022 / obfs / v2ray-plugin）`ssr` `hysteria2`（含端口跳跃）`hysteria` `tuic` `anytls` `wireguard` `socks5` `http` 分享链接，Base64 订阅内容，Clash YAML，sing-box JSON
- 节点启用 / 停用、标签、批量操作、复制分享链接、二维码、YAML 直接编辑
- **真实延迟测试**：调用 mihomo 内核经节点实际请求测速，支持 Hysteria2 / TUIC 等 UDP 协议和链式代理（没有内核时退回 TCP 握手延迟）
- **解锁检测**：检测落地出口 IP / 地区，以及 ChatGPT（网页 / App）、Claude、Gemini、Netflix（全解锁 / 仅自制剧）、YouTube Premium 是否可用
  - Claude：claude.ai 被 Cloudflare 人机验证拦下时，按 Cloudflare 识别的出口地区对照 [Anthropic 官方支持列表](https://www.anthropic.com/supported-countries) 判断
  - Gemini：按页面里 Google 识别的地区判断（不支持的地区：中国内地、香港、澳门、俄罗斯、白俄罗斯、古巴、伊朗、朝鲜、叙利亚）
  - 拿不到足够信息时显示「无法判断」，不会误报为不可用
- **临时分享**：勾选节点生成一次性 / 限次 / 限时的分享链接，随时作废，带访问记录

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
- 地区分组按**落地节点**判断；链式节点没单独设旗帜时沿用落地节点的旗帜
- Clash 输出为 `dialer-proxy`，sing-box 输出为 `detour`；V2Ray 链接无法表达链式代理，会自动跳过

**分流规则**
- 内置分流模块（见下文），在每个订阅输出里勾选启用，预设「极简 / 推荐 / 完整」
- 自定义规则：可视化编辑与 YAML 编辑双模式，所有规则在一个列表里，每项可单独启用 / 停用、调整顺序
  - 规则集：起个名字，一次粘贴多条规则（YAML 列表、Clash 规则文件的 `payload:` 或纯文本都行），每行 `类型,值[,策略][,no-resolve]`，没写策略的行使用默认策略
  - 支持 mihomo 的全部规则类型：DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / DOMAIN-WILDCARD / DOMAIN-REGEX / GEOSITE / GEOIP / IP-CIDR / IP-CIDR6 / IP-SUFFIX / IP-ASN / SRC-GEOIP / SRC-IP-ASN / SRC-IP-CIDR / SRC-IP-SUFFIX / DST-PORT / SRC-PORT / IN-PORT / IN-TYPE / IN-USER / IN-NAME / PROCESS-NAME(-WILDCARD / -REGEX) / PROCESS-PATH(-WILDCARD / -REGEX) / UID / NETWORK / DSCP / RULE-SET，以及逻辑规则 AND / OR / NOT
  - 其他客户端不支持的类型会在生成时跳过并给出提示（sing-box 会把 PROCESS-NAME-REGEX 自动转换成路径正则）
  - 远程规则集：yaml / text / mrs，domain / ipcidr / classical
  - 在编辑框的「模式」里选择**添加至头部**（最高优先级）或**添加至尾部**（兜底之前）
  - 策略可以是分组、DIRECT、REJECT、具体节点；填一个不存在的名字会**自动新建分组**
  - GEOSITE / GEOIP 规则自动转换为 MetaCubeX 规则集，客户端无需下载完整的 geosite.dat
- 外部规则模板：导入 subconverter / ACL4SSR 的 `.ini`，或任意 Clash YAML（包括机场的 Clash 订阅），节点会自动替换为你的节点

**代理组**
- 默认根据分流模块 / 模板自动生成
- 也可以切换为**自定义**：可视化拖拽编辑器，把节点拖进分组、组内排序、跨组移动，拖到「从所有分组移除 / 添加到所有分组」批量操作，双击改名，切换 select / url-test / fallback / load-balance
- 分组可设置“自动加入新节点”（可按名称正则筛选），订阅新增节点自动进组，手动移除的不会被加回
- 规则引用的分组改名后规则自动跟随；被删除的分组生成时会自动补回，保证配置可用

**订阅输出**
- 可创建多个输出（例如“手机”“家人”），分别选择节点（全部 / 按来源 / 手动挑选 + 正则过滤）与规则
- **短链**：`/x/xxxxxxxx`，可自定义（如 `/x/phone`）
- **访问控制**：启用 / 停用、有效期、最多拉取次数、每小时频率限制、IP 白名单；访问记录里能看到被拒绝的请求和原因
- 同一个链接根据客户端 UA 自动返回 Clash YAML / sing-box JSON / Base64，也可以用 `?target=clash|singbox|v2ray` 指定
- 自动地区分组（香港 / 台湾 / 日本 / 新加坡 / 美国 / 韩国）
- 旗帜：在「节点」页手动给节点设置（可批量），输出时加在节点名前；不按 IP 或名称自动猜，避免中转导致地区不准
- 覆写 YAML：与生成的配置深度合并，修改端口、DNS、TUN 等任意字段
- 预览生成结果，显示转换警告；记录最近的拉取记录（时间 / IP / UA）
- 一键导入链接、二维码、链接泄露时可重置

**多客户端格式**

| 格式 | 说明 |
|---|---|
| Clash / mihomo | 完整配置，mrs 规则集，支持全部协议与链式代理 |
| Stash | Clash 兼容格式，自动转换字段差异（Hysteria2 `auth`、TUIC v5 等），规则集改用文本格式 |
| sing-box | 1.12+ 格式，srs 规则集，链式代理用 `detour` |
| Surge | 完整托管配置（`#!MANAGED-CONFIG` 自动更新），链式代理用 `underlying-proxy`；不支持 VLESS |
| Loon | 完整配置，支持 VLESS Reality / Hysteria2；不支持 TUIC、链式代理 |
| Quantumult X | 完整配置，支持 VLESS Reality；不支持 Hysteria2 / TUIC、链式代理 |
| V2Ray | Base64 分享链接（v2rayN / v2rayNG / Shadowrocket / NekoBox） |

Surge / Loon / QX 的分流规则使用 [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) 中对应客户端格式的规则集。只要节点不要规则时，在链接后加 `&list=1`。客户端不支持的节点会跳过，并在「预览配置」里列出原因。

**安全与审计**
- 两步验证（TOTP，兼容 Google Authenticator / 1Password / Bitwarden 等）+ 8 个一次性恢复码
- 通行密钥（Passkey）：指纹 / 面容 / 安全密钥直接登录（需要 HTTPS）
- 登录失败 10 次封禁该 IP 10 分钟
- **日志**：谁拉取了订阅（IP、客户端、格式、被拒绝原因、无效链接的访问）、谁登录了面板（成功 / 失败 / 两步验证失败 / 通行密钥）、敏感操作（改密码、恢复备份、重置链接等）；24 小时统计；可设置保留天数

**历史版本**
- 输出配置、自定义规则、规则模板、自建 / 链式节点每次修改自动保存版本，2 分钟内的连续修改合并
- 查看与当前内容的差异，一键恢复（恢复前的内容也会保存，可以再恢复回来；订阅链接保持不变）

**迁移**
- 从 **Sub-Store** 备份导入：远程订阅 → 订阅源，本地订阅 → 节点，组合订阅 → 输出配置
- 从 **妙妙屋（miaomiaowu）** 的 `traffic.db` 导入：节点、链式代理、外部订阅

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
mkdir knot && cd knot
curl -O https://raw.githubusercontent.com/luoxiaoxin123/knot/main/docker-compose.yml
docker compose up -d          # 拉取预构建镜像
```

或者克隆仓库后 `docker compose up -d --build` 在本地构建。

打开 `http://服务器IP:3000`，首次访问设置管理密码。数据保存在 `./data/db.json`。

### Docker

```bash
docker run -d --name knot --restart unless-stopped \
  -p 3000:3000 -v $(pwd)/data:/data \
  ghcr.io/luoxiaoxin123/knot:latest
```

> 镜像由 GitHub Actions 在推送版本 tag 后自动构建（amd64 / arm64），见下方「发布新版本」。首次发布后需要在 GitHub 的 Packages 中把 `knot` 镜像设为 Public，否则服务器拉取前要先 `docker login ghcr.io`。

### 从源码运行

需要 Node.js 22.19+；真实测速 / 解锁检测需要 [mihomo](https://github.com/MetaCubeX/mihomo/releases) 内核（放到 PATH 或用 `MIHOMO_PATH` 指定，Docker 镜像已内置）：

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
| `MIHOMO_PATH` | — | mihomo 内核路径（镜像内为 `/usr/local/bin/mihomo`） |

> 名字的由来：Knot 是「结」，把自建节点、机场订阅、链式代理结在一起；「结点」也是节点的旧称。
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

## 临时分享说明

分享链接限制的是**拉取订阅**：次数用完、过期或作废后，对方无法再拉取 / 更新。但对方已经导入的节点里包含连接密码，在你更换该节点的密码 / UUID 之前仍能连接。需要“到期立刻断开”时，要让对方使用独立凭据（例如在 3x-ui 面板里为分享单独建一个带到期时间的用户）。

## 反向代理与 IP 白名单

访问控制中的 IP 白名单只在请求来自本机 / 内网（即经过反向代理）时才读取 `X-Forwarded-For` / `X-Real-IP`，直接暴露端口时使用 TCP 连接的来源地址，避免被伪造请求头绕过。

## 客户端识别

同一个链接按 UA 返回对应格式，也可以用 `?target=` 指定（`clash` `stash` `singbox` `surge` `loon` `qx` `v2ray`）：

| UA 包含 | 返回格式 |
|---|---|
| stash | Stash |
| surge | Surge |
| loon | Loon |
| quantumult | Quantumult X |
| sing-box / SFA / SFI / SFM | sing-box JSON（1.12+ 格式） |
| clash / mihomo / verge / flclash / nyanpasu / hiddify | Clash YAML |
| 其他（v2rayN / v2rayNG / Shadowrocket / NekoBox …） | Base64 分享链接 |

## 资源占用

实测（Node 22，节点数 23 / 1000）：空闲约 78MB；1000 个节点连续生成 90 次订阅后约 100MB（Docker 镜像默认用 `--max-old-space-size=128` 限制 V8 堆，不加限制时峰值会到 200MB 左右，但速度相同）。1000 个节点生成一次 Clash 配置约 80ms。真实测速 / 解锁检测时会临时启动一个 mihomo 进程，结束后退出。

## 发布新版本

```bash
git tag v1.0.0
git push origin v1.0.0
```

推送 `v*` tag 后，`Docker` 工作流会先跑测试，再构建 amd64 / arm64 镜像推送到 `ghcr.io/<用户名>/knot`：

| tag | 生成的镜像标签 |
|---|---|
| `v1.2.3` | `1.2.3`、`1.2`、`1`、`latest` |
| `v1.3.0-beta.1`（预发布） | `1.3.0-beta.1`（不更新 `latest`） |

也可以在 Actions 页面手动运行 `Docker` 工作流，构建指定标签（例如 `dev`）的镜像。版本号会显示在面板左下角。

推送到 main 或提交 PR 时，`CI` 工作流会运行类型检查、单元测试、构建，并验证 Docker 镜像能正常构建和启动（不推送）。

服务器更新：

```bash
docker compose pull && docker compose up -d
```

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
