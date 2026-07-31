# 当前项目数据结构与后台展示流程图

本文按当前代码结构整理，核心结论是：

- 应用是 Next.js 后台系统，页面在 `src/app/*/page.tsx`，服务端 API 在 `src/app/api/*/route.ts`。
- 数据先进入 Etsy 原始同步层 `etsy_*` 表，再尝试归一化到平台无关的 ERP 表。
- 当前后台页面主要通过 `readStore()` 读取 `etsy_*` 原始同步层并组装成 `selectedShop` 展示。
- ERP 表已经具备商品、库存、订单、客户、多渠道账号的结构，后续可以逐步把页面改为直接读取 ERP 查询函数。

## 1. 项目实现分层

```mermaid
flowchart TB
  Browser["浏览器后台页面"] --> AppPages["src/app 页面<br/>dashboard / products / orders / settings"]
  Browser --> ApiRoutes["src/app/api API 路由<br/>etsy / sync"]

  AppPages --> AppShell["src/components/app-shell.tsx<br/>后台框架、导航、店铺切换"]
  AppPages --> Workspace["src/features/workspace/workspace.ts<br/>解析 lang / shopId / selectedShop"]
  Workspace --> Store["src/lib/store.ts<br/>readStore / writeStore / selectShop"]

  ApiRoutes --> EtsyOAuth["src/features/etsy/oauth.ts<br/>OAuth token / refresh"]
  ApiRoutes --> EtsyClient["src/features/etsy/client.ts<br/>Etsy Open API client"]
  ApiRoutes --> SyncProcessor["src/features/sync/processor.ts<br/>任务编排与执行"]

  Store --> SyncDb["src/features/sync/db.ts<br/>Etsy 原始表、任务队列、状态读取"]
  SyncProcessor --> SyncDb
  SyncDb --> ErpDb["src/features/erp/db.ts<br/>ERP 归一化与后台查询"]

  SyncDb --> Postgres["PostgreSQL"]
  ErpDb --> Postgres
  Store -.无数据库时兜底.-> FileStore["data/app.json"]

  Shared["src/shared<br/>types / format / i18n"] --> AppPages
  Shared --> SyncDb
  Shared --> ErpDb
```
## 2. 当前数据库结构总览

### 2.1 Etsy 原始同步层

这层更接近 Etsy API 返回值，负责保留外部平台数据、同步游标、任务状态和新订单角标。

```mermaid
erDiagram
  etsy_shops ||--o{ etsy_listings : has
  etsy_shops ||--o{ etsy_receipts : has
  etsy_shops ||--o{ etsy_receipt_transactions : has
  etsy_shops ||--o{ etsy_shipments : has
  etsy_shops ||--o{ etsy_sync_jobs : queues
  etsy_shops ||--o{ etsy_sync_cursors : tracks
  etsy_shops ||--|| etsy_shop_ui_state : shows
  etsy_receipts ||--o{ etsy_receipt_transactions : contains
  etsy_receipts ||--o{ etsy_shipments : ships

  etsy_shops {
    bigint shop_id PK
    text user_id
    text shop_name
    jsonb connection
    jsonb shop_data
    boolean active
    timestamptz last_sync_at
  }

  etsy_listings {
    bigint shop_id FK
    bigint listing_id PK
    text title
    text state
    integer quantity
    numeric price_amount
    jsonb data
  }

  etsy_receipts {
    bigint shop_id FK
    bigint receipt_id PK
    text status
    text buyer_name
    boolean is_paid
    boolean is_shipped
    numeric grandtotal_amount
    jsonb data
  }

  etsy_receipt_transactions {
    bigint shop_id FK
    bigint receipt_id
    bigint transaction_id PK
    bigint listing_id
    text sku
    integer quantity
    numeric price_amount
    jsonb data
  }

  etsy_sync_jobs {
    bigint id PK
    bigint shop_id FK
    text job_type
    jsonb payload
    text status
    integer attempts
    timestamptz run_after
  }

  etsy_webhook_events {
    bigint id PK
    text webhook_id
    text event_type
    bigint shop_id
    jsonb payload
    text status
  }
```

