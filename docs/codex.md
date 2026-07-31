# Codex 项目记录

## 这个项目做什么

这是一个面向跨境电商运营的 SaaS 后台，当前主线是 **EtsyCore Commerce OS**：连接 Etsy 店铺，把店铺、Listing、订单、交易明细、物流和同步状态写入本地 PostgreSQL，再在后台提供仪表盘、商品、订单、Listing 表格和系统设置等运营页面。

项目当前阶段的重点不是扩展多渠道，而是先把 Etsy 店铺运营闭环做扎实：能安全稳定运行，能通过表格控制 Listing 编辑，能用多维表格批量处理商品字段，并能把订单、销售、库存、流量等数据做成可用的数据看板。ERP 表结构作为后续数据承接层存在，但不是当前优先事项。

当前已经具备的能力：

- Etsy OAuth2 + PKCE 店铺连接、Token 刷新和断开连接。
- Etsy webhook、定时任务和手动同步入口。
- 数据库任务队列，支持全量同步、增量订单同步、Listing 同步、Receipt 详情同步和 SKU 更新任务。
- PostgreSQL 原始同步层：店铺、Listing、订单、交易明细、物流、webhook 事件、同步任务和游标。
- ERP 归一化层：组织、用户角色、渠道账号、商品、变体、SKU、库存、客户、订单、订单明细、履约、财务拆分和外部 ID 映射，可作为数据看板和后续扩展的数据承接层。
- 后台页面：Dashboard、Products、Listing Sheet、Orders、Settings。
- Listing 写回 Etsy：创建草稿 / 发布 Listing、上传图片、更新标题/描述/状态/价格/库存/SKU 等字段。
- Listing Sheet 已经是表格式操作入口，需要继续增强成可控、可批量保存、可回滚的 Listing 编辑工作台。

核心数据流：

```text
Etsy OAuth / Webhook / Cron / Manual Sync
  -> src/app/api/* 路由
  -> src/features/sync/processor.ts 同步任务处理
  -> Etsy 原始同步表 etsy_*
  -> ERP 归一化表 products / skus / orders / inventory / channel_accounts
  -> Dashboard / Products / Orders / Listing Sheet 页面读取展示
```

Listing Sheet 当前结构：

- `已有 listing`：读取数据库 `etsy_listings`，一行对应一个线上 Etsy listing，用于查看、编辑、批量保存和删除。字段包括标题、描述、价格、数量、状态、SKU、tags、材料、图片、视频和变体抽屉。
- `添加 listing`：使用浏览器本地草稿，一行对应一个待创建 listing。Header bar 保存 taxonomy、shipping profile、readiness、制作人、材料、默认价格和默认数量等公用默认值，行内字段优先。
- `预上架 TDK`：使用浏览器本地暂存，不写数据库、不调用 Etsy API。只放 SKU、Title、Description、Tags，可批量导入到 `添加 listing`。
- 主表一行只代表一个 listing，变体通过右侧抽屉管理。已有 listing 的变体来自 Etsy `inventory.products[]`，添加 listing 的变体由本地配置生成 Etsy inventory。
- SKU 规则目标：默认只维护主表 SKU；变体 SKU 只有明确在变体抽屉里填写时才维护。
- 表格底层以 `DataGrid` 渲染为主，后续逐步统一到内部 Sheet Engine，集中处理选择、复制粘贴、撤销、批量删除和字段校验。

## 文件树图

