// 计费口径（本项目现有实现）
// 1. 计费重量 = max(实际重量, 体积重量)，体积重量 = 体积(m³) × 1000000 ÷ 体积系数，结果向上取到 0.5kg
// 2. 首重以内收首重价，超出部分按续重单位向上进位，每个单位收续重价
// 3. 运费不低于最低收费
// 4. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超限或件数超限）+ 保价费（保价金额 × 费率）
// 5. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；费用以元为单位，保留两位
//
// 版本化说明：
// 价格与计费参数（全局参数 + 各分区首重/续重/偏远价）按版本保存。
// 每个版本带生效时刻；运单按「创建时刻」取当时生效的版本试算，账单按出账运单所属时刻的版本锁定。
const DEFAULT_SETTINGS = {
  volumetricDivisor: 6000,
  minChargeYuan: 8,
  oversizeWeightKg: 30,
  oversizePieces: 3,
  oversizeFeeYuan: 20,
  insurancePermille: 20,
};

const SETTING_FIELDS = [
  'volumetricDivisor', 'minChargeYuan', 'oversizeWeightKg',
  'oversizePieces', 'oversizeFeeYuan', 'insurancePermille',
];
const SETTING_LABELS = {
  volumetricDivisor: '体积系数',
  minChargeYuan: '最低收费（元）',
  oversizeWeightKg: '超规重量线（kg）',
  oversizePieces: '超规件数线（件）',
  oversizeFeeYuan: '超规附加（元）',
  insurancePermille: '保价费率（千分比）',
};
const ZONE_PRICE_FIELDS = ['firstWeightKg', 'firstPriceYuan', 'addUnitKg', 'addPriceYuan', 'remoteFeeYuan'];
const ZONE_PRICE_LABELS = {
  firstWeightKg: '首重（kg）',
  firstPriceYuan: '首重价（元）',
  addUnitKg: '续重单位（kg）',
  addPriceYuan: '续重价（元）',
  remoteFeeYuan: '偏远附加（元）',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function settingsOf(data) {
  return Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
}

function roundFen(yuan) {
  return Math.round(Number(yuan) * 100) / 100;
}

function roundUpToUnit(value, unit) {
  if (!(unit > 0)) return Number(value);
  return Math.ceil(Number(value) / unit) * unit;
}

function volumeWeightKg(volumeM3, divisor) {
  const volume = Number(volumeM3) || 0;
  const base = Number(divisor) > 0 ? Number(divisor) : DEFAULT_SETTINGS.volumetricDivisor;
  return (volume * 1000000) / base;
}

function billableWeightKg(waybill, settings) {
  const actual = Number(waybill.weightKg) || 0;
  const volume = volumeWeightKg(waybill.volumeM3, settings.volumetricDivisor);
  return roundUpToUnit(Math.max(actual, volume), 0.5);
}

function freightYuan(zonePrice, billableKg, settings) {
  const firstWeightKg = Number(zonePrice.firstWeightKg) || 1;
  const firstPriceYuan = Number(zonePrice.firstPriceYuan) || 0;
  const addUnitKg = Number(zonePrice.addUnitKg) || 0.5;
  const addPriceYuan = Number(zonePrice.addPriceYuan) || 0;
  const over = Math.max(0, Number(billableKg) - firstWeightKg);
  const units = Math.ceil(over / addUnitKg);
  const raw = firstPriceYuan + units * addPriceYuan;
  const floor = Number(settings.minChargeYuan) || 0;
  return raw < floor ? floor : raw;
}

function surchargeYuan(zonePrice, waybill, billableKg, settings) {
  let fee = Number(zonePrice.remoteFeeYuan) || 0;
  const oversizeWeight = Number(billableKg) > Number(settings.oversizeWeightKg);
  const oversizePieces = Number(waybill.pieces || 1) >= Number(settings.oversizePieces);
  if (oversizeWeight || oversizePieces) fee += Number(settings.oversizeFeeYuan) || 0;
  const insured = Number(waybill.insuredAmountYuan) || 0;
  const services = Array.isArray(waybill.services) ? waybill.services : [];
  if (services.includes('保价') && insured > 0) {
    fee += insured * (Number(settings.insurancePermille) || 0) / 1000;
  }
  return fee;
}

function discountPermilleOf(customer) {
  if (!customer) return 1000;
  if (customer.settle !== '月结') return 1000;
  const value = Number(customer.discountPermille);
  return Number.isFinite(value) && value > 0 ? value : 1000;
}

/* ================= 版本与快照 ================= */

function versionsOf(data) {
  return Array.isArray(data && data.pricingVersions) ? data.pricingVersions : [];
}

function latestVersion(data) {
  const list = versionsOf(data);
  return list.length ? list[list.length - 1] : null;
}

function snapshotOf(data) {
  const latest = latestVersion(data);
  if (latest && latest.snapshot) {
    return { settings: Object.assign({}, DEFAULT_SETTINGS, latest.snapshot.settings || {}), zones: clone(latest.snapshot.zones || []) };
  }
  return { settings: settingsOf(data), zones: [] };
}

// 某一时刻正在用的版本：effectiveAt <= at 的最后一版；早于首版生效时刻时回落首版
function effectiveVersionAt(data, atIso) {
  const list = versionsOf(data);
  if (list.length === 0) return null;
  const at = String(atIso || '');
  let picked = list[0];
  for (const version of list) {
    if (at && String(version.effectiveAt) <= at) picked = version;
    else break;
  }
  return picked;
}

function effectiveSnapshotAt(data, atIso) {
  const version = effectiveVersionAt(data, atIso);
  if (!version) return { settings: settingsOf(data), zones: [] };
  return { settings: Object.assign({}, DEFAULT_SETTINGS, version.snapshot.settings || {}), zones: clone(version.snapshot.zones || []) };
}

function findVersion(data, versionNo) {
  const no = Number(versionNo);
  return versionsOf(data).find((version) => version.versionNo === no) || null;
}

function snapshotOfVersion(data, versionNo) {
  const version = findVersion(data, versionNo);
  if (!version) return null;
  return { settings: Object.assign({}, DEFAULT_SETTINGS, version.snapshot.settings || {}), zones: clone(version.snapshot.zones || []) };
}

// 在版本快照里找分区价目：先按分区 id，找不到再按编码兜底（分区删掉重建的情形）
function zonePriceInSnapshot(snapshot, zone) {
  if (!zone || !snapshot) return null;
  const zones = Array.isArray(snapshot.zones) ? snapshot.zones : [];
  return zones.find((item) => item.zoneId === zone.id)
    || zones.find((item) => zone.code && item.code === zone.code)
    || null;
}

/* ================= 版本差异 ================= */

function valuesEqual(a, b) {
  return Number(a) === Number(b);
}

// target 相对 base 的差异项
function diffSnapshots(base, target) {
  const diffs = [];
  const bSettings = (base && base.settings) || {};
  const tSettings = (target && target.settings) || {};
  SETTING_FIELDS.forEach((key) => {
    const before = Number(bSettings[key]);
    const after = Number(tSettings[key]);
    if (!valuesEqual(before, after)) {
      diffs.push({ kind: 'setting', key, label: SETTING_LABELS[key], before, after });
    }
  });

  const bZones = (base && base.zones) || [];
  const tZones = (target && target.zones) || [];
  const bMap = new Map();
  bZones.forEach((zone) => bMap.set(zone.zoneId, zone));
  const tMap = new Map();
  tZones.forEach((zone) => tMap.set(zone.zoneId, zone));

  tZones.forEach((tZone) => {
    const bZone = bMap.get(tZone.zoneId);
    if (!bZone) {
      diffs.push({ kind: 'zone-added', zoneId: tZone.zoneId, zoneCode: tZone.code, zoneName: tZone.name });
      return;
    }
    ZONE_PRICE_FIELDS.forEach((key) => {
      if (!valuesEqual(bZone[key], tZone[key])) {
        diffs.push({
          kind: 'zone', key, label: ZONE_PRICE_LABELS[key],
          zoneId: tZone.zoneId, zoneCode: tZone.code, zoneName: tZone.name,
          before: Number(bZone[key]), after: Number(tZone[key]),
        });
      }
    });
  });
  bZones.forEach((bZone) => {
    if (!tMap.has(bZone.zoneId)) {
      diffs.push({ kind: 'zone-removed', zoneId: bZone.zoneId, zoneCode: bZone.code, zoneName: bZone.name });
    }
  });
  return diffs;
}

/* ================= 按版本试算 ================= */

// 单条运单在指定快照下的计费；zone 为当前城市归属到的分区，价目从快照取
function quoteWithSnapshot(waybill, zone, customer, snapshot) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, (snapshot && snapshot.settings) || {});
  const zonePrice = zonePriceInSnapshot(snapshot, zone);
  const billableKg = billableWeightKg(waybill, settings);
  if (!zonePrice) {
    return {
      waybillId: waybill.id,
      zoneId: zone ? zone.id : null,
      zoneName: zone ? zone.name : '',
      priceMissing: true,
      billableKg,
      freightYuan: null,
      surchargeYuan: null,
      grossYuan: null,
      discountPermille: discountPermilleOf(customer),
      totalYuan: null,
    };
  }
  const freight = freightYuan(zonePrice, billableKg, settings);
  const surcharge = surchargeYuan(zonePrice, waybill, billableKg, settings);
  const permille = discountPermilleOf(customer);
  const gross = freight + surcharge;
  const total = roundFen(gross * permille / 1000);
  return {
    waybillId: waybill.id,
    zoneId: zone ? zone.id : null,
    zoneName: zonePrice.name || (zone ? zone.name : ''),
    priceMissing: false,
    billableKg,
    freightYuan: roundFen(freight),
    surchargeYuan: roundFen(surcharge),
    grossYuan: roundFen(gross),
    discountPermille: permille,
    totalYuan: total,
  };
}