### 2.2 ERP 业务结构层

这层是平台无关结构，未来可以同时接 Etsy、eBay、Shopify 等渠道。

```mermaid
erDiagram
  organizations ||--o{ channel_accounts : owns
  sales_channels ||--o{ channel_accounts : provides
  channel_accounts ||--|| channel_credentials : stores
  channel_accounts ||--o{ orders : receives

  organizations ||--o{ products : owns
  products ||--o{ product_variants : has
  products ||--o{ skus : has
  product_variants ||--o{ skus : maps
  skus ||--o{ inventory_balances : stocked_as
  skus ||--o{ inventory_movements : moves
  skus ||--o{ inventory_reservations : reserves
  locations ||--o{ inventory_balances : holds

  organizations ||--o{ customers : owns
  customers ||--o{ orders : places
  orders ||--o{ order_items : contains
  orders ||--o{ order_payments : paid_by
  orders ||--o{ order_fulfillments : fulfilled_by
  orders ||--o{ order_financial_lines : explains
  order_items ||--o{ order_financial_lines : may_have

  external_entity_mappings }o--|| sales_channels : channel
  external_entity_mappings }o--|| channel_accounts : account

  organizations {
    bigint id PK
    text name
    text slug
    text status
  }

  sales_channels {
    bigint id PK
    text code
    text name
  }

  channel_accounts {
    bigint id PK
    bigint organization_id FK
    bigint channel_id FK
    text external_account_id
    text display_name
    text status
  }

  products {
    bigint id PK
    bigint organization_id FK
    text title
    text status
    jsonb source_data
  }

  skus {
    bigint id PK
    bigint organization_id FK
    bigint product_id FK
    bigint variant_id FK
    text sku_code
    text title
  }

  inventory_balances {
    bigint id PK
    bigint sku_id FK
    bigint location_id FK
    numeric on_hand
    numeric reserved
    numeric available
  }

  orders {
    bigint id PK
    bigint organization_id FK
    bigint channel_account_id FK
    bigint customer_id FK
    text order_number
    text payment_status
    text fulfillment_status
    numeric total_amount
  }

  order_items {
    bigint id PK
    bigint order_id FK
    bigint sku_id FK
    text external_line_item_id
    numeric quantity
    numeric total_amount
  }

  external_entity_mappings {
    bigint id PK
    bigint internal_entity_id
    text internal_entity_type
    text external_entity_type
    text external_entity_id
  }
```

### 2.3 Etsy 到 ERP 的映射关系

```mermaid
flowchart LR
  EtsyShop["Etsy shop"] --> ChannelAccount["channel_accounts<br/>渠道账号"]
  EtsyListing["Etsy listing"] --> Product["products<br/>商品"]
  EtsyListing --> Variant["product_variants<br/>变体"]
  EtsyListing --> Sku["skus<br/>SKU"]
  EtsyListing --> Inventory["inventory_balances<br/>库存"]

  EtsyReceipt["Etsy receipt"] --> Customer["customers<br/>客户"]
  EtsyReceipt --> Order["orders<br/>订单"]
  EtsyReceipt --> Financial["order_financial_lines<br/>金额拆分"]
  EtsyTransaction["Etsy transaction"] --> OrderItem["order_items<br/>订单行"]

  ChannelAccount --> Mapping["external_entity_mappings<br/>外部 ID 与内部 ID 映射"]
  Product --> Mapping
  Variant --> Mapping
  Sku --> Mapping
  Customer --> Mapping
  Order --> Mapping
  OrderItem --> Mapping
```

## 3. 数据同步写入流程

### 3.1 首次连接 Etsy