```text
D:\SaaS
├─ README.md                         # 项目说明、运行方式、同步架构和生产注意事项
├─ package.json                      # Next.js / React / TypeScript 脚本和依赖
├─ next.config.ts                    # Next.js 配置
├─ tsconfig.json                     # TypeScript 配置
├─ eslint.config.mjs                 # ESLint 配置
├─ local.env.example                 # 本地环境变量示例
├─ dev.cmd                           # Windows 本地启动脚本
├─ data
│  └─ app.json                       # 无数据库时的本地文件存储兼容数据
├─ docs
│  ├─ current-architecture-flowcharts.md
│  └─ codex.md                       # 当前文件：给项目和后续 Codex 协作看的总览
├─ migrations
│  └─ 001_erp_core.sql               # ERP 核心数据模型和初始化数据
├─ scripts
│  ├─ migrate.mjs                    # 执行数据库迁移
│  ├─ backfill-erp.mjs               # 从 Etsy 原始表回填 ERP 表
│  ├─ import-local-store.mjs         # 导入本地 data/app.json
│  └─ copy-postgres-data.mjs         # PostgreSQL 数据复制辅助脚本
├─ public                            # 静态资源
└─ src
   ├─ app
   │  ├─ layout.tsx                  # 全局布局
   │  ├─ globals.css                 # 全局样式
   │  ├─ page.tsx                    # 首页入口
   │  ├─ dashboard/page.tsx          # 店铺仪表盘
   │  ├─ products/page.tsx           # 商品概览
   │  ├─ listing-sheet/page.tsx      # Listing 表格式创建、编辑和 SKU 管理
   │  ├─ orders/page.tsx             # 订单和交易明细
   │  ├─ settings/page.tsx           # 店铺连接、同步队列和系统配置
   │  └─ api
   │     ├─ etsy
   │     │  ├─ connect/route.ts      # 发起 Etsy OAuth
   │     │  ├─ callback/route.ts     # OAuth 回调、建店铺、触发首次同步
   │     │  ├─ status/route.ts       # Etsy 连接状态
   │     │  ├─ disconnect/route.ts   # 断开店铺
   │     │  ├─ sync/route.ts         # 手动同步
   │     │  └─ webhook/route.ts      # Etsy webhook 入口
   │     └─ sync
   │        ├─ cron/route.ts         # 定时同步入口
   │        └─ jobs/route.ts         # 同步任务 worker 入口
   ├─ components
   │  ├─ app-shell.tsx               # 后台框架、导航、店铺切换和基础组件
   │  ├─ settings                    # 设置页组件
   │  └─ products                    # Listing 缩略图、表单、批量表格和现有 Listing 表格
   ├─ features
   │  ├─ etsy                        # Etsy OAuth 和 API Client
   │  ├─ sync                        # 同步任务队列、任务处理和原始表读写
   │  ├─ erp                         # ERP 表查询、归一化和 Commerce Snapshot
   │  ├─ products                    # Listing 创建、更新、批量写回 Server Actions
   │  ├─ orders                      # 订单页面 ViewModel
   │  ├─ dashboard                   # 仪表盘图表和指标 ViewModel
   │  └─ workspace                   # lang/shopId/selectedShop 工作区解析
   ├─ lib
   │  ├─ env.ts                      # local.env 环境变量读取
   │  ├─ db.ts                       # 数据库兼容入口
   │  ├─ store.ts                    # readStore/writeStore/selectShop
   │  ├─ sync-processor.ts           # 兼容导出
   │  ├─ sync-db.ts                  # 兼容导出
   │  ├─ erp-db.ts                   # 兼容导出
   │  └─ commerce-metrics.ts         # 指标兼容工具
   ├─ server
   │  └─ db.ts                       # PostgreSQL Pool 和 DATABASE_URL
   └─ shared
      ├─ types/etsy.ts               # Etsy 和 AppStore 类型
      ├─ format/commerce.ts          # 金额、数量、日期、指标格式化
      └─ i18n/index.ts               # 中英文文案和状态标签
```

## 要完成的事情

### P0：先保证产品能安全稳定跑起来

