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
- 运单计费：对单条运单算一次费用，按**运单创建时刻生效的规则版本**试算，结果（含所用版本号）记在这条运单上；详情里能把「按当时版本」与「按当前版本」两个结果并排显示，写清差额与原因
- 分区：维护分区编码、名称、覆盖城市与城市别名、首重与续重价格、偏远附加、启用状态；**改动价格（首重/续重/偏远附加）会自动生成一个规则新版本**，只改城市归属或名称不计价、不产生版本
- 客户：维护客户编码、名称、结算方式（月结／现结）、折扣、账期日
- 账单：按账期与客户出账，查看账单总额与逐条明细，可以把账单作废
- 规则版本：查看版本号、生效时刻、来源、说明与每个版本的改动项（改动前→改动后）；查任意时刻在用的是哪一版；调整全局参数即生成新版本；任选两版列差异，并用这两版对同一批运单分别试算、给出金额差异合计与逐单原因

## 规则版本与计费口径

计费规则（全局参数 + 各分区价格）是有版本的：

1. 每次改动价格或参数都固化一版**快照**，记录版本号、生效时刻、来源、说明，以及逐项的改动前/改动后值。升级前的现有价格会固化为 V1 基线，升级前的运单与账单都能追溯到它
2. 某一时刻「在用哪一版」= 生效时刻不晚于该时刻的最新一版。页面可查任意时刻
3. 运单按**所属时刻（创建时刻）**的版本试算；未出账运单正式计费与出账都用它所属时刻的版本
4. 出账时同一账期同一客户的运单按命中版本分组，组内合单算一次首重续重再按重量分摊，组间相加；账单会冻结每条明细的版本号、版本分组与金额
5. **已出账账单金额不许变**，不随后续改价变动。账单详情只读给出三列：账单冻结金额、按当时版本重算、按当前版本重算，并写清差额与原因（冻结与当时重算若有尾差，通常来自出账时沿用的单条计费缓存）
6. 版本对比：任选两版列出差异项，并可对同一批运单（可按客户、账期、是否仅未出账筛选）用两版分别试算，给出合计差额与逐单差额原因

历史计费口径（快照内固化）：

1. 计费重量 = max(实际重量, 体积重量)；体积重量 = 体积(m³) × 1000000 ÷ 体积系数（默认 6000），结果向上取到 0.5kg
2. 首重以内收首重价；超出首重的部分按续重单位向上进位，每个单位收续重价
3. 运费不低于最低收费（默认 8 元）
4. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超过 30kg 或件数达到 3 件，20 元）+ 保价费（保价金额 × 2%）
5. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；金额以元为单位，页面保留两位小数
6. 账期按运单创建时刻所在的月份归集；运单进账单之后会被锁定，不能再直接删改

## 目录

```
server/index.js        服务入口
server/api.js          接口路由与错误处理
server/store.js        数据读写（含 V1 基线迁移）
server/pricing.js      计费口径（纯计算）
server/ruleVersions.js 规则版本：快照、生效版本、建版、两版差异
server/trials.js       版本化试算：单运单对比、批量两版试算、账单只读核对
server/zones.js        分区与城市归属（改价自动建版）
server/customers.js    客户
server/waybills.js     运单与单条计费（按所属时刻版本）
server/bills.js        出账与账单（按版本分组、金额冻结）
public/                页面
data/db.json           数据（pricingVersions 存版本快照）
```

## 接口一览

```
GET    /api/health
GET    /api/summary
GET    /api/settings             PATCH /api/settings            # 参数变化即生成新版本
GET    /api/zones                POST /api/zones      PATCH|DELETE /api/zones/:id
GET    /api/customers            POST /api/customers  PATCH|DELETE /api/customers/:id
GET    /api/waybills             POST /api/waybills   PATCH|DELETE /api/waybills/:id
POST   /api/waybills/:id/quote
GET    /api/pricing/versions                                   # 版本列表
GET    /api/pricing/versions/:version                          # 某一版（含改动项与前后值）
GET    /api/pricing/effective?time=2026-09-01T10:30            # 任意时刻生效版本
GET    /api/pricing/diff?base=1&target=2                       # 两版差异项
GET    /api/pricing/trial-waybill/:id?baseVersion=&targetVersion=  # 单运单两版并排试算
POST   /api/pricing/compare                                    # 同批运单两版试算合计
GET    /api/bills                GET /api/bills/:id             # 详情含版本分组与三列核对
POST   /api/bills/generate       POST /api/bills/:id/void
GET    /api/periods
```

出账入参：`{ "period": "2026-09", "customerId": "cust-0001" }`

两版批量试算入参：`{ "baseVersion": 1, "targetVersion": 2, "customerId": "cust-0001", "period": "2026-09", "onlyUnbilled": true }`（客户、账期可省略表示全部；waybillIds 可显式指定）