// 单条运单按其创建时刻生效的版本计费（传入整份 data）
function quoteWaybill(waybill, zone, customer, data) {
  const snapshot = data && Array.isArray(data.pricingVersions)
    ? effectiveSnapshotAt(data, waybill.createdAt)
    : data; // 也接受直接传快照 { settings, zones }
  return quoteWithSnapshot(waybill, zone, customer, snapshot);
}

// 逐单差额原因：把两版计费结果的分量差异讲清楚
function diffReasons(before, after, snapshotBefore, snapshotAfter) {
  const reasons = [];
  if (!before || before.priceMissing || !after || after.priceMissing) return reasons;
  const sb = (snapshotBefore && snapshotBefore.settings) || {};
  const sa = (snapshotAfter && snapshotAfter.settings) || {};
  if (Number(before.billableKg) !== Number(after.billableKg)) {
    let why = '计费重量 ' + before.billableKg + ' → ' + after.billableKg + ' kg';
    if (Number(sb.volumetricDivisor) !== Number(sa.volumetricDivisor)) {
      why += '（体积系数 ' + sb.volumetricDivisor + ' → ' + sa.volumetricDivisor + '）';
    }
    reasons.push(why);
  }
  if (Number(before.freightYuan) !== Number(after.freightYuan)) {
    reasons.push('运费 ' + before.freightYuan + ' → ' + after.freightYuan + ' 元');
  }
  if (Number(before.surchargeYuan) !== Number(after.surchargeYuan)) {
    let why = '附加费 ' + before.surchargeYuan + ' → ' + after.surchargeYuan + ' 元';
    const details = [];
    if (Number(sb.oversizeFeeYuan) !== Number(sa.oversizeFeeYuan)) {
      details.push('超规附加 ' + sb.oversizeFeeYuan + ' → ' + sa.oversizeFeeYuan);
    }
    if (Number(sb.insurancePermille) !== Number(sa.insurancePermille)) {
      details.push('保价费率 ' + sb.insurancePermille + '‰ → ' + sa.insurancePermille + '‰');
    }
    const zb = before.zoneId && (snapshotBefore.zones || []).find((z) => z.zoneId === before.zoneId);
    const za = after.zoneId && (snapshotAfter.zones || []).find((z) => z.zoneId === after.zoneId);
    if (zb && za && Number(zb.remoteFeeYuan) !== Number(za.remoteFeeYuan)) {
      details.push('偏远附加 ' + zb.remoteFeeYuan + ' → ' + za.remoteFeeYuan);
    }
    if (details.length) why += '（' + details.join('，') + '）';
    reasons.push(why);
  }
  return reasons;
}