```mermaid
sequenceDiagram
  actor User as 用户
  participant UI as 后台 Settings/AppShell
  participant Connect as /api/etsy/connect
  participant Etsy as Etsy OAuth
  participant Callback as /api/etsy/callback
  participant Store as src/lib/store.ts
  participant SyncDb as sync/db.ts
  participant Processor as sync/processor.ts
  participant EtsyApi as Etsy Open API
  participant Erp as erp/db.ts
  participant DB as PostgreSQL

  User->>UI: 点击 Connect Etsy Shop
  UI->>Connect: GET /api/etsy/connect
  Connect->>Etsy: 跳转 OAuth + PKCE
  Etsy->>Callback: 带 code/state 回调
  Callback->>Etsy: exchangeAuthorizationCode
  Callback->>EtsyApi: getShopByOwnerUserId
  Callback->>Store: updateStore(upsertShop)
  Store->>SyncDb: upsertShopData
  SyncDb->>DB: 写 etsy_shops / etsy_shop_ui_state
  SyncDb->>Erp: ensureErpAccountForShop
  Erp->>DB: 写 organizations / sales_channels / channel_accounts / credentials
  Callback->>SyncDb: enqueueSyncJob(sync_shop_full)
  Callback->>Processor: processSyncJobById
  Processor->>EtsyApi: 拉 shop / listings / receipts / transactions
  Processor->>SyncDb: upsertListings / upsertReceipts / upsertTransactions
  SyncDb->>DB: 写 etsy_* 原始表
  SyncDb->>Erp: normalizeListings/Receipts/TransactionsToErp
  Erp->>DB: 写 products / skus / inventory / customers / orders
  Callback-->>UI: 跳回后台
```

### 3.2 Webhook、定时任务、手动同步

```mermaid
flowchart TB
  EtsyWebhook["Etsy Webhook<br/>/api/etsy/webhook"] --> RecordEvent["recordWebhookEvent<br/>写 etsy_webhook_events"]
  Cron["定时同步<br/>/api/sync/cron"] --> EnqueueScheduled["enqueueScheduledSyncJobs"]
  Manual["手动同步<br/>/api/etsy/sync"] --> EnqueueManual["enqueueManualSyncJobs"]
  Worker["队列 Worker<br/>/api/sync/jobs"] --> ProcessBatch["processSyncJobs"]

  RecordEvent --> EnqueueJob["enqueueSyncJob"]
  EnqueueScheduled --> EnqueueJob
  EnqueueManual --> EnqueueJob
  EnqueueJob --> Queue["etsy_sync_jobs<br/>queued"]
  Queue --> Claim["claimSyncJobs / claimSyncJobById<br/>running"]
  ProcessBatch --> Claim

  Claim --> JobType{"job_type"}
  JobType --> Full["sync_shop_full<br/>全量：shop/listings/receipts/details"]
  JobType --> Listings["sync_listings<br/>拉 active listings"]
  JobType --> Receipts["sync_receipts_incremental<br/>按 cursor + 2 小时回看"]
  JobType --> Detail["sync_receipt_detail<br/>拉单个 receipt + transactions"]

  Full --> UpsertRaw["upsert 到 etsy_* 原始表"]
  Listings --> UpsertRaw
  Receipts --> UpsertRaw
  Detail --> UpsertRaw

  UpsertRaw --> Normalize["normalize 到 ERP 表<br/>失败时只跳过 ERP，不影响原始同步"]
  Normalize --> Complete["completeSyncJob / failSyncJob"]
```

## 4. 后台展示流程

### 4.1 页面读取和渲染

