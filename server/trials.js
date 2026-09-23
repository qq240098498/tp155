// 版本化试算
// - 运单按「所属时刻」（创建时刻）生效的规则版本试算
// - 已出账账单金额冻结，这里只做只读重算对比，不改账单
// - 任选两版对同一批运单试算，给出逐项与合计差额及原因
const { badRequest, notFound } = require('./errors');
const { load } = require('./store');
const pricing = require('./pricing');
const zonesSvc = require('./zones');
const { findCustomer } = require('./customers');
const ruleVersions = require('./ruleVersions');

function findWaybill(data, id) {
  return data.waybills.find((waybill) => waybill.id === id) || null;
}

// 账期口径与出账保持一致：按运单创建时刻的年月（UTC）
function periodOf(waybill) {
  const date = new Date(String(waybill.createdAt || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 7);
}

// 用某一版快照拼出计费上下文：价格取快照，城市归属取当前登记（城市归属不是价格项，不进版本）
function contextOfVersion(data, versionRecord) {
  const priceById = new Map((versionRecord.snapshot.zones || []).map((zone) => [zone.id, zone]));
  const ctxZones = data.zones
    .map((live) => {
      const price = priceById.get(live.id);
      if (!price) return null;
      return Object.assign({}, live, {
        firstWeightKg: price.firstWeightKg,
        firstPriceYuan: price.firstPriceYuan,
        addUnitKg: price.addUnitKg,
        addPriceYuan: price.addPriceYuan,
        remoteFeeYuan: price.remoteFeeYuan,
      });
    })
    .filter(Boolean);
  // 快照里有、当前已删除的分区：没有城市登记，只在显式按 id 找时才用得到
  priceById.forEach((price, id) => {
    if (!data.zones.some((live) => live.id === id)) {
      ctxZones.push(Object.assign({ cities: [], aliases: {}, status: '启用' }, price));
    }
  });
  return { settings: Object.assign({}, versionRecord.snapshot.settings), zones: ctxZones };
}

// 在指定上下文里给单条运单计费
function quoteInContext(data, waybill, ctx, customer) {
  const cust = customer || findCustomer(data, waybill.customerId);
  const zone = zonesSvc.zoneOfCity({ zones: ctx.zones }, waybill.toCity);
  if (!zone) {
    return { ok: false, reason: '收件城市「' + waybill.toCity + '」在这一版规则下没有可计费的分区' };
  }
  const result = pricing.quoteWaybill(waybill, zone, cust, ctx.settings);
  return {
    ok: true,
    zoneId: zone.id,
    zoneName: zone.name,
    billableKg: result.billableKg,
    freightYuan: result.freightYuan,
    surchargeYuan: result.surchargeYuan,
    grossYuan: result.grossYuan,
    discountPermille: result.discountPermille,
    totalYuan: result.totalYuan,
  };
}

function versionBrief(versionRecord) {
  return {
    version: versionRecord.version,
    note: versionRecord.note,
    createdAt: versionRecord.createdAt,
    createdAtText: String(versionRecord.createdAt || '').replace('T', ' ').slice(0, 19),
  };
}

// 与出账口径一致的合单计价：同一版本组内的运单合起来算一次首重续重，再按重量分摊。
// 这样已出账账单的“重算”才与“冻结金额”同口径，差额只来自规则版本变化，不会混入单算/合算的口径差。
function priceConsolidated(data, items, versionRecord, customer) {
  if (!items.length) return { total: 0, per: new Map(), zoneName: '' };
  const ctx = contextOfVersion(data, versionRecord);
  const permille = pricing.discountPermilleOf(customer);
  const zone = items
    .map((waybill) => zonesSvc.zoneOfCity({ zones: ctx.zones }, waybill.toCity))
    .find(Boolean) || null;
  const weights = items.map((waybill) => pricing.billableWeightKg(waybill, ctx.settings));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const freightAll = pricing.freightYuan(zone, totalWeight, ctx.settings);
  const surchargeAll = items.reduce((sum, waybill, index) => (
    sum + pricing.surchargeYuan(zone, waybill, weights[index], ctx.settings)
  ), 0);
  const total = pricing.roundFen((freightAll + surchargeAll) * permille / 1000);
  const per = new Map();
  items.forEach((waybill, index) => {
    const weight = weights[index];
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    const raw = (freightAll * share + pricing.surchargeYuan(zone, waybill, weight, ctx.settings)) * permille / 1000;
    per.set(waybill.id, pricing.roundFen(raw));
  });
  return { total, per, zoneName: zone ? zone.name : '' };
}

// 把一批运单按各自所属时刻版本分组并合单计价，返回总额、逐单金额与分组小计
function priceByEffectiveVersions(data, items, customer) {
  const groupsMap = new Map();
  items.forEach((waybill) => {
    const version = ruleVersions.effectiveVersionAt(data, waybill.createdAt);
    const key = version ? version.version : 0;
    if (!groupsMap.has(key)) groupsMap.set(key, { version, items: [] });
    groupsMap.get(key).items.push(waybill);
  });
  let total = 0;
  const per = new Map();
  const groupTotals = [];
  Array.from(groupsMap.keys()).sort((a, b) => a - b).forEach((key) => {
    const group = groupsMap.get(key);
    const result = group.version
      ? priceConsolidated(data, group.items, group.version, customer)
      : { total: 0, per: new Map(), zoneName: '' };
    total += result.total;
    result.per.forEach((amount, id) => per.set(id, amount));
    groupTotals.push({
      version: group.version ? group.version.version : null,
      waybillCount: group.items.length,
      amountYuan: result.total,
    });
  });
  return { total: pricing.roundFen(total), per, groupTotals };
}

// 从两版差异里挑出对这一单真正起作用的项：全局参数全保留；分区价格只留这一单命中的分区
function relevantChanges(changes, baseZoneId, targetZoneId) {
  return changes.filter((change) => {
    if (change.scope === '全局参数') return true;
    return change.refId === baseZoneId || change.refId === targetZoneId;
  }).map((change) => ({
    scope: change.scope,
    refName: change.refName,
    fieldLabel: change.fieldLabel,
    before: change.before,
    after: change.after,
    changeText: change.scope + (change.refName ? '·' + change.refName : '') + '：' + change.fieldLabel + ' ' +
      (change.before === null || change.before === undefined ? '（无）' : change.before) + ' → ' +
      (change.after === null || change.after === undefined ? '（无）' : change.after),
  }));
}

function resolveVersionPair(data, baseNo, targetNo) {
  const base = ruleVersions.getVersionRecord(data, baseNo);
  const target = ruleVersions.getVersionRecord(data, targetNo);
  if (!base) throw badRequest('VERSION_BASE_NOT_FOUND', '没有第 ' + Number(baseNo) + ' 版规则');
  if (!target) throw badRequest('VERSION_TARGET_NOT_FOUND', '没有第 ' + Number(targetNo) + ' 版规则');
  return { base, target };
}

// 单条运单：按两版并排试算（默认 当时版本 vs 当前最新版）
function trialWaybill(waybillId, options) {
  const data = load();
  const waybill = findWaybill(data, waybillId);
  if (!waybill) throw notFound('WAYBILL_NOT_FOUND', '运单不存在');
  const thenVersion = ruleVersions.effectiveVersionAt(data, waybill.createdAt);
  const sorted = ruleVersions.sortVersions(data.pricingVersions || []);
  const latest = sorted[sorted.length - 1];
  const pair = resolveVersionPair(data,
    options && options.baseVersion ? options.baseVersion : (thenVersion ? thenVersion.version : latest.version),
    options && options.targetVersion ? options.targetVersion : latest.version);

  const customer = findCustomer(data, waybill.customerId);
  const baseCtx = contextOfVersion(data, pair.base);
  const targetCtx = contextOfVersion(data, pair.target);
  const baseQuote = quoteInContext(data, waybill, baseCtx, customer);
  const targetQuote = quoteInContext(data, waybill, targetCtx, customer);
  const changes = ruleVersions.diffSnapshots(pair.base.snapshot, pair.target.snapshot);
  const reasons = relevantChanges(changes,
    baseQuote.ok ? baseQuote.zoneId : null,
    targetQuote.ok ? targetQuote.zoneId : null);

  const baseAmount = baseQuote.ok ? baseQuote.totalYuan : null;
  const targetAmount = targetQuote.ok ? targetQuote.totalYuan : null;
  return {
    waybill: {
      id: waybill.id,
      code: waybill.code,
      customerName: customer ? customer.name : '（客户已删）',
      fromCity: waybill.fromCity,
      toCity: waybill.toCity,
      createdAt: waybill.createdAt,
      createdAtText: String(waybill.createdAt || '').replace('T', ' ').slice(0, 16),
      billId: waybill.billId || null,
      locked: Boolean(waybill.billId),
    },
    thenVersion: thenVersion ? versionBrief(thenVersion) : null,
    base: Object.assign({ label: '按第 ' + pair.base.version + ' 版（' + (pair.base.version === (thenVersion && thenVersion.version) ? '运单所属时刻版本' : '指定版本') + '）' },
      versionBrief(pair.base), baseQuote.ok ? baseQuote : { unquotable: baseQuote.reason }),
    target: Object.assign({ label: '按第 ' + pair.target.version + ' 版（' + (pair.target.version === latest.version ? '当前最新版' : '指定版本') + '）' },
      versionBrief(pair.target), targetQuote.ok ? targetQuote : { unquotable: targetQuote.reason }),
    deltaYuan: baseAmount !== null && targetAmount !== null ? pricing.roundFen(targetAmount - baseAmount) : null,
    reasons,
    sameVersion: pair.base.version === pair.target.version,
  };
}

function parseIdList(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value || '').split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

// 批量：任选两版对同一批运单试算，给出合计差额
function trialBatch(payload) {
  const data = load();
  const sorted = ruleVersions.sortVersions(data.pricingVersions || []);
  const latest = sorted[sorted.length - 1];
  const baseNo = Number((payload && payload.baseVersion) || (latest && latest.version));
  const targetNo = Number((payload && payload.targetVersion) || (latest && latest.version));
  const pair = resolveVersionPair(data, baseNo, targetNo);
  const baseCtx = contextOfVersion(data, pair.base);
  const targetCtx = contextOfVersion(data, pair.target);
  const changes = ruleVersions.diffSnapshots(pair.base.snapshot, pair.target.snapshot);

  let ids = parseIdList(payload && payload.waybillIds);
  if (!ids.length) {
    const customerId = payload ? String(payload.customerId || '').trim() : '';
    const period = String((payload && payload.period) || '').trim();
    const onlyUnbilled = Boolean(payload && payload.onlyUnbilled);
    data.waybills.forEach((waybill) => {
      if (customerId && waybill.customerId !== customerId) return;
      if (period && periodOf(waybill) !== period) return;
      if (onlyUnbilled && waybill.billId) return;
      ids.push(waybill.id);
    });
  }
  if (!ids.length) throw badRequest('TRIAL_NO_WAYBILL', '这个范围里没有可试算的运单，换个客户或账期');

  const unquotable = [];
  const lines = ids.map((id) => {
    const waybill = findWaybill(data, id);
    if (!waybill) return null;
    const customer = findCustomer(data, waybill.customerId);
    const bq = quoteInContext(data, waybill, baseCtx, customer);
    const tq = quoteInContext(data, waybill, targetCtx, customer);
    if (!bq.ok) unquotable.push({ waybillId: id, code: waybill.code, side: 'base', reason: bq.reason });
    if (!tq.ok) unquotable.push({ waybillId: id, code: waybill.code, side: 'target', reason: tq.reason });
    const reasons = relevantChanges(changes, bq.ok ? bq.zoneId : null, tq.ok ? tq.zoneId : null);
    return {
      waybillId: id,
      code: waybill.code,
      customerName: customer ? customer.name : '（客户已删）',
      toCity: waybill.toCity,
      createdAt: waybill.createdAt,
      createdAtText: String(waybill.createdAt || '').replace('T', ' ').slice(0, 16),
      billId: waybill.billId || null,
      baseZoneName: bq.ok ? bq.zoneName : '',
      targetZoneName: tq.ok ? tq.zoneName : '',
      baseBillableKg: bq.ok ? bq.billableKg : null,
      targetBillableKg: tq.ok ? tq.billableKg : null,
      baseAmountYuan: bq.ok ? bq.totalYuan : null,
      targetAmountYuan: tq.ok ? tq.totalYuan : null,
      deltaYuan: bq.ok && tq.ok ? pricing.roundFen(tq.totalYuan - bq.totalYuan) : null,
      reasons: reasons.map((item) => item.changeText),
    };
  }).filter(Boolean);

  const baseTotal = pricing.roundFen(lines.reduce((sum, line) => sum + (line.baseAmountYuan || 0), 0));
  const targetTotal = pricing.roundFen(lines.reduce((sum, line) => sum + (line.targetAmountYuan || 0), 0));
  return {
    base: versionBrief(pair.base),
    target: versionBrief(pair.target),
    sameVersion: pair.base.version === pair.target.version,
    total: lines.length,
    unquotable,
    baseAmountYuan: baseTotal,
    targetAmountYuan: targetTotal,
    deltaYuan: pricing.roundFen(targetTotal - baseTotal),
    lines,
    changes: changes.map((change) => ({
      scope: change.scope, refName: change.refName, fieldLabel: change.fieldLabel,
      before: change.before, after: change.after,
      changeText: change.scope + (change.refName ? '·' + change.refName : '') + '：' + change.fieldLabel + ' ' +
        (change.before === null || change.before === undefined ? '（无）' : change.before) + ' → ' +
        (change.after === null || change.after === undefined ? '（无）' : change.after),
    })),
  };
}

// 已出账账单的只读核对：冻结金额 vs 按当时版本重算（合单口径）vs 按当前版本重算（合单口径）
function compareBill(bill, data) {
  const sorted = ruleVersions.sortVersions(data.pricingVersions || []);
  const latest = sorted[sorted.length - 1];
  const customer = findCustomer(data, bill.customerId);
  const frozenLines = Array.isArray(bill.lines) ? bill.lines : [];
  const frozenById = new Map(frozenLines.map((line) => [line.waybillId, line]));

  const present = (bill.waybillIds || [])
    .map((id) => findWaybill(data, id))
    .filter(Boolean);

  // 按各运单所属时刻版本分组合单（与现在出账口径一致）
  const thenPriced = priceByEffectiveVersions(data, present, customer);
  // 全部按当前最新版合单（等价于“现在重新出一张账会是多少钱”）
  const currentPriced = priceConsolidated(data, present, latest, customer);

  const reasonsByLine = new Map();
  present.forEach((waybill) => {
    const thenVersion = ruleVersions.effectiveVersionAt(data, waybill.createdAt) || sorted[0];
    const changes = ruleVersions.diffSnapshots(thenVersion.snapshot, latest.snapshot);
    const thenCtx = contextOfVersion(data, thenVersion);
    const latestCtx = contextOfVersion(data, latest);
    const zThen = zonesSvc.zoneOfCity({ zones: thenCtx.zones }, waybill.toCity);
    const zNow = zonesSvc.zoneOfCity({ zones: latestCtx.zones }, waybill.toCity);
    reasonsByLine.set(waybill.id, relevantChanges(changes, zThen ? zThen.id : null, zNow ? zNow.id : null));
  });

  const lines = (bill.waybillIds || []).map((id) => {
    const waybill = findWaybill(data, id);
    const frozen = frozenById.get(id);
    if (!waybill) {
      return {
        waybillId: id, code: frozen ? frozen.code : id, missing: true,
        billedAmountYuan: frozen ? Number(frozen.amountYuan || 0) : null,
        thenAmountYuan: null, currentAmountYuan: null,
        deltaThenVsCurrent: null, deltaBilledVsThen: null, reasons: [],
      };
    }
    const thenVersion = ruleVersions.effectiveVersionAt(data, waybill.createdAt) || sorted[0];
    const billed = frozen ? Number(frozen.amountYuan || 0) : null;
    const thenAmount = thenPriced.per.has(id) ? thenPriced.per.get(id) : null;
    const currentAmount = currentPriced.per.has(id) ? currentPriced.per.get(id) : null;
    const reasons = reasonsByLine.get(id) || [];
    return {
      waybillId: id,
      code: waybill.code,
      toCity: waybill.toCity,
      createdAt: waybill.createdAt,
      createdAtText: String(waybill.createdAt || '').replace('T', ' ').slice(0, 16),
      thenVersion: versionBrief(thenVersion),
      billedAmountYuan: billed,
      thenAmountYuan: thenAmount,
      currentAmountYuan: currentAmount,
      deltaThenVsCurrent: thenAmount !== null && currentAmount !== null ? pricing.roundFen(currentAmount - thenAmount) : null,
      deltaBilledVsThen: billed !== null && thenAmount !== null ? pricing.roundFen(thenAmount - billed) : null,
      reasons: reasons.map((item) => item.changeText),
    };
  });

  const billedAmount = pricing.roundFen(Number(bill.amountYuan || 0));
  const thenTotal = thenPriced.total;
  const currentTotal = currentPriced.total;
  const allReasons = new Map();
  reasonsByLine.forEach((list) => list.forEach((reason) => allReasons.set(reason.changeText, reason)));
  return {
    billedAmountYuan: billedAmount,
    thenAmountYuan: thenTotal,
    currentAmountYuan: currentTotal,
    deltaThenVsCurrentYuan: pricing.roundFen(currentTotal - thenTotal),
    deltaBilledVsThenYuan: pricing.roundFen(thenTotal - billedAmount),
    currentVersion: versionBrief(latest),
    thenGroups: thenPriced.groupTotals,
    groups: Array.isArray(bill.pricingVersionGroups) ? bill.pricingVersionGroups : [],
    lines,
    reasons: Array.from(allReasons.values()).map((item) => item.changeText),
    note: '账单金额按出账时规则冻结，不随后续改价变动。重算与出账同为合单分摊口径；冻结金额与当时重算若有尾差，通常来自出账时沿用的单条计费缓存。',
  };
}

module.exports = {
  contextOfVersion,
  quoteInContext,
  trialWaybill,
  trialBatch,
  compareBill,
  findWaybill,
};
