const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'db.json');

const DEFAULT_SETTINGS = {
  volumetricDivisor: 6000,
  minChargeYuan: 8,
  oversizeWeightKg: 30,
  oversizePieces: 3,
  oversizeFeeYuan: 20,
  insurancePermille: 20,
};

// 计费规则版本化的起点：历史数据（全局一份 settings + zones 的时期）
// 一律视作在这个时刻由 v1 版本覆盖，之后每次改动价格或参数生成新版本。
const BASELINE_VERSION_NO = 1;
const BASELINE_EFFECTIVE_AT = '2026-01-01T00:00:00+08:00';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyData() {
  return {
    meta: { name: '运单计费与账单核对台', currency: 'CNY', updatedAt: null },
    settings: clone(DEFAULT_SETTINGS),
    zones: [],
    customers: [],
    waybills: [],
    bills: [],
    pricingVersions: [],
  };
}

// 从 zones 里抽出会影响计费的分区价目（城市归属、名称等不影响金额，不进版本）
function zonePriceSnapshotOf(zones) {
  return (Array.isArray(zones) ? zones : []).map((zone) => ({
    zoneId: zone.id,
    code: zone.code,
    name: zone.name,
    firstWeightKg: Number(zone.firstWeightKg),
    firstPriceYuan: Number(zone.firstPriceYuan),
    addUnitKg: Number(zone.addUnitKg),
    addPriceYuan: Number(zone.addPriceYuan),
    remoteFeeYuan: Number(zone.remoteFeeYuan || 0),
  }));
}

function buildBaselineVersion(data) {
  return {
    versionNo: BASELINE_VERSION_NO,
    effectiveAt: BASELINE_EFFECTIVE_AT,
    reason: '初始版本（版本化之前的历史计费规则）',
    createdAt: BASELINE_EFFECTIVE_AT,
    snapshot: {
      settings: Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {}),
      zones: zonePriceSnapshotOf((data && data.zones) || []),
    },
    changes: [],
  };
}

function normalize(raw) {
  const base = emptyData();
  const data = raw && typeof raw === 'object' ? raw : {};
  const out = {
    meta: Object.assign({}, base.meta, data.meta || {}),
    settings: Object.assign({}, base.settings, data.settings || {}),
    zones: Array.isArray(data.zones) ? data.zones.filter((item) => item && item.id) : [],
    customers: Array.isArray(data.customers) ? data.customers.filter((item) => item && item.id) : [],
    waybills: Array.isArray(data.waybills) ? data.waybills.filter((item) => item && item.id) : [],
    bills: Array.isArray(data.bills) ? data.bills.filter((item) => item && item.id) : [],
    pricingVersions: Array.isArray(data.pricingVersions)
      ? data.pricingVersions.filter((item) => item && Number.isInteger(item.versionNo) && item.snapshot)
      : [],
  };
  out.zones.forEach((zone) => {
    if (!Array.isArray(zone.cities)) zone.cities = [];
    if (!zone.aliases || typeof zone.aliases !== 'object') zone.aliases = {};
  });
  out.waybills.forEach((waybill) => {
    if (!Array.isArray(waybill.services)) waybill.services = [];
  });
  out.bills.forEach((bill) => {
    if (!Array.isArray(bill.waybillIds)) bill.waybillIds = [];
  });

  // 老数据没有版本链：补一条 v1 基线版本，让所有历史运单都有版本可依
  if (out.pricingVersions.length === 0) {
    out.pricingVersions.push(buildBaselineVersion(out));
  } else {
    out.pricingVersions.sort((a, b) => a.versionNo - b.versionNo);
    const first = out.pricingVersions[0];
    if (!first.snapshot.settings) first.snapshot.settings = clone(DEFAULT_SETTINGS);
    if (!Array.isArray(first.snapshot.zones)) first.snapshot.zones = [];
  }
  return out;
}

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(dataFile)) {
    const seeded = normalize(null);
    save(seeded);
    return seeded;
  }
  const text = fs.readFileSync(dataFile, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 的内容是否完整');
  }
  return normalize(parsed);
}

function save(data) {
  ensureDir();
  const next = normalize(data);
  next.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(dataFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function nextId(prefix, list) {
  let max = 0;
  list.forEach((item) => {
    const match = String(item.id || '').match(/(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

module.exports = {
  load, save, normalize, nextId, dataFile,
  DEFAULT_SETTINGS, zonePriceSnapshotOf,
  BASELINE_VERSION_NO, BASELINE_EFFECTIVE_AT,
};
