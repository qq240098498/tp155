# 运单计费与账单核对台

面向物流结算岗位的运单计费与账单核对工具。运单录进来，按分区与重量口径算出运费与附加费，按月出账，出账之后要能核对账单总额与逐单明细是否对得上。

## 怎么跑

```
npm install
npm start
```

启动后打开 http://localhost:5150 。数据存在 `data/db.json`，页面上的改动会直接写回这个文件。

## 页面能做什么

- 概览：分区、客户、运单、账单的数量与金额合计，运单状态分布，已有账期，未归属城市的运单数，当前生效的规则版本
- 运单：登记与维护运单（客户、寄件城市、收件城市、实际重量、体积、件数、保价金额、附加服务、状态、创建时刻），支持按关键词、客户、状态筛选，可以只看收件城市还没归属分区的运单
- 运单计费：对单条运单按**创建时刻生效的规则版本**算一次费用，结果与所用版本号会记在这条运单上；详情里把「按当时版本」与「按当前最新版本」两个结果并排显示，写清差额与原因
- 分区：维护分区编码、名称、覆盖城市与城市别名、首重与续重价格、偏远附加、启用状态。**改动首重/续重/偏远价会自动生成一个新版本**；只改覆盖城市、别名、名称、状态不发版
- 客户：维护客户编码、名称、结算方式（月结／现结）、折扣、账期日
- 规则：版本链管理。查看每个版本的版本号、生效时刻、改动项及改动前后的值；输入任意时刻查询当时在用哪一版；任选两版列出差异项，并用这两版分别试算同一批运单（全部／未出账／按客户／按账期），给出逐单金额、差额、原因与差额合计
- 账单：按账期与客户出账，未出账运单一律按**所属时刻（运单创建时刻）生效的版本**试算；账单金额出账即锁定，之后改价不变动。账单详情并排显示「出账锁定金额／按当时版本重算／按当前版本重算」，逐单写清差额与原因；账单可以作废

## 计费口径

1. 计费重量 = max(实际重量, 体积重量)；体积重量 = 体积(m³) × 1000000 ÷ 体积系数（默认 6000），结果向上取到 0.5kg
2. 首重以内收首重价；超出首重的部分按续重单位向上进位，每个单位收续重价
3. 运费不低于最低收费（默认 8 元）
4. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超过 30kg 或件数达到 3 件，20 元）+ 保价费（保价金额 × 2%）
5. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；金额以元为单位，页面保留两位小数
6. 账期按运单创建时刻所在的月份归集；运单进账单之后会被锁定，不能再直接删改
7. 规则按版本生效：每条运单取其创建时刻生效的版本；同一张账单里跨版本/跨分区的运单分组试算后按计费重量分摊运费。已出账账单金额不随后续版本变化，仅提供重算差额供核对

## 规则版本

- 每个版本记录：版本号、生效时刻、登记时刻、改动说明、全局参数与分区价目的完整快照、相对上一版的改动项（改动前后的值）
- 版本化之前的历史数据在首次启动时自动补一条 **v1 基线版本**（生效时刻 2026-01-01），所有历史运单都有版本可依
- 新版本的生效时刻必须晚于上一版；不指定时立即生效
- 参数与上一版完全相同时不会发版（接口返回 PRICING_NO_CHANGE）
- 分区新增/删除（价目集合变化）同样会生成版本

## 目录

```
server/index.js     服务入口
server/api.js       接口路由与错误处理
server/store.js     数据读写（含 v1 基线版本迁移）
server/pricing.js   计费口径、版本快照、差异对比、按版本试算
server/versions.js  规则版本发布/查询/对比
server/zones.js     分区与城市归属（改价自动发版）
server/customers.js 客户
server/waybills.js  运单与单条计费（按创建时刻版本）
server/bills.js     出账（按当时版本并锁定）与账单重算对比
public/             页面
data/db.json        数据
```

## 接口一览

```
GET    /api/health
GET    /api/summary
GET    /api/settings             PATCH /api/settings        （改动参数自动生成新版本）
GET    /api/zones                POST /api/zones      PATCH|DELETE /api/zones/:id
GET    /api/customers            POST /api/customers  PATCH|DELETE /api/customers/:id
GET    /api/waybills             POST /api/waybills   PATCH|DELETE /api/waybills/:id
POST   /api/waybills/:id/quote
GET    /api/bills                GET /api/bills/:id
POST   /api/bills/generate       POST /api/bills/:id/void
GET    /api/periods

GET    /api/pricing-versions                       版本链（新→旧）
GET    /api/pricing-versions/effective?at=时刻      查询任意时刻在用版本
GET    /api/pricing-versions/diff?a=1&b=2          两版差异项
GET    /api/pricing-versions/:no                   版本详情（含完整快照）
POST   /api/pricing-versions/publish               发布新版本（全局参数）
POST   /api/pricing-versions/compare-trial         用两版分别试算同一批运单
```

发版入参（`/publish` 与 `PATCH /settings` 通用）：

```json
{ "minChargeYuan": 10, "oversizeFeeYuan": 25, "reason": "旺季调价", "effectiveAt": "2026-10-01 00:00" }
```

`effectiveAt` 省略即立即生效；只传要改的参数，没有变化会被拒绝。

双版试算入参：

```json
{ "versionA": 1, "versionB": 2, "unbilledOnly": true }
```

范围四选一：`unbilledOnly: true`（全部未出账）、`{}`（全部）、`{"customerId":"cust-0001"}`、`{"period":"2026-09"}`，也可直接传 `waybillIds: ["wb-0001"]`。

出账入参：`{ "period": "2026-09", "customerId": "cust-0001" }`