- 修复当前代码和文档里的中文乱码，统一保存为 UTF-8，并检查 `src/shared/i18n/index.ts`、页面内中文文案和 `docs/current-architecture-flowcharts.md`。
- 补齐生产级登录和租户体系。数据库已有 `organizations`、`users`、`roles`、`organization_memberships`，但当前本地应用仍主要使用 `Default Organization`。
- 加密 Etsy refresh token，避免明文长期存储。
- 生产环境强制校验 `ETSY_WEBHOOK_SECRET`，拒绝未签名或签名错误的 webhook。
- 配置独立 cron / worker 调度，让 `/api/sync/cron` 和 `/api/sync/jobs` 按固定频率运行。
- 为 OAuth、同步队列、Listing 写回、ERP 归一化和关键页面补测试。
- 增加同步任务监控和告警：失败任务、重试次数、最近同步时间、API 限流和 webhook 堆积。

### P1：通过表格控制 Listing 编辑

- 把 `Listing Sheet` 做成主要操作台，不只是展示列表，而是可以直接控制 Etsy Listing 的编辑和保存。
- 支持编辑核心字段：标题、描述、价格、库存、状态、SKU、标签、材料、分类、物流模板、店铺分组、图片、变体和 inventory JSON。
- 每一行都要有清晰状态：未修改、已修改、校验失败、保存中、保存成功、保存失败。
- 单行保存和批量保存都要可用，失败时要能定位到具体行、具体字段和 Etsy 返回的错误原因。
- 保存前做本地校验，保存时调用 Etsy `updateListing`、`updateListingInventory`、`uploadListingImage` 等接口，成功后同步更新本地数据库。
- 对需要完整 inventory 结构的字段做差异预览，避免只改价格或库存时破坏 Etsy 变体、offerings、property values。
- 增加撤销/恢复原值能力，避免误改后只能靠重新同步修复。

### P2：通过多维表格批量编辑

- 设计一套多维表格字段模型，把 Etsy Listing 字段映射成可批量维护的列。
- 支持从多维表格读取 Listing 编辑数据，并把读取结果映射到 `Listing Sheet` 的行数据。
- 支持批量填充、批量替换、批量生成 SKU、批量改价格、批量改库存、批量上架/下架、批量补齐标签和材料。
- 支持按状态、分类、库存、缺失 SKU、低库存、最近修改时间等维度筛选后批量操作。
- 批量提交前必须有差异预览：显示将修改哪些 Listing、哪些字段、旧值和新值。
- 批量提交要有逐行结果回写：成功、失败、跳过、错误详情和重试入口。
- 多维表格写入外部文档前保留人工确认，不自动改用户文档。

### P3：实现数据看板

- Dashboard 要成为真正的数据看板，而不是简单指标卡片。
- 核心指标包括：销售额、订单数、客单价、Listing 数、活跃 Listing、库存总量、低库存数量、浏览量、收藏量、转化率。
- 支持时间范围切换：近 7 天、近 30 天、本月、本季度、本年，并支持和上一周期对比。
- 支持按店铺、Listing 状态、商品、SKU、订单状态筛选。
- 图表至少包括：销售趋势、订单趋势、Top Listing、低库存 Listing、订单状态分布、最近出单商品。
- 看板读取本地 PostgreSQL / ERP Snapshot，不让前端直接轮询 Etsy。
- 每个指标都要显示数据更新时间和同步状态，避免用户误把过期数据当实时数据。

### P4：体验、验证和交付

- 为表格编辑和数据看板补齐搜索、筛选、分页、空状态和加载状态。
- 给 Listing 写回、批量编辑、同步任务、数据看板指标补测试。
- 增加操作审计日志，记录谁改了 Listing、SKU、库存、价格、状态和批量任务。
- 增加部署清单：环境变量、数据库迁移、cron 配置、webhook 地址、HTTPS、密钥轮换。
- 整理开发文档：本地启动、数据库初始化、常用脚本、同步排障、Etsy 权限说明、表格字段说明。

## 常用命令

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm run db:migrate
npm run db:backfill:erp
npm run db:setup:erp
```

Windows 本机也可以使用：

```powershell
.\dev.cmd
```