// 用两个版本分别试算同一批运单，逐单给出金额、差额与原因，并汇总差额合计
function compareWaybillsByVersions(data, waybills, zoneResolver, customerResolver, versionA, versionB) {
  const snapA = { settings: Object.assign({}, DEFAULT_SETTINGS, versionA.snapshot.settings || {}), zones: clone(versionA.snapshot.zones || []) };
  const snapB = { settings: Object.assign({}, DEFAULT_SETTINGS, versionB.snapshot.settings || {}), zones: clone(versionB.snapshot.zones || []) };
  const lines = waybills.map((waybill) => {
    const zone = zoneResolver(waybill);
    const customer = customerResolver(waybill);
    const a = quoteWithSnapshot(waybill, zone, customer, snapA);
    const b = quoteWithSnapshot(waybill, zone, customer, snapB);
    const missing = a.priceMissing || b.priceMissing;
    return {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      createdAt: waybill.createdAt,
      zoneId: zone ? zone.id : null,
      zoneName: zone ? zone.name : '未归属',
      zoneKnown: Boolean(zone),
      billableKgA: a.billableKg,
      billableKgB: b.billableKg,
      totalA: missing ? null : a.totalYuan,
      totalB: missing ? null : b.totalYuan,
      freightA: a.priceMissing ? null : a.freightYuan,
      freightB: b.priceMissing ? null : b.freightYuan,
      surchargeA: a.priceMissing ? null : a.surchargeYuan,
      surchargeB: b.priceMissing ? null : b.surchargeYuan,
      diffYuan: missing ? null : roundFen(b.totalYuan - a.totalYuan),
      reasons: missing ? [] : diffReasons(a, b, snapA, snapB),
      priceMissing: missing,
    };
  });
  const usable = lines.filter((line) => !line.priceMissing);
  const totalA = roundFen(usable.reduce((sum, line) => sum + Number(line.totalA || 0), 0));
  const totalB = roundFen(usable.reduce((sum, line) => sum + Number(line.totalB || 0), 0));
  return {
    versionA: { versionNo: versionA.versionNo, effectiveAt: versionA.effectiveAt },
    versionB: { versionNo: versionB.versionNo, effectiveAt: versionB.effectiveAt },
    totalA,
    totalB,
    diffYuan: roundFen(totalB - totalA),
    affectedCount: lines.filter((line) => line.diffYuan !== null && line.diffYuan !== 0).length,
    missingCount: lines.length - usable.length,
    lines,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTING_FIELDS, SETTING_LABELS, ZONE_PRICE_FIELDS, ZONE_PRICE_LABELS,
  settingsOf,
  roundFen,
  roundUpToUnit,
  volumeWeightKg,
  billableWeightKg,
  freightYuan,
  surchargeYuan,
  discountPermilleOf,
  versionsOf,
  latestVersion,
  snapshotOf,
  effectiveVersionAt,
  effectiveSnapshotAt,
  findVersion,
  snapshotOfVersion,
  zonePriceInSnapshot,
  diffSnapshots,
  quoteWithSnapshot,
  quoteWaybill,
  diffReasons,
  compareWaybillsByVersions,
};
