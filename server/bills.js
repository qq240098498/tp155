const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const { findCustomer } = require('./customers');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

// 账单里的分区判断与运单页保持一致：别名优先，再看直接登记的城市，找不到返回 null
function zoneOf(data, city) {
  return zones.zoneOfCity(data, city);
}

// 账期：按运单创建时刻的年月
function periodOf(waybill) {
  const date = new Date(String(waybill.createdAt || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 7);
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 把一组运单按「版本 + 分区」归组，组内合起来算一次首重续重，再按计费重量分摊运费。
// versionPicker 决定每条运单使用哪一版：出账/当时重算用创建时刻生效版，当前重算用最新版。
function priceWithVersions(data, customer, list, versionPicker) {
  const permille = pricing.discountPermilleOf(customer);
  const groups = new Map();
  const meta = new Map();

  list.forEach((waybill) => {
    const zone = zoneOf(data, waybill.toCity);
    const version = versionPicker(waybill);
    if (!zone || !version) {
      meta.set(waybill.id, { zone, version: version || null, missing: true });
      return;
    }
    const snapshot = { settings: version.snapshot.settings, zones: version.snapshot.zones || [] };
    const zonePrice = pricing.zonePriceInSnapshot(snapshot, zone);
    if (!zonePrice) {
      meta.set(waybill.id, { zone, version, missing: true });
      return;
    }
    const billableKg = pricing.billableWeightKg(waybill, snapshot.settings);
    meta.set(waybill.id, { zone, version, zonePrice, snapshot, billableKg, missing: false });
    const key = 'v' + version.versionNo + '|z' + zone.id;
    if (!groups.has(key)) {
      groups.set(key, { version, zone, zonePrice, snapshot, members: [] });
    }
    groups.get(key).members.push({ waybill, billableKg });
  });

  const result = new Map();
  groups.forEach((group) => {
    const settings = group.snapshot.settings;
    const totalWeight = group.members.reduce((sum, item) => sum + item.billableKg, 0);
    const freightAll = pricing.freightYuan(group.zonePrice, totalWeight, settings);
    group.members.forEach((member) => {
      const waybill = member.waybill;
      const surcharge = pricing.surchargeYuan(group.zonePrice, waybill, member.billableKg, settings);
      const share = totalWeight > 0 ? member.billableKg / totalWeight : 0;
      const raw = (freightAll * share + surcharge) * permille / 1000;
      result.set(waybill.id, {
        billableKg: member.billableKg,
        freightYuan: pricing.roundFen(freightAll * share * permille / 1000),
        surchargeYuan: pricing.roundFen(surcharge * permille / 1000),
        amountYuan: pricing.roundFen(raw),
        versionNo: group.version.versionNo,
        versionEffectiveAt: group.version.effectiveAt,
        zoneId: group.zone.id,
        zoneName: group.zonePrice.name || group.zone.name,
        missing: false,
      });
    });
  });

  const missing = [];
  meta.forEach((info, waybillId) => {
    if (info.missing) {
      const waybill = list.find((item) => item.id === waybillId);
      missing.push({
        waybillId,
        code: waybill ? waybill.code : '',
        zoneKnown: Boolean(info.zone),
        versionNo: info.version ? info.version.versionNo : null,
      });
    }
  });
  return { lines: result, missing, permille };
}

function sumLines(lineMap) {
  let sum = 0;
  lineMap.forEach((line) => { if (!line.missing) sum += Number(line.amountYuan || 0); });
  return pricing.roundFen(sum);
}

// 出账计费：未出账运单一律按各自创建时刻生效的版本试算，金额随账单锁定
function priceBill(data, customer, list) {
  if (list.length === 0) return { lines: [], amountYuan: 0, permille: pricing.discountPermilleOf(customer), versionNos: [] };
  const thenPicker = (waybill) => pricing.effectiveVersionAt(data, waybill.createdAt);
  const priced = priceWithVersions(data, customer, list, thenPicker);
  if (priced.missing.length) {
    const codes = priced.missing.map((item) => item.code).join('、');
    throw badRequest('BILL_PRICE_MISSING',
      '这些运单在其创建时刻生效的规则版本里找不到分区价目，没法按当时版本出账：' + codes + '（请先在「规则」里核对版本与分区）');
  }
  const lines = list.map((waybill) => {
    const line = priced.lines.get(waybill.id);
    return {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      zoneId: line.zoneId,
      zoneName: line.zoneName,
      billableKg: line.billableKg,
      freightYuan: line.freightYuan,
      surchargeYuan: line.surchargeYuan,
      amountYuan: line.amountYuan,
      versionNo: line.versionNo,
      versionEffectiveAt: line.versionEffectiveAt,
      pricingSource: '按运单创建时刻生效版本 v' + line.versionNo + ' 计算并锁定',
    };
  });
  return {
    lines,
    amountYuan: sumLines(priced.lines),
    permille: priced.permille,
    versionNos: Array.from(new Set(lines.map((line) => line.versionNo))).sort((a, b) => a - b),
  };
}

// 账单重算对比：已锁定金额 / 按当时版本重算 / 按当前最新版本重算
function billRepricing(data, bill, waybills, customer) {
  const thenPicker = (waybill) => pricing.effectiveVersionAt(data, waybill.createdAt);
  const latestPicker = () => pricing.latestVersion(data);
  const thenPriced = priceWithVersions(data, customer, waybills, thenPicker);
  const nowPriced = priceWithVersions(data, customer, waybills, latestPicker);

  const storedByWaybill = new Map((bill.lines || []).map((line) => [line.waybillId, line]));
  const rows = waybills.map((waybill) => {
    const stored = storedByWaybill.get(waybill.id) || {};
    const thenLine = thenPriced.lines.get(waybill.id) || null;
    const nowLine = nowPriced.lines.get(waybill.id) || null;
    const billedYuan = Number(stored.amountYuan) || 0;
    const thenYuan = thenLine ? thenLine.amountYuan : null;
    const currentYuan = nowLine ? nowLine.amountYuan : null;
    const row = {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      createdAt: waybill.createdAt,
      billedVersionNo: stored.versionNo || null,
      thenVersionNo: thenLine ? thenLine.versionNo : null,
      currentVersionNo: nowLine ? nowLine.versionNo : null,
      billedZoneName: stored.zoneName || '',
      thenZoneName: thenLine ? thenLine.zoneName : '',
      currentZoneName: nowLine ? nowLine.zoneName : '',
      zoneChanged: Boolean(stored.zoneName && thenLine && stored.zoneName !== thenLine.zoneName),
      billedYuan,
      thenYuan,
      currentYuan,
      diffYuan: currentYuan === null ? null : pricing.roundFen(currentYuan - billedYuan),
      reasons: [],
      repriced: Boolean(thenLine && nowLine),
    };
    // 历史账单可能按旧的城市归属口径出账（不识别别名、回落首个分区），把归属变化讲清楚
    if (row.zoneChanged) {
      row.reasons.push('分区归属变化：账单按「' + stored.zoneName + '」出账，当前「' + waybill.toCity + '」归属为「' + thenLine.zoneName + '」');
    }
    if (thenLine && nowLine) {
      const thenQ = {
        billableKg: thenLine.billableKg,
        freightYuan: thenLine.freightYuan,
        surchargeYuan: thenLine.surchargeYuan,
        totalYuan: thenLine.amountYuan,
        zoneId: thenLine.zoneId,
      };
      const nowQ = {
        billableKg: nowLine.billableKg,
        freightYuan: nowLine.freightYuan,
        surchargeYuan: nowLine.surchargeYuan,
        totalYuan: nowLine.amountYuan,
        zoneId: nowLine.zoneId,
      };
      const thenSnap = pricing.findVersion(data, thenLine.versionNo).snapshot;
      const nowSnap = pricing.findVersion(data, nowLine.versionNo).snapshot;
      row.reasons = pricing.diffReasons(thenQ, nowQ, thenSnap, nowSnap);
    }
    return row;
  });

  const billedTotal = pricing.roundFen((bill.lines || []).reduce((sum, line) => sum + Number(line.amountYuan || 0), 0));
  const thenTotal = sumLines(thenPriced.lines);
  const nowTotal = sumLines(nowPriced.lines);
  const missingCount = thenPriced.missing.length + nowPriced.missing.length;
  return {
    billedTotal,
    billedLocked: bill.status === '已出账',
    thenTotal,
    thenVsBilledDiffYuan: pricing.roundFen(thenTotal - billedTotal),
    currentTotal: nowTotal,
    currentVsBilledDiffYuan: pricing.roundFen(nowTotal - billedTotal),
    currentVsThenDiffYuan: pricing.roundFen(nowTotal - thenTotal),
    affectedCount: rows.filter((row) => row.diffYuan !== null && row.diffYuan !== 0).length,
    missingCount,
    rows,
  };
}

function summarizeBill(bill, data) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  const repricing = billRepricing(data, bill, waybills, customer);
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    versionNos: bill.versionNos || Array.from(new Set(lines.map((line) => line.versionNo).filter(Boolean))).sort((a, b) => a - b),
    lines: lines.map((line) => Object.assign({}, line, {
      amountText: Number(line.amountYuan || 0).toFixed(2),
      billableText: Number(line.billableKg).toFixed(2) + ' kg',
    })),
    repricing,
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      quoteCacheYuan: waybill.quoteCacheYuan,
    })),
  });
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  let bills = data.bills.map((bill) => summarizeBill(bill, data));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  return {
    bills,
    total: bills.length,
    issued: bills.filter((bill) => bill.status === '已出账').length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

function getBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  return summarizeBill(bill, data);
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  const unzoned = targets.filter((waybill) => !zoneOf(data, waybill.toCity));
  if (unzoned.length) {
    throw badRequest('BILL_WAYBILL_UNZONED', '这些运单的收件城市还没有归属分区，不能出账：' + unzoned.map((w) => w.code).join('、'));
  }
  const priced = priceBill(data, customer, targets);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customerId).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId,
    status: '已出账',
    createdAt: new Date().toISOString(),
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
    versionNos: priced.versionNos,
    pricingMode: '按各运单创建时刻生效的规则版本试算，出账后锁定',
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  return summarizeBill(bill, load());
}

function voidBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  if (bill.status === '已作废') throw badRequest('BILL_ALREADY_VOID', '这张账单已经作废了');
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  save(data);
  return summarizeBill(bill, load());
}

function listPeriods() {
  const data = load();
  const periods = new Set();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (period) periods.add(period);
  });
  data.bills.forEach((bill) => periods.add(bill.period));
  return { periods: Array.from(periods).sort() };
}

module.exports = { listBills, getBill, generateBill, voidBill, listPeriods, periodOf, zoneOf, priceWithVersions };