```mermaid
flowchart TB
  Request["访问后台页面<br/>/dashboard /products /orders /settings"] --> Page["对应 page.tsx"]
  Page --> Workspace["getWorkspace(searchParams)"]
  Workspace --> Params["解析 lang / shopId"]
  Workspace --> Store["readStore()"]

  Store --> HasDb{"存在 DATABASE_URL?"}
  HasDb -->|是| ReadDb["readDatabaseStore(pool)"]
  HasDb -->|否| ReadFile["读取 data/app.json"]
  ReadDb --> SyncTables["查询 etsy_shops / listings / receipts / transactions / ui_state"]
  SyncTables --> AppStore["组装 AppStore<br/>shops / activeShop / listings / receipts / orderDetails"]
  ReadFile --> AppStore

  AppStore --> SelectShop["selectShop(store, shopId)"]
  SelectShop --> AppShell["AppShell<br/>左侧导航、店铺树、新订单角标"]
  SelectShop --> Dashboard["Dashboard<br/>收入、订单、趋势、热销商品"]
  SelectShop --> Products["Products<br/>Listing、库存、收藏、编辑入口"]
  SelectShop --> Orders["Orders<br/>Receipt、交易明细"]
  SelectShop --> Settings["Settings<br/>连接、队列、运行状态"]
```

### 4.2 各后台页面用到的数据

```mermaid
flowchart LR
  SelectedShop["selectedShop<br/>来自 readStore/readDatabaseStore"] --> DashboardPage["/dashboard"]
  SelectedShop --> ProductsPage["/products"]
  SelectedShop --> OrdersPage["/orders"]
  SelectedShop --> SettingsPage["/settings"]

  DashboardPage --> DashboardVm["dashboard/view-model.ts<br/>buildChartBars / recentlyOrderedListings"]
  DashboardPage --> CommerceMetrics["shared/format/commerce.ts<br/>shopMetrics / topListings"]

  ProductsPage --> ProductRows["productRows / lowStockListings / topListings"]
  ProductsPage --> ListingForm["ListingForm<br/>新增/编辑 Listing"]
  ListingForm --> ListingActions["products/listing-actions.ts<br/>createEtsyListingAction / updateEtsyListingAction"]

  OrdersPage --> OrdersVm["orders/view-model.ts<br/>buildOrdersViewModel"]
  OrdersPage --> MarkSeen["markShopOrdersSeen<br/>清空新订单角标"]

  SettingsPage --> SyncStatus["getSyncStatus<br/>队列和 webhook 状态"]
  SettingsPage --> EnvStatus["getEnv / getDatabaseUrl<br/>运行配置状态"]
```

## 5. 商品写回 Etsy 流程

```mermaid
sequenceDiagram
  actor User as 用户
  participant Products as /products 页面
  participant Action as products/listing-actions.ts
  participant Store as readStore/selectShop
  participant SyncDb as sync/db.ts
  participant EtsyOAuth as ensureFreshConnection
  participant EtsyApi as EtsyClient
  participant Erp as erp/db.ts
  participant DB as PostgreSQL

  User->>Products: 新增或编辑 Listing 表单
  Products->>Action: createEtsyListingAction / updateEtsyListingAction
  Action->>Store: 确认 selectedShop
  Action->>SyncDb: getShopConnection
  Action->>EtsyOAuth: token 快过期则 refresh
  Action->>EtsyApi: createDraftListing / updateListing
  Action->>EtsyApi: uploadListingImage / updateListingInventory
  Action->>SyncDb: upsertListings
  SyncDb->>DB: 写 etsy_listings
  SyncDb->>Erp: normalizeListingsToErp
  Erp->>DB: 更新 products / variants / skus / inventory
  Action-->>Products: redirect 回 /products，显示成功或失败提示
```

## 6. 当前可以继续优化的方向

```mermaid
flowchart TB
  Current["当前后台读取 etsy_* 原始同步层"] --> Step1["保留 readStore 兼容层"]
  Step1 --> Step2["逐步把 Dashboard 指标改为 getDashboardMetrics"]
  Step2 --> Step3["Products 页面改为 getProductList + ERP SKU/库存"]
  Step3 --> Step4["Orders 页面改为 getOrderList + order_items"]
  Step4 --> Step5["新增真正多平台视图<br/>Etsy / eBay / Shopify 共用 ERP 表"]
```
